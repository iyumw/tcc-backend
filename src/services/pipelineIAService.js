const crypto = require('crypto');
const db = require('../config/db');
const storage = require('./storageService');
const eventos = require('./eventosService');
const { erroHttp } = require('../utils/erros');
const { ehPercentual, numeroOuNulo } = require('../utils/validacao');

const IA_SERVICE_URL = (process.env.IA_SERVICE_URL || '').replace(/\/+$/, '');
const IA_TOKEN = process.env.IA_TOKEN || '';
const IA_CALLBACK_TOKEN = process.env.IA_CALLBACK_TOKEN || '';

const MAX_TENTATIVAS = Number(process.env.IA_MAX_TENTATIVAS) || 5;
const TIMEOUT_PROCESSAMENTO_MIN = Number(process.env.IA_TIMEOUT_MINUTOS) || 30;
const TIMEOUT_ENVIO_MS = 10000;
const INTERVALO_VERIFICACAO_MS = 60 * 1000;
const LOTE_VERIFICACAO = 5;
// A IA pode demorar para começar a baixar, então o link dela vale mais que os 15 min da usuária.
const VALIDADE_URL_IA_MIN = 60;
// RN16: a análise deve levar no máximo metade da duração do vídeo.
const PRAZO_RN16_FRACAO_DA_DURACAO = 0.5;

const VEREDICTOS = ['Alerta Alto', 'Anomalia', 'Normal'];

function iaConfigurada() {
  return Boolean(IA_SERVICE_URL);
}

function baseUrlPublica() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '');
}

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

function descreverFalhaDeEnvio(erro) {
  if (erro.name === 'TimeoutError') return `serviço de IA não respondeu em ${TIMEOUT_ENVIO_MS / 1000} s`;
  const codigo = erro.cause && erro.cause.code;
  if (codigo) return `serviço de IA inacessível em ${IA_SERVICE_URL} (${codigo})`;
  return erro.message;
}

async function solicitarAnalise(idGravacao) {
  if (!iaConfigurada()) {
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
    const resposta = await fetch(`${IA_SERVICE_URL}/analisar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(IA_TOKEN ? { Authorization: `Bearer ${IA_TOKEN}` } : {}),
      },
      body: JSON.stringify(await montarPedidoDeAnalise(gravacao)),
      signal: AbortSignal.timeout(TIMEOUT_ENVIO_MS),
    });
    if (!resposta.ok) throw new Error(`serviço de IA respondeu HTTP ${resposta.status}`);

    console.log(`[PipelineIA] Gravação ${gravacao.id_gravacao} enviada pra análise (tentativa ${gravacao.tentativas_analise}).`);
    return { enviado: true };
  } catch (erro) {
    const motivo = descreverFalhaDeEnvio(erro);
    await marcarErro(gravacao.id_gravacao, `Falha ao enviar para a IA: ${motivo}`);
    return { enviado: false, motivo };
  }
}

function validarSegmentos(segmentos) {
  if (segmentos === undefined || segmentos === null) return [];
  if (!Array.isArray(segmentos)) throw erroHttp(400, '"segmentos_criticos" deve ser uma lista.');

  return segmentos.map((segmentoRecebido, i) => {
    const inicio = Number(segmentoRecebido && segmentoRecebido.inicio_s);
    const fim = Number(segmentoRecebido && segmentoRecebido.fim_s);
    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio < 0 || fim < inicio) {
      throw erroHttp(400, `segmentos_criticos[${i}]: "inicio_s" e "fim_s" devem ser números, com inicio_s <= fim_s.`);
    }
    const segmento = { inicio_s: inicio, fim_s: fim };
    if (segmentoRecebido.score !== undefined) {
      const score = Number(segmentoRecebido.score);
      if (!ehPercentual(score)) throw erroHttp(400, `segmentos_criticos[${i}].score deve estar entre 0 e 100.`);
      segmento.score = score;
    }
    return segmento;
  });
}

function validarResultadoConcluido(dados) {
  const score = Number(dados.score);
  if (!ehPercentual(score)) throw erroHttp(400, '"score" deve ser um número entre 0 e 100.');
  if (!VEREDICTOS.includes(dados.veredicto)) {
    throw erroHttp(400, `"veredicto" deve ser um de: ${VEREDICTOS.join(', ')}.`);
  }
  if (!dados.versao_modelo || typeof dados.versao_modelo !== 'string') {
    throw erroHttp(400, '"versao_modelo" é obrigatório (RN07).');
  }
  const segmentos = validarSegmentos(dados.segmentos_criticos);
  const tempoMs = Math.round(Number(dados.tempo_processamento_ms));
  return {
    score,
    veredicto: dados.veredicto,
    segmentos,
    versaoModelo: dados.versao_modelo.slice(0, 100),
    tempoMs: dados.tempo_processamento_ms !== undefined && Number.isFinite(tempoMs) ? tempoMs : null,
  };
}

function hashConfere(dados, hashRegistrado) {
  if (dados.hash_sha256_verificado === undefined) return true;
  return String(dados.hash_sha256_verificado).toLowerCase() === hashRegistrado;
}

async function registrarResultado(idGravacao, dados) {
  const status = String(dados.status || '').toLowerCase();
  const cliente = await db.getClient();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      'SELECT status_analise, hash_seguranca FROM gravacao WHERE id_gravacao = $1 FOR UPDATE',
      [idGravacao]
    );
    if (!rows.length) {
      await cliente.query('ROLLBACK');
      return { statusHttp: 404, corpo: { erro: `Gravação ${idGravacao} não encontrada.` } };
    }
    if (rows[0].status_analise === 'Concluido') {
      await cliente.query('ROLLBACK');
      return { statusHttp: 409, corpo: { erro: 'Esta gravação já tem análise concluída.' } };
    }

    if (status === 'erro') {
      await cliente.query('ROLLBACK');
      await marcarErro(idGravacao, `Serviço de IA: ${dados.erro || 'erro não especificado'}`);
      return { statusHttp: 200, corpo: { registrado: true, status_analise: 'Erro' } };
    }
    if (status !== 'concluido') throw erroHttp(400, '"status" deve ser "concluido" ou "erro".');

    const hashRegistrado = rows[0].hash_seguranca.trim();
    if (!hashConfere(dados, hashRegistrado)) {
      await cliente.query('ROLLBACK');
      await marcarErro(
        idGravacao,
        `Hash do vídeo analisado pela IA (${dados.hash_sha256_verificado}) difere do registrado (${hashRegistrado}).`
      );
      return { statusHttp: 409, corpo: { erro: 'Hash do vídeo analisado não confere com o registrado.' } };
    }

    const resultado = validarResultadoConcluido(dados);
    const analise = await cliente.query(
      `INSERT INTO analise_ia (id_gravacao, score, veredicto, segmentos_criticos, versao_modelo, tempo_processamento_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id_analise`,
      [idGravacao, resultado.score, resultado.veredicto, JSON.stringify(resultado.segmentos),
       resultado.versaoModelo, resultado.tempoMs]
    );
    await cliente.query(
      `UPDATE gravacao
          SET status_analise = 'Concluido', ultimo_erro_analise = NULL, analise_atualizada_em = NOW()
        WHERE id_gravacao = $1`,
      [idGravacao]
    );
    await cliente.query('COMMIT');

    eventos.notificarStatus(idGravacao);
    console.log(`[PipelineIA] Gravação ${idGravacao} analisada: ${resultado.veredicto} (${resultado.score}).`);
    return {
      statusHttp: 201,
      corpo: { registrado: true, status_analise: 'Concluido', id_analise: analise.rows[0].id_analise },
    };
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
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
  next();
}

// Laudo no formato da Tabela 15 do TCC.
function montarLaudo(analise) {
  const duracao = numeroOuNulo(analise.duracao_segundos);
  const prazoRn16Ms = duracao ? duracao * 1000 * PRAZO_RN16_FRACAO_DA_DURACAO : null;
  return {
    id_laudo: `LAUDO-${new Date(analise.concluida_em).getFullYear()}-${String(analise.id_analise).padStart(6, '0')}`,
    timestamp_emissao: analise.concluida_em,
    dispositivo_origem: analise.id_device,
    hash_video_original: analise.hash_seguranca.trim(),
    status_analise: 'CONCLUIDO',
    classificacao_final: analise.veredicto === 'Normal' ? 'NENHUM_EVENTO_DETECTADO' : 'EVENTO_AGRESSIVIDADE_DETECTADO',
    veredicto: analise.veredicto,
    indice_probabilidade: Number(analise.score),
    segmentos_criticos: analise.segmentos_criticos,
    algoritmo_versao: analise.versao_modelo,
    duracao_video_segundos: duracao,
    tempo_processamento_ms: analise.tempo_processamento_ms,
    dentro_do_prazo_rn16:
      prazoRn16Ms !== null && analise.tempo_processamento_ms !== null ? analise.tempo_processamento_ms <= prazoRn16Ms : null,
  };
}

async function consultarAnalise(idGravacao) {
  const { rows } = await db.query(
    `SELECT g.id_gravacao, g.hash_seguranca, g.duracao_segundos, g.status_analise,
            g.tentativas_analise, g.ultimo_erro_analise, g.analise_atualizada_em,
            a.id_device,
            ia.id_analise, ia.score, ia.veredicto, ia.segmentos_criticos, ia.versao_modelo,
            ia.tempo_processamento_ms, ia.concluida_em
       FROM gravacao g
       JOIN acionamento a ON a.id_acionamento = g.id_acionamento
       LEFT JOIN analise_ia ia ON ia.id_gravacao = g.id_gravacao
      WHERE g.id_gravacao = $1`,
    [idGravacao]
  );
  if (!rows.length) return null;
  const analise = rows[0];
  return {
    id_gravacao: analise.id_gravacao,
    status_analise: analise.status_analise,
    tentativas: analise.tentativas_analise,
    ultimo_erro: analise.ultimo_erro_analise,
    atualizado_em: analise.analise_atualizada_em,
    laudo: analise.id_analise ? montarLaudo(analise) : null,
  };
}

// Reenvia com espera crescente entre tentativas (1, 2, 4, 8... min) até MAX_TENTATIVAS.
async function verificarPendencias() {
  const travadas = await db.query(
    `UPDATE gravacao
        SET status_analise = 'Erro',
            ultimo_erro_analise = 'Tempo esgotado aguardando o resultado da IA.',
            analise_atualizada_em = NOW()
      WHERE status_analise = 'Processando'
        AND analise_atualizada_em < NOW() - ($1 * INTERVAL '1 minute')
      RETURNING id_gravacao`,
    [TIMEOUT_PROCESSAMENTO_MIN]
  );
  for (const { id_gravacao: id } of travadas.rows) {
    console.warn(`[PipelineIA] Gravação ${id}: sem resposta da IA em ${TIMEOUT_PROCESSAMENTO_MIN} min.`);
  }

  const candidatas = await db.query(
    `SELECT id_gravacao FROM gravacao
      WHERE status_analise = 'Pendente'
         OR (status_analise = 'Erro'
             AND tentativas_analise < $1
             AND analise_atualizada_em < NOW() - (POWER(2, GREATEST(tentativas_analise - 1, 0)) * INTERVAL '1 minute'))
      ORDER BY analise_atualizada_em
      LIMIT $2`,
    [MAX_TENTATIVAS, LOTE_VERIFICACAO]
  );
  for (const { id_gravacao: id } of candidatas.rows) {
    await solicitarAnalise(id);
  }
}

function iniciarVerificacaoPeriodica() {
  if (!iaConfigurada()) {
    console.log('[PipelineIA] IA_SERVICE_URL vazio — análises ficarão como Pendente até configurar.');
    return;
  }
  const rodar = () =>
    verificarPendencias().catch((erro) => console.error('[PipelineIA] Erro na verificação periódica:', erro));
  setTimeout(rodar, 5000);
  setInterval(rodar, INTERVALO_VERIFICACAO_MS);
  console.log(`[PipelineIA] Serviço de IA: ${IA_SERVICE_URL} (verificação a cada ${INTERVALO_VERIFICACAO_MS / 1000} s).`);
}

module.exports = {
  iaConfigurada,
  solicitarAnalise,
  registrarResultado,
  autenticarCallback,
  consultarAnalise,
  iniciarVerificacaoPeriodica,
};
