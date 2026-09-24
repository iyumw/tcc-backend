


















const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const express = require('express');

const PORTA = Number(process.env.IA_MOCK_PORT) || 8090;
const ATRASO_MS = (Number(process.env.IA_MOCK_ATRASO_S) || 3) * 1000;
const CHANCE_FALHA = Number(process.env.IA_MOCK_FALHA) || 0;
const IA_TOKEN = process.env.IA_TOKEN || '';
const IA_CALLBACK_TOKEN = process.env.IA_CALLBACK_TOKEN || '';
const VERSAO_MODELO = 'mock-ia-0.1 (resultado FALSO, sem modelo real)';

const app = express();
app.use(express.json());

app.post('/analisar', (req, res) => {
  if (IA_TOKEN && req.get('authorization') !== `Bearer ${IA_TOKEN}`) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }

  const { id_gravacao, video_url, callback_url } = req.body || {};
  if (!id_gravacao || !video_url || !callback_url) {
    return res.status(400).json({ erro: 'id_gravacao, video_url e callback_url são obrigatórios.' });
  }

  console.log(`[IA mock] Recebida gravação ${id_gravacao} (tentativa ${req.body.tentativa}).`);
  res.status(202).json({ aceito: true });


  setTimeout(() => processar(req.body), ATRASO_MS);
});

async function processar(pedido) {
  const inicio = Date.now();
  let resultado;

  try {

    const resposta = await fetch(pedido.video_url);
    if (!resposta.ok) throw new Error(`download do vídeo falhou: HTTP ${resposta.status}`);
    const video = Buffer.from(await resposta.arrayBuffer());


    const hash = crypto.createHash('sha256').update(video).digest('hex');
    if (hash !== pedido.hash_sha256) {
      throw new Error(`hash do vídeo baixado não confere (${hash})`);
    }

    if (Math.random() < CHANCE_FALHA) {
      throw new Error('falha simulada (IA_MOCK_FALHA)');
    }


    const duracao = pedido.duracao_segundos || 10;
    const score = Math.round(Math.random() * 10000) / 100;
    const veredicto = score >= 70 ? 'Alerta Alto' : score >= 40 ? 'Anomalia' : 'Normal';
    const segmentos = [];
    if (veredicto !== 'Normal') {
      const inicioSeg = Math.round(Math.random() * Math.max(duracao - 2, 0) * 10) / 10;
      segmentos.push({ inicio_s: inicioSeg, fim_s: Math.min(inicioSeg + 2, duracao), score });
    }

    resultado = {
      status: 'concluido',
      score,
      veredicto,
      segmentos_criticos: segmentos,
      versao_modelo: VERSAO_MODELO,
      tempo_processamento_ms: Date.now() - inicio + ATRASO_MS,
      hash_sha256_verificado: hash,
    };
  } catch (erro) {
    resultado = { status: 'erro', erro: erro.message };
  }


  try {
    const r = await fetch(pedido.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${IA_CALLBACK_TOKEN}` },
      body: JSON.stringify(resultado),
    });
    console.log(
      `[IA mock] Gravação ${pedido.id_gravacao}: ${resultado.status}` +
        (resultado.veredicto ? ` (${resultado.veredicto}, ${resultado.score})` : ` (${resultado.erro})`) +
        ` -> backend respondeu ${r.status}`
    );
  } catch (erro) {
    console.error(`[IA mock] Não consegui chamar o callback: ${erro.message}`);
  }
}

app.listen(PORTA, () => {
  console.log(`[IA mock] Rodando em http://localhost:${PORTA} — resultados FALSOS, só pra teste.`);
});
