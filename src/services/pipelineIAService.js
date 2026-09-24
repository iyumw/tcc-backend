const crypto = require('crypto');
const db = require('../config/db');
const storage = require('./storageService');
const eventos = require('./eventosService');

const IA_SERVICE_URL = (process.env.IA_SERVICE_URL || '').replace(/\/+$/, '');
const IA_TOKEN = process.env.IA_TOKEN || '';
const IA_CALLBACK_TOKEN = process.env.IA_CALLBACK_TOKEN || '';

const MAX_TENTATIVAS = Number(process.env.IA_MAX_TENTATIVAS) || 5;

const TIMEOUT_PROCESSAMENTO_MIN = Number(process.env.IA_TIMEOUT_MINUTOS) || 30;
const INTERVALO_VERIFICACAO_MS = 60 * 1000;

const VALIDADE_URL_IA_MIN = 60;

const VEREDICTOS = ['Alerta Alto', 'Anomalia', 'Normal'];

// A IA só pode consumir a gravação quando o endpoint estiver configurado.
function iaConfigurada() {
  return Boolean(IA_SERVICE_URL);
}

// Usa a URL pública para gerar o link que a IA vai baixar.
function baseUrlPublica() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '');
}

// Atualiza o status e notifica o front quando a análise falha.
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

async function solicitarAnalise(idGravacao) {
  if (!iaConfigurada()) {
    console.log(`[PipelineIA] IA_SERVICE_URL não configurada — gravação ${idGravacao} fica 'Pendente'.`);
    return { enviado: false, motivo: 'Serviço de IA não configurado (IA_SERVICE_URL).' };
  }

  const { rows: atual } = await db.query(
    `SELECT url_storage FROM gravacao WHERE id_gravacao = $1 AND status_analise IN ('Pendente', 'Erro')`,
    [idGravacao]
  );
  if (atual.length && !(await storage.existe(atual[0].url_storage))) {
    await db.query(
      `UPDATE gravacao
          SET status_analise = 'Erro', tentativas_analise = $2, analise_atualizada_em = NOW(),
              ultimo_erro_analise = $3
        WHERE id_gravacao = $1`,
      [idGravacao, MAX_TENTATIVAS,
       `Arquivo do vídeo não encontrado no armazenamento (${atual[0].url_storage}). Análise não é possível.`]
    );
    console.warn(`[PipelineIA] Gravação ${idGravacao}: arquivo do vídeo não existe mais — não será analisada.`);
    eventos.notificarStatus(idGravacao);
    return { enviado: false, motivo: 'Arquivo do vídeo não encontrado no armazenamento.' };
  }

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

  if (rows.length === 0) {
    return { enviado: false, motivo: 'Gravação não está Pendente/Erro (já em análise ou concluída).' };
  }

  const g = rows[0];
  eventos.notificarStatus(g.id_gravacao);

  try {
    const base = baseUrlPublica();
    const acesso = await storage.gerarUrlAssinada(g.id_gravacao, g.url_storage, base, VALIDADE_URL_IA_MIN);

    const corpo = {
      id_gravacao: g.id_gravacao,
      video_url: acesso.url,
      video_url_expira_em: acesso.expira_em,
      hash_sha256: g.hash_seguranca.trim(),
      duracao_segundos: g.duracao_segundos !== null ? Number(g.duracao_segundos) : null,
      callback_url: `${base}/api/ia/resultado/${g.id_gravacao}`,
      tentativa: g.tentativas_analise,
    };

    const resposta = await fetch(`${IA_SERVICE_URL}/analisar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(IA_TOKEN ? { Authorization: `Bearer ${IA_TOKEN}` } : {}),
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(10000),
    });

    if (!resposta.ok) {
      throw new Error(`serviço de IA respondeu HTTP ${resposta.status}`);
    }

    console.log(
      `[PipelineIA] Gravação ${g.id_gravacao} enviada pra análise (tentativa ${g.tentativas_analise}).`
    );
    return { enviado: true };
  } catch (erro) {
    const codigo = erro.cause && erro.cause.code;
    const motivo =
      erro.name === 'TimeoutError'
        ? 'serviço de IA não respondeu em 10 s'
        : codigo
          ? `serviço de IA inacessível em ${IA_SERVICE_URL} (${codigo})`
          : erro.message;
    await marcarErro(g.id_gravacao, `Falha ao enviar para a IA: ${motivo}`);
    return { enviado: false, motivo };
  }
}

function erroValidacao(mensagem) {
  const e = new Error(mensagem);
  e.statusCode = 400;
  e.publicMessage = mensagem;
  return e;
}

function validarSegmentos(segmentos) {
  if (segmentos === undefined || segmentos === null) return [];
  if (!Array.isArray(segmentos)) throw erroValidacao('"segmentos_criticos" deve ser uma lista.');

  return segmentos.map((s, i) => {
    const inicio = Number(s && s.inicio_s);
    const fim = Number(s && s.fim_s);
    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio < 0 || fim < inicio) {
      throw erroValidacao(`segmentos_criticos[${i}]: "inicio_s" e "fim_s" devem ser números, com inicio_s <= fim_s.`);
    }
    const segmento = { inicio_s: inicio, fim_s: fim };
    if (s.score !== undefined) {
      const score = Number(s.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw erroValidacao(`segmentos_criticos[${i}].score deve estar entre 0 e 100.`);
      }
      segmento.score = score;
    }
    return segmento;
  });
}

async function registrarResultado(idGravacao, dados) {
  const status = String(dados.status || '').toLowerCase();

  const cliente = await db.getClient();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT status_analise, hash_seguranca FROM gravacao WHERE id_gravacao = $1 FOR UPDATE`,
      [idGravacao]
    );
    if (rows.length === 0) {
      await cliente.query('ROLLBACK');
      return { statusHttp: 404, corpo: { erro: `Gravação ${idGravacao} não encontrada.` } };
    }
    const atual = rows[0];

    if (atual.status_analise === 'Concluido') {
      await cliente.query('ROLLBACK');
      return { statusHttp: 409, corpo: { erro: 'Esta gravação já tem análise concluída.' } };
    }

    if (status === 'erro') {
      await cliente.query('ROLLBACK');
      await marcarErro(idGravacao, `Serviço de IA: ${dados.erro || 'erro não especificado'}`);
      return { statusHttp: 200, corpo: { registrado: true, status_analise: 'Erro' } };
    }

    if (status !== 'concluido') {
      throw erroValidacao('"status" deve ser "concluido" ou "erro".');
    }

    if (dados.hash_sha256_verificado !== undefined) {
      const esperado = atual.hash_seguranca.trim();
      if (String(dados.hash_sha256_verificado).toLowerCase() !== esperado) {
        await cliente.query('ROLLBACK');
        await marcarErro(
          idGravacao,
          `Hash do vídeo analisado pela IA (${dados.hash_sha256_verificado}) difere do registrado (${esperado}).`
        );
        return { statusHttp: 409, corpo: { erro: 'Hash do vídeo analisado não confere com o registrado.' } };
      }
    }

    const score = Number(dados.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw erroValidacao('"score" deve ser um número entre 0 e 100.');
    }
    if (!VEREDICTOS.includes(dados.veredicto)) {
      throw erroValidacao(`"veredicto" deve ser um de: ${VEREDICTOS.join(', ')}.`);
    }
    if (!dados.versao_modelo || typeof dados.versao_modelo !== 'string') {
      throw erroValidacao('"versao_modelo" é obrigatório (RN07).');
    }
    const segmentos = validarSegmentos(dados.segmentos_criticos);
    const tempoMs = dados.tempo_processamento_ms !== undefined ? Math.round(Number(dados.tempo_processamento_ms)) : null;

    const analise = await cliente.query(
      `INSERT INTO analise_ia (id_gravacao, score, veredicto, segmentos_criticos, versao_modelo, tempo_processamento_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id_analise, concluida_em`,
      [idGravacao, score, dados.veredicto, JSON.stringify(segmentos), dados.versao_modelo.slice(0, 100),
       Number.isFinite(tempoMs) ? tempoMs : null]
    );

    await cliente.query(
      `UPDATE gravacao
          SET status_analise = 'Concluido', ultimo_erro_analise = NULL, analise_atualizada_em = NOW()
        WHERE id_gravacao = $1`,
      [idGravacao]
    );

    await cliente.query('COMMIT');
    eventos.notificarStatus(idGravacao);
    console.log(`[PipelineIA] Gravação ${idGravacao} analisada: ${dados.veredicto} (${score}).`);
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
  if (rows.length === 0) return null;
  const r = rows[0];

  const resposta = {
    id_gravacao: r.id_gravacao,
    status_analise: r.status_analise,
    tentativas: r.tentativas_analise,
    ultimo_erro: r.ultimo_erro_analise,
    atualizado_em: r.analise_atualizada_em,
    laudo: null,
  };

  if (r.id_analise) {
    const duracao = r.duracao_segundos !== null ? Number(r.duracao_segundos) : null;
    resposta.laudo = {
      id_laudo: `LAUDO-${new Date(r.concluida_em).getFullYear()}-${String(r.id_analise).padStart(6, '0')}`,
      timestamp_emissao: r.concluida_em,
      dispositivo_origem: r.id_device,
      hash_video_original: r.hash_seguranca.trim(),
      status_analise: 'CONCLUIDO',
      classificacao_final:
        r.veredicto === 'Normal' ? 'NENHUM_EVENTO_DETECTADO' : 'EVENTO_AGRESSIVIDADE_DETECTADO',
      veredicto: r.veredicto,
      indice_probabilidade: Number(r.score),
      segmentos_criticos: r.segmentos_criticos,
      algoritmo_versao: r.versao_modelo,
      duracao_video_segundos: duracao,
      tempo_processamento_ms: r.tempo_processamento_ms,

      dentro_do_prazo_rn16:
        duracao && r.tempo_processamento_ms !== null ? r.tempo_processamento_ms <= duracao * 500 : null,
    };
  }

  return resposta;
}

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
  travadas.rows.forEach((r) =>
    console.warn(`[PipelineIA] Gravação ${r.id_gravacao}: sem resposta da IA em ${TIMEOUT_PROCESSAMENTO_MIN} min.`)
  );

  const candidatas = await db.query(
    `SELECT id_gravacao FROM gravacao
      WHERE status_analise = 'Pendente'
         OR (status_analise = 'Erro'
             AND tentativas_analise < $1
             AND analise_atualizada_em < NOW() - (POWER(2, GREATEST(tentativas_analise - 1, 0)) * INTERVAL '1 minute'))
      ORDER BY analise_atualizada_em
      LIMIT 5`,
    [MAX_TENTATIVAS]
  );

  for (const { id_gravacao } of candidatas.rows) {
    await solicitarAnalise(id_gravacao);
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
  console.log(`[PipelineIA] Serviço de IA: ${IA_SERVICE_URL} (verificação a cada 60 s).`);
}

module.exports = {
  iaConfigurada,
  solicitarAnalise,
  registrarResultado,
  autenticarCallback,
  consultarAnalise,
  iniciarVerificacaoPeriodica,
  MAX_TENTATIVAS,
};
