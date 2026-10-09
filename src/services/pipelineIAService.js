const crypto = require('crypto');
const db = require('../config/db');
const storage = require('./storageService');
const eventos = require('./eventosService');
const ia = require('./clienteIa');
const { VALIDADE_URL_IA_MIN } = require('./laudoService');
const { validarResultadoConcluido, hashConfere } = require('./validacaoResultadoIA');
const { baseUrlPublica } = require('../config/urlPublica');
const { erroHttp } = require('../utils/erros');
const { numeroOuNulo } = require('../utils/validacao');

const IA_CALLBACK_TOKEN = process.env.IA_CALLBACK_TOKEN || '';
const MAX_TENTATIVAS = Number(process.env.IA_MAX_TENTATIVAS) || 5;
const TIMEOUT_PROCESSAMENTO_MIN = Number(process.env.IA_TIMEOUT_MINUTOS) || 30;
const TIMEOUT_ENVIO_MS = 10000;
const INTERVALO_VERIFICACAO_MS = 60 * 1000;
const ATRASO_PRIMEIRA_VERIFICACAO_MS = 5000;
const LOTE_VERIFICACAO = 5;

let verificacaoEmAndamento = false;
let temporizadores = [];

async function marcarErro(idGravacao, mensagem) {
  await db.query(
    `UPDATE gravacao
        SET status_analise = 'Erro', ultimo_erro_analise = $2, analise_atualizada_em = NOW()
      WHERE id_gravacao = $1 AND status_analise <> 'Concluido'`,
    [idGravacao, String(mensagem).slice(0, 1000)]
  );
  console.warn(`[PipelineIA] Gravação ${idGravacao} -> Erro: ${mensagem}`);
  eventos.notificarStatus(idGravacao);
}

async function descartarSemArquivo(idGravacao) {
  const { rows } = await db.query(
    `SELECT url_storage FROM gravacao WHERE id_gravacao = $1 AND status_analise IN ('Pendente', 'Erro')`,
    [idGravacao]
  );
  if (!rows.length || (await storage.existe(rows[0].url_storage))) return false;

  await db.query(
    `UPDATE gravacao
        SET status_analise = 'Erro', tentativas_analise = $2, analise_atualizada_em = NOW(),
            ultimo_erro_analise = $3
      WHERE id_gravacao = $1`,
    [idGravacao, MAX_TENTATIVAS,
     `Arquivo do vídeo não encontrado no armazenamento (${rows[0].url_storage}). Análise não é possível.`]
  );
  console.warn(`[PipelineIA] Gravação ${idGravacao}: arquivo do vídeo não existe mais — não será analisada.`);
  eventos.notificarStatus(idGravacao);
  return true;
}

// O UPDATE condicional garante que duas chamadas ao mesmo tempo (fim da gravação +
// verificação periódica) não mandem o mesmo vídeo duas vezes.
async function marcarProcessando(idGravacao) {
  const { rows } = await db.query(
    `UPDATE gravacao
        SET status_analise = 'Processando',
            tentativas_analise = tentativas_analise + 1,
            ultimo_erro_analise = NULL,
            analise_atualizada_em = NOW()
      WHERE id_gravacao = $1 AND status_analise IN ('Pendente', 'Erro')
      RETURNING id_gravacao, url_storage, hash_seguranca, duracao_segundos, tentativas_analise`,
    [idGravacao]
  );
  return rows[0] || null;
}

async function montarPedidoDeAnalise(gravacao) {
  const base = baseUrlPublica();
  const acesso = await storage.gerarUrlAssinada(gravacao.id_gravacao, gravacao.url_storage, base, VALIDADE_URL_IA_MIN);
  return {
    id_gravacao: gravacao.id_gravacao,
    video_url: acesso.url,
    video_url_expira_em: acesso.expira_em,
    hash_sha256: gravacao.hash_seguranca.trim(),
    duracao_segundos: numeroOuNulo(gravacao.duracao_segundos),
    callback_url: `${base}/api/ia/resultado/${gravacao.id_gravacao}`,
    tentativa: gravacao.tentativas_analise,
  };
}

async function solicitarAnalise(idGravacao) {
  if (!ia.iaConfigurada()) {
    console.log(`[PipelineIA] IA_SERVICE_URL não configurada — gravação ${idGravacao} fica 'Pendente'.`);
    return { enviado: false, motivo: 'Serviço de IA não configurado (IA_SERVICE_URL).' };
  }
  if (await descartarSemArquivo(idGravacao)) {
    return { enviado: false, motivo: 'Arquivo do vídeo não encontrado no armazenamento.' };
  }

  const gravacao = await marcarProcessando(idGravacao);
  if (!gravacao) {
    return { enviado: false, motivo: 'Gravação não está Pendente/Erro (já em análise ou concluída).' };
  }
  eventos.notificarStatus(gravacao.id_gravacao);

  try {
    const resposta = await ia.postarParaIa('/analisar', await montarPedidoDeAnalise(gravacao), TIMEOUT_ENVIO_MS);
    if (!resposta.ok) throw new Error(`serviço de IA respondeu HTTP ${resposta.status}`);

    console.log(`[PipelineIA] Gravação ${gravacao.id_gravacao} enviada pra análise (tentativa ${gravacao.tentativas_analise}).`);
    return { enviado: true };
  } catch (erro) {
    const motivo = ia.descreverFalhaDeEnvio(erro, TIMEOUT_ENVIO_MS);
    await marcarErro(gravacao.id_gravacao, `Falha ao enviar para a IA: ${motivo}`);
    return { enviado: false, motivo };
  }
}

async function bloquearGravacao(cliente, idGravacao) {
  const { rows } = await cliente.query(
    'SELECT status_analise, hash_seguranca FROM gravacao WHERE id_gravacao = $1 FOR UPDATE',
    [idGravacao]
  );
  return rows[0] || null;
}

async function salvarAnalise(cliente, idGravacao, resultado, dadosOriginais) {
  const { rows } = await cliente.query(
    `INSERT INTO analise_ia (id_gravacao, score, veredicto, segmentos_criticos, linha_do_tempo,
                             versao_modelo, tempo_processamento_ms, resultado_ia)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id_analise`,
    [idGravacao, resultado.score, resultado.veredicto, JSON.stringify(resultado.segmentos),
     resultado.linhaDoTempo && JSON.stringify(resultado.linhaDoTempo),
     resultado.versaoModelo, resultado.tempoMs,
     // O JSON do callback do jeito que chegou: o código de verificação do PDF é o hash dele.
     JSON.stringify(dadosOriginais)]
  );
  await cliente.query(
    `UPDATE gravacao
        SET status_analise = 'Concluido', ultimo_erro_analise = NULL, analise_atualizada_em = NOW()
      WHERE id_gravacao = $1`,
    [idGravacao]
  );
  return rows[0].id_analise;
}

// Decide o que fazer com o callback dentro da transação. Erros de validação
// desfazem tudo; "erro" e hash divergente viram status Erro na gravação.
async function avaliarCallback(cliente, idGravacao, dados) {
  const gravacao = await bloquearGravacao(cliente, idGravacao);
  if (!gravacao) return { statusHttp: 404, corpo: { erro: `Gravação ${idGravacao} não encontrada.` } };
  if (gravacao.status_analise === 'Concluido') {
    return { statusHttp: 409, corpo: { erro: 'Esta gravação já tem análise concluída.' } };
  }

  const status = String(dados.status || '').toLowerCase();
  if (status === 'erro') {
    return { marcarErro: `Serviço de IA: ${dados.erro || 'erro não especificado'}`, statusHttp: 200, corpo: { registrado: true, status_analise: 'Erro' } };
  }
  if (status !== 'concluido') throw erroHttp(400, '"status" deve ser "concluido" ou "erro".');

  const hashRegistrado = gravacao.hash_seguranca.trim();
  if (!hashConfere(dados, hashRegistrado)) {
    return {
      marcarErro: `Hash do vídeo analisado pela IA (${dados.hash_sha256_verificado ?? 'não informado'}) difere do registrado (${hashRegistrado}).`,
      statusHttp: 409,
      corpo: { erro: 'Hash do vídeo analisado ausente ou diferente do registrado.' },
    };
  }

  const resultado = validarResultadoConcluido(dados);
  const idAnalise = await salvarAnalise(cliente, idGravacao, resultado, dados);
  console.log(`[PipelineIA] Gravação ${idGravacao} analisada: ${resultado.veredicto} (${resultado.score}).`);
  return {
    concluida: true,
    statusHttp: 201,
    corpo: { registrado: true, status_analise: 'Concluido', id_analise: idAnalise },
  };
}

async function registrarResultado(idGravacao, dados) {
  const decisao = await db.emTransacao((cliente) => avaliarCallback(cliente, idGravacao, dados));
  if (decisao.marcarErro) await marcarErro(idGravacao, decisao.marcarErro);
  if (decisao.concluida) eventos.notificarStatus(idGravacao);
  return { statusHttp: decisao.statusHttp, corpo: decisao.corpo };
}

function autenticarCallback(req, res, next) {
  if (!IA_CALLBACK_TOKEN) {
    return res.status(503).json({ erro: 'IA_CALLBACK_TOKEN não configurado no backend.' });
  }
  const recebido = Buffer.from(String(req.get('authorization') || ''));
  const esperado = Buffer.from(`Bearer ${IA_CALLBACK_TOKEN}`);
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }
  return next();
}

async function marcarAnalisesTravadas() {
  const { rows } = await db.query(
    `UPDATE gravacao
        SET status_analise = 'Erro',
            ultimo_erro_analise = 'Tempo esgotado aguardando o resultado da IA.',
            analise_atualizada_em = NOW()
      WHERE status_analise = 'Processando'
        AND analise_atualizada_em < NOW() - ($1 * INTERVAL '1 minute')
      RETURNING id_gravacao`,
    [TIMEOUT_PROCESSAMENTO_MIN]
  );
  for (const { id_gravacao: id } of rows) {
    console.warn(`[PipelineIA] Gravação ${id}: sem resposta da IA em ${TIMEOUT_PROCESSAMENTO_MIN} min.`);
  }
}

// Reenvia com espera crescente entre tentativas (1, 2, 4, 8... min) até MAX_TENTATIVAS.
async function reenviarPendentes() {
  const { rows } = await db.query(
    `SELECT id_gravacao FROM gravacao
      WHERE status_analise = 'Pendente'
         OR (status_analise = 'Erro'
             AND tentativas_analise < $1
             AND analise_atualizada_em < NOW() - (POWER(2, GREATEST(tentativas_analise - 1, 0)) * INTERVAL '1 minute'))
      ORDER BY analise_atualizada_em
      LIMIT $2`,
    [MAX_TENTATIVAS, LOTE_VERIFICACAO]
  );
  for (const { id_gravacao: id } of rows) {
    await solicitarAnalise(id);
  }
}

// Uma rodada lenta (IA fora do ar) não se sobrepõe à seguinte.
async function verificarPendencias() {
  if (verificacaoEmAndamento) return;
  verificacaoEmAndamento = true;
  try {
    await marcarAnalisesTravadas();
    await reenviarPendentes();
  } catch (erro) {
    console.error('[PipelineIA] Erro na verificação periódica:', erro);
  } finally {
    verificacaoEmAndamento = false;
  }
}

function iniciarVerificacaoPeriodica() {
  if (!ia.iaConfigurada()) {
    console.log('[PipelineIA] IA_SERVICE_URL vazio — análises ficarão como Pendente até configurar.');
    return;
  }
  temporizadores = [
    setTimeout(verificarPendencias, ATRASO_PRIMEIRA_VERIFICACAO_MS),
    setInterval(verificarPendencias, INTERVALO_VERIFICACAO_MS),
  ];
  console.log(`[PipelineIA] Serviço de IA: ${ia.IA_SERVICE_URL} (verificação a cada ${INTERVALO_VERIFICACAO_MS / 1000} s).`);
}

function pararVerificacaoPeriodica() {
  for (const temporizador of temporizadores) clearTimeout(temporizador);
  temporizadores = [];
}

module.exports = {
  iaConfigurada: ia.iaConfigurada,
  solicitarAnalise,
  registrarResultado,
  autenticarCallback,
  iniciarVerificacaoPeriodica,
  pararVerificacaoPeriodica,
};
