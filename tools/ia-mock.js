// IA falsa para testar o backend e o front sem o modelo real (resultados inventados).
// Uso: npm run ia-mock   e no .env do backend: IA_SERVICE_URL=http://localhost:8090
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const express = require('express');

const PORTA = Number(process.env.IA_MOCK_PORT) || 8090;
const ATRASO_MS = (Number(process.env.IA_MOCK_ATRASO_S) || 3) * 1000;
const CHANCE_FALHA = Number(process.env.IA_MOCK_FALHA) || 0;
const IA_TOKEN = process.env.IA_TOKEN || '';
const IA_CALLBACK_TOKEN = process.env.IA_CALLBACK_TOKEN || '';
const VERSAO_MODELO = 'mock-ia-0.2 (resultado FALSO, sem modelo real)';

// Mesmos limiares calibrados do modelo real.
const LIMIAR_ANOMALIA = 62.76;
const LIMIAR_ALERTA_ALTO = 94.24;

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  if (IA_TOKEN && req.get('authorization') !== `Bearer ${IA_TOKEN}`) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }
  next();
});

const arredondar = (valor) => Math.round(valor * 100) / 100;
const sortear = (min, max) => min + Math.random() * (max - min);

function nivelDo(score) {
  if (score >= LIMIAR_ALERTA_ALTO) return 'critico';
  if (score >= LIMIAR_ANOMALIA) return 'alerta';
  return 'normal';
}

function veredictoDo(score) {
  if (score >= LIMIAR_ALERTA_ALTO) return 'Alerta Alto';
  if (score >= LIMIAR_ANOMALIA) return 'Anomalia';
  return 'Normal';
}

async function baixarVideo(url, hashEsperado) {
  const resposta = await fetch(url);
  if (!resposta.ok) throw Object.assign(new Error(`download do vídeo falhou: HTTP ${resposta.status}`), { status: 502 });
  const video = Buffer.from(await resposta.arrayBuffer());
  const hash = crypto.createHash('sha256').update(video).digest('hex');
  if (hashEsperado && hash !== hashEsperado) {
    throw Object.assign(new Error(`hash do vídeo baixado não confere (${hash})`), { status: 409 });
  }
  return hash;
}

// Uma entrada por segundo com score baixo e, se não for "Normal", alguns segundos seguidos altos.
function inventarAnalise(duracaoSegundos) {
  const segundos = Math.max(1, Math.ceil(duracaoSegundos || 10));
  const score = arredondar(sortear(0, 100));
  const veredicto = veredictoDo(score);

  const trecho = { inicio: 0, fim: -1 };
  if (veredicto !== 'Normal') {
    const tamanho = Math.min(segundos, 3);
    trecho.inicio = Math.floor(sortear(0, segundos - tamanho + 1));
    trecho.fim = trecho.inicio + tamanho - 1;
  }

  const linhaDoTempo = Array.from({ length: segundos }, (_, segundo) => {
    const dentroDoTrecho = segundo >= trecho.inicio && segundo <= trecho.fim;
    const scoreSegundo = arredondar(dentroDoTrecho ? sortear(score - 5, Math.min(score + 5, 100)) : sortear(3, 30));
    return {
      inicio_s: segundo,
      fim_s: Math.min(segundo + 1, duracaoSegundos || segundos),
      score: Math.max(0, scoreSegundo),
      score_frame: arredondar(Math.min(100, scoreSegundo + sortear(0, 5))),
      pico_s: arredondar(segundo + sortear(0, 0.99)),
      nivel: nivelDo(scoreSegundo),
    };
  });

  const segmentos = veredicto === 'Normal' ? [] : [{
    inicio_s: trecho.inicio,
    fim_s: trecho.fim + 1,
    score,
    pico_s: linhaDoTempo[trecho.inicio].pico_s,
  }];

  return { score, veredicto, segmentos_criticos: segmentos, linha_do_tempo: linhaDoTempo };
}

app.post('/analisar', (req, res) => {
  const { id_gravacao: idGravacao, video_url: videoUrl, callback_url: callbackUrl } = req.body || {};
  if (!idGravacao || !videoUrl || !callbackUrl) {
    return res.status(400).json({ erro: 'id_gravacao, video_url e callback_url são obrigatórios.' });
  }
  console.log(`[IA mock] Recebida gravação ${idGravacao} (tentativa ${req.body.tentativa}).`);
  res.status(202).json({ aceito: true });
  setTimeout(() => analisar(req.body), ATRASO_MS);
});

async function analisar(pedido) {
  const inicio = Date.now();
  let resultado;
  try {
    const hash = await baixarVideo(pedido.video_url, pedido.hash_sha256);
    if (Math.random() < CHANCE_FALHA) throw new Error('falha simulada (IA_MOCK_FALHA)');
    resultado = {
      status: 'concluido',
      ...inventarAnalise(pedido.duracao_segundos),
      versao_modelo: VERSAO_MODELO,
      tempo_processamento_ms: Date.now() - inicio + ATRASO_MS,
      hash_sha256_verificado: hash,
    };
  } catch (erro) {
    resultado = { status: 'erro', erro: erro.message };
  }

  try {
    const resposta = await fetch(pedido.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${IA_CALLBACK_TOKEN}` },
      body: JSON.stringify(resultado),
    });
    const resumo = resultado.veredicto ? `${resultado.veredicto}, ${resultado.score}` : resultado.erro;
    console.log(`[IA mock] Gravação ${pedido.id_gravacao}: ${resultado.status} (${resumo}) -> backend respondeu ${resposta.status}`);
  } catch (erro) {
    console.error(`[IA mock] Não consegui chamar o callback: ${erro.message}`);
  }
}

// JSON com as chaves em ordem, para o código de verificação não depender da ordem dos campos.
function jsonCanonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map((chave) => `${JSON.stringify(chave)}:${jsonCanonico(valor[chave])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

// PDF mínimo de uma página com algumas linhas de texto.
function pdfSimples(linhas) {
  const texto = linhas
    .map((linha, i) => `BT /F1 12 Tf 50 ${780 - i * 20} Td (${linha.replace(/[()\\]/g, '\\$&')}) Tj ET`)
    .join('\n');
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(texto, 'latin1')} >>\nstream\n${texto}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const posicoes = objetos.map((objeto, i) => {
    const posicao = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${objeto}\nendobj\n`;
    return posicao;
  });
  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  pdf += posicoes.map((posicao) => `${String(posicao).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

app.post('/laudo', async (req, res) => {
  const { resultado, metadados = {}, video_url: videoUrl } = req.body || {};
  if (!resultado) return res.status(400).json({ erro: '"resultado" é obrigatório.' });

  try {
    if (videoUrl) await baixarVideo(videoUrl, metadados.hash_sha256);
  } catch (erro) {
    return res.status(erro.status || 502).json({ erro: erro.message });
  }

  const codigoVerificacao = crypto.createHash('sha256').update(jsonCanonico(resultado)).digest('hex');
  const pdf = pdfSimples([
    'LAUDO DE TESTE - IA FALSA (sem valor como evidencia)',
    `Gravacao: ${metadados.id_gravacao} | Arquivo: ${metadados.arquivo}`,
    `Data: ${metadados.data_gravacao} | Dispositivo: ${metadados.dispositivo}`,
    `Veredicto: ${resultado.veredicto} | Indice: ${resultado.score}`,
    `SHA-256 do video: ${metadados.hash_sha256}`,
    `Codigo de verificacao: ${codigoVerificacao}`,
  ]);
  console.log(`[IA mock] Laudo PDF da gravação ${metadados.id_gravacao} gerado.`);
  res.set('Content-Type', 'application/pdf');
  res.set('X-Codigo-Verificacao', codigoVerificacao);
  res.send(pdf);
});

app.listen(PORTA, () => {
  console.log(`[IA mock] Rodando em http://localhost:${PORTA} — resultados FALSOS, só pra teste.`);
});
