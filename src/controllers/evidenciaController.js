const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const db = require('../config/db');
const storage = require('../services/storageService');
const pipelineIA = require('../services/pipelineIAService');
const laudos = require('../services/laudoService');
const carimbo = require('../services/carimboTempoService');
const eventos = require('../services/eventosService');
const auditoria = require('../services/auditoriaService');
const authService = require('../services/authService');
const evidencias = require('../services/evidenciaService');
const { calcularHashDeStream } = require('../services/custodiaService');
const { lerIdPositivo, numeroOuNulo } = require('../utils/validacao');
const { envolverControladores } = require('../utils/comTratamentoDeErros');

const INTERVALO_BATIMENTO_SSE_MS = 25000;
const MAX_CONEXOES_SSE_POR_USUARIA = 5;
const LIMITE_PADRAO_LISTAGEM = 200;
const LIMITE_MAXIMO_LISTAGEM = 500;

// Conexões SSE abertas por usuária (para o limite) e no total (para o desligamento).
const conexoesSsePorUsuaria = new Map();
const conexoesSse = new Set();

async function gravacaoDaUsuaria(req, res, acao) {
  const id = lerIdPositivo(req.params.id);
  if (id === null) {
    res.status(400).json({ erro: 'id inválido.' });
    return null;
  }
  const { gravacao, status } = await evidencias.buscarDaUsuaria(id, req.usuario.idVitima);
  if (status === 404) {
    res.status(404).json({ erro: 'Evidência não encontrada.' });
    return null;
  }
  if (status === 403) {
    await auditoria.registrarObrigatorio('acesso_negado', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: id, acao },
      req,
    });
    res.status(403).json({ erro: 'Você não tem acesso a esta evidência.' });
    return null;
  }
  return gravacao;
}

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function lerPaginacao(query) {
  const limite = lerIdPositivo(query.limite) || LIMITE_PADRAO_LISTAGEM;
  const deslocamento = Math.max(Number.parseInt(query.deslocamento, 10) || 0, 0);
  return { limite: Math.min(limite, LIMITE_MAXIMO_LISTAGEM), deslocamento };
}

async function listar(req, res) {
  const { limite, deslocamento } = lerPaginacao(req.query);
  const { rows } = await db.query(
    `SELECT g.id_gravacao, a.data_hora AS gravada_em, a.id_device AS dispositivo,
            g.duracao_segundos, g.status_analise, g.processo_judicial,
            ia.veredicto, ia.score, COUNT(*) OVER () AS total
       FROM gravacao g
       JOIN acionamento a ON a.id_acionamento = g.id_acionamento
       LEFT JOIN analise_ia ia ON ia.id_gravacao = g.id_gravacao
      WHERE a.id_vitima = $1
      ORDER BY a.data_hora DESC
      LIMIT $2 OFFSET $3`,
    [req.usuario.idVitima, limite, deslocamento]
  );
  res.set('X-Total-Count', String(rows.length ? rows[0].total : 0));
  return res.json(
    rows.map((linha) => ({
      id_gravacao: linha.id_gravacao,
      gravada_em: linha.gravada_em,
      dispositivo: linha.dispositivo,
      duracao_segundos: numeroOuNulo(linha.duracao_segundos),
      status_analise: linha.status_analise,
      veredicto: linha.veredicto,
      score: numeroOuNulo(linha.score),
      vinculada_a_processo: Boolean(linha.processo_judicial),
    }))
  );
}

async function detalhar(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'detalhe');
  if (!gravacao) return;
  const analise = await laudos.consultarAnalise(gravacao.id_gravacao);
  return res.json({
    id_gravacao: gravacao.id_gravacao,
    gravada_em: gravacao.data_hora,
    dispositivo: gravacao.id_device,
    duracao_segundos: numeroOuNulo(gravacao.duracao_segundos),
    hash_sha256: gravacao.hash_seguranca.trim(),
    carimbo_tempo: carimbo.descreverCarimbo(gravacao),
    processo_judicial: gravacao.processo_judicial,
    status_analise: analise.status_analise,
    tentativas_analise: analise.tentativas,
    ultimo_erro_analise: analise.ultimo_erro,
    laudo: analise.laudo,
  });
}

async function gerarUrl(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'url_video');
  if (!gravacao) return;
  await auditoria.registrarObrigatorio('acesso_video', {
    idVitima: req.usuario.idVitima,
    detalhes: { id_gravacao: gravacao.id_gravacao },
    req,
  });
  const acesso = await storage.gerarUrlAssinada(gravacao.id_gravacao, gravacao.url_storage, baseUrl(req));
  return res.json({ id_gravacao: gravacao.id_gravacao, ...acesso, validade_minutos: storage.VALIDADE_URL_MIN });
}

async function verificarIntegridade(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'integridade');
  if (!gravacao) return;

  if (!(await storage.existe(gravacao.url_storage))) {
    return res.status(404).json({ integro: false, erro: 'Arquivo da gravação não encontrado no armazenamento.' });
  }

  const inicio = process.hrtime.bigint();
  const hashCalculado = await calcularHashDeStream(storage.abrirLeitura(gravacao.url_storage));
  const tempoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
  const hashEsperado = gravacao.hash_seguranca.trim();
  const integro = hashCalculado === hashEsperado;

  await auditoria.registrarObrigatorio('verificacao_integridade', {
    idVitima: req.usuario.idVitima,
    detalhes: { id_gravacao: gravacao.id_gravacao, integro },
    req,
  });

  const resultado = {
    id_gravacao: gravacao.id_gravacao,
    integro,
    hash_esperado: hashEsperado,
    hash_calculado: hashCalculado,
    verificado_em: new Date().toISOString(),
    tempo_verificacao_ms: Math.round(tempoMs * 100) / 100,
    carimbo_tempo: {
      ...carimbo.descreverCarimbo(gravacao),
      confere_com_hash: gravacao.carimbo_tempo ? carimbo.carimboConfere(gravacao.carimbo_tempo, hashEsperado) : null,
    },
  };
  if (integro) return res.json(resultado);

  console.warn(
    `[Custodia] FALHA DE INTEGRIDADE na gravacao ${gravacao.id_gravacao}: ` +
      `esperado ${hashEsperado}, calculado ${hashCalculado}`
  );
  return res.status(409).json({ ...resultado, erro: 'O hash do arquivo não confere com o registrado: o arquivo foi alterado.' });
}

// O X-Laudo-SHA256 permite provar depois que o arquivo do laudo não foi editado:
// o conteúdo só depende da análise guardada, então o hash é o mesmo a cada download.
async function baixarLaudo(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'download_laudo');
  if (!gravacao) return;
  const { laudo, status_analise: statusAnalise } = await laudos.consultarAnalise(gravacao.id_gravacao);
  if (!laudo) return res.status(409).json({ erro: `O laudo ainda não está pronto (status: ${statusAnalise}).` });

  const conteudo = JSON.stringify(
    {
      laudo,
      integridade: {
        algoritmo: 'SHA-256',
        hash_video_original: gravacao.hash_seguranca.trim(),
        gerado_em: laudo.timestamp_emissao,
      },
    },
    null,
    2
  );

  await auditoria.registrarObrigatorio('download_laudo', {
    idVitima: req.usuario.idVitima,
    detalhes: { id_gravacao: gravacao.id_gravacao },
    req,
  });
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${laudo.id_laudo}.json"`);
  res.set('X-Laudo-SHA256', crypto.createHash('sha256').update(conteudo).digest('hex'));
  return res.send(conteudo);
}

async function baixarLaudoPdf(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'download_laudo_pdf');
  if (!gravacao) return;
  const { pdf, codigoVerificacao } = await laudos.gerarLaudoPdf(gravacao);

  await auditoria.registrarObrigatorio('download_laudo_pdf', {
    idVitima: req.usuario.idVitima,
    detalhes: { id_gravacao: gravacao.id_gravacao, codigo_verificacao: codigoVerificacao },
    req,
  });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="laudo_gravacao_${gravacao.id_gravacao}.pdf"`);
  if (codigoVerificacao) res.set('X-Codigo-Verificacao', codigoVerificacao);
  return res.send(pdf);
}

// O arquivo .tsr é a resposta da autoridade de carimbo de tempo (RFC 3161), em DER:
// verificável com "openssl ts -verify" (docs/carimbo-tempo.md).
async function baixarCarimbo(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'download_carimbo');
  if (!gravacao) return;
  if (!gravacao.carimbo_tempo) {
    return res.status(409).json({ erro: 'O carimbo de tempo ainda não foi emitido.', carimbo_tempo: carimbo.descreverCarimbo(gravacao) });
  }

  await auditoria.registrarObrigatorio('download_carimbo', {
    idVitima: req.usuario.idVitima,
    detalhes: { id_gravacao: gravacao.id_gravacao },
    req,
  });
  res.set('Content-Type', 'application/timestamp-reply');
  res.set('Content-Disposition', `attachment; filename="carimbo_gravacao_${gravacao.id_gravacao}.tsr"`);
  return res.send(gravacao.carimbo_tempo);
}

async function reprocessar(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'reprocessar');
  if (!gravacao) return;
  if (!pipelineIA.iaConfigurada()) return res.status(503).json({ erro: 'Serviço de IA não configurado.' });

  const { enviado, motivo } = await pipelineIA.solicitarAnalise(gravacao.id_gravacao);
  if (!enviado) return res.status(409).json({ erro: motivo });
  return res.status(202).json({ id_gravacao: gravacao.id_gravacao, status_analise: 'Processando' });
}

// A confirmação pode vir no corpo ({ "confirmacao": true }) ou na URL (?confirmacao=true):
// alguns clientes e proxies descartam o corpo de um DELETE.
function exclusaoConfirmada(req) {
  return (req.body && req.body.confirmacao === true) || req.query.confirmacao === 'true';
}

async function excluir(req, res) {
  const gravacao = await gravacaoDaUsuaria(req, res, 'exclusao');
  if (!gravacao) return;
  if (!exclusaoConfirmada(req)) {
    return res.status(400).json({
      erro: 'Confirme a exclusão enviando { "confirmacao": true } ou ?confirmacao=true.',
      codigo: 'CONFIRMACAO_OBRIGATORIA',
    });
  }
  if (gravacao.processo_judicial) {
    return res.status(409).json({
      erro: 'Esta evidência está vinculada a um processo judicial ativo e não pode ser excluída.',
      codigo: 'VINCULO_JUDICIAL',
    });
  }

  await db.emTransacao(async (cliente) => {
    await auditoria.registrarObrigatorio('exclusao_evidencia', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: gravacao.id_gravacao, hash: gravacao.hash_seguranca.trim() },
      req,
      cliente,
    });
    await cliente.query('DELETE FROM acionamento WHERE id_acionamento = $1', [gravacao.id_acionamento]);
  });
  await evidencias.apagarArquivosERegistrarFalhas([gravacao.url_storage], { idVitima: req.usuario.idVitima, req });
  return res.status(204).end();
}

function registrarConexaoSse(idVitima, res) {
  const abertas = conexoesSsePorUsuaria.get(idVitima) || 0;
  if (abertas >= MAX_CONEXOES_SSE_POR_USUARIA) return false;
  conexoesSsePorUsuaria.set(idVitima, abertas + 1);
  conexoesSse.add(res);
  return true;
}

function liberarConexaoSse(idVitima, res) {
  conexoesSse.delete(res);
  const abertas = (conexoesSsePorUsuaria.get(idVitima) || 1) - 1;
  if (abertas > 0) conexoesSsePorUsuaria.set(idVitima, abertas);
  else conexoesSsePorUsuaria.delete(idVitima);
}

// Usado no desligamento do servidor: avisa o navegador para reconectar depois.
function encerrarConexoesSse() {
  for (const res of conexoesSse) res.end();
  conexoesSse.clear();
  conexoesSsePorUsuaria.clear();
}

function eventosSse(req, res) {
  const { idVitima } = req.usuario;
  if (!registrarConexaoSse(idVitima, res)) {
    return res.status(429).json({
      erro: `Limite de ${MAX_CONEXOES_SSE_POR_USUARIA} abas acompanhando o status ao mesmo tempo.`,
      codigo: 'MUITAS_CONEXOES',
    });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const cancelarAssinatura = eventos.assinar(idVitima, (evento) => {
    res.write(`event: status_analise\ndata: ${JSON.stringify(evento)}\n\n`);
  });

  // O batimento mantém a conexão viva e derruba o SSE quando a sessão acaba (logout, inatividade).
  const batimento = setInterval(async () => {
    try {
      if (!(await authService.sessaoAindaValida(req.usuario.idSessao))) {
        res.write('event: sessao_encerrada\ndata: {}\n\n');
        res.end();
        return;
      }
      res.write(': ping\n\n');
    } catch {
      // Banco indisponível: tenta de novo no próximo batimento.
    }
  }, INTERVALO_BATIMENTO_SSE_MS);

  req.on('close', () => {
    clearInterval(batimento);
    cancelarAssinatura();
    liberarConexaoSse(idVitima, res);
  });
}

// Só no modo local (sem S3). Não pede login: o <video> do navegador não manda token,
// então quem tem o link assinado por /:id/url pode abrir, como numa URL pré-assinada do S3.
async function servirArquivoLocal(req, res) {
  if (storage.MODO_S3) return res.status(404).json({ erro: 'Rota disponível apenas no modo local.' });

  const motivoLinkInvalido = storage.validarAssinaturaLocal(Number(req.params.id), req.query.expira, req.query.assinatura);
  if (motivoLinkInvalido) return res.status(403).json({ erro: motivoLinkInvalido });

  const id = lerIdPositivo(req.params.id);
  if (id === null) return res.status(400).json({ erro: 'id_gravacao inválido.' });

  const { rows } = await db.query('SELECT url_storage FROM gravacao WHERE id_gravacao = $1', [id]);
  if (!rows.length) return res.status(404).json({ erro: `Gravação ${id} não encontrada.` });
  const arquivoExiste = await fs.access(rows[0].url_storage).then(() => true, () => false);
  if (!arquivoExiste) {
    return res.status(404).json({ erro: 'Arquivo do vídeo não encontrado no armazenamento.' });
  }

  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.sendFile(path.resolve(rows[0].url_storage), { headers: { 'Content-Type': 'video/mp4' } });
}

module.exports = envolverControladores({
  servirArquivoLocal,
  listar,
  detalhar,
  gerarUrl,
  verificarIntegridade,
  baixarLaudo,
  baixarLaudoPdf,
  baixarCarimbo,
  reprocessar,
  excluir,
  eventosSse,
});
module.exports.encerrarConexoesSse = encerrarConexoesSse;
