const path = require('path');
const db = require('../config/db');
const storage = require('./storageService');
const ia = require('./clienteIa');
const { descreverCarimbo } = require('./carimboTempoService');
const { baseUrlPublica } = require('../config/urlPublica');
const { erroHttp } = require('../utils/erros');
const { numeroOuNulo } = require('../utils/validacao');

// RN16: a análise deve levar no máximo metade da duração do vídeo.
const PRAZO_RN16_FRACAO_DA_DURACAO = 0.5;
const TIMEOUT_LAUDO_PDF_MS = 120000;
// A IA pode demorar para começar a baixar, então o link dela vale mais que os 15 min da usuária.
const VALIDADE_URL_IA_MIN = 60;

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
    linha_do_tempo: analise.linha_do_tempo,
    algoritmo_versao: analise.versao_modelo,
    duracao_video_segundos: duracao,
    tempo_processamento_ms: analise.tempo_processamento_ms,
    dentro_do_prazo_rn16:
      prazoRn16Ms !== null && analise.tempo_processamento_ms !== null ? analise.tempo_processamento_ms <= prazoRn16Ms : null,
    carimbo_tempo: descreverCarimbo(analise),
  };
}

async function consultarAnalise(idGravacao) {
  const { rows } = await db.query(
    `SELECT g.id_gravacao, g.hash_seguranca, g.duracao_segundos, g.status_analise,
            g.tentativas_analise, g.ultimo_erro_analise, g.analise_atualizada_em,
            g.carimbo_emitido_em, g.carimbo_autoridade, g.carimbo_numero_serie,
            g.carimbo_tentativas, g.carimbo_ultimo_erro,
            a.id_device,
            ia.id_analise, ia.score, ia.veredicto, ia.segmentos_criticos, ia.versao_modelo,
            ia.tempo_processamento_ms, ia.concluida_em, ia.linha_do_tempo
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

function formatarDataHora(data) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(data));
}

// "Download de Segurança": o PDF é gerado pelo serviço de IA.
async function gerarLaudoPdf(gravacao) {
  if (!ia.iaConfigurada()) throw erroHttp(503, 'Serviço de IA não configurado.');

  const { rows } = await db.query('SELECT resultado_ia FROM analise_ia WHERE id_gravacao = $1', [gravacao.id_gravacao]);
  if (!rows.length) throw erroHttp(409, 'O laudo ainda não está pronto.');
  if (!rows[0].resultado_ia) throw erroHttp(409, 'Esta análise é anterior ao laudo em PDF. Peça uma nova análise.');

  const acesso = await storage.gerarUrlAssinada(gravacao.id_gravacao, gravacao.url_storage, baseUrlPublica(), VALIDADE_URL_IA_MIN);
  const pedido = {
    resultado: rows[0].resultado_ia,
    metadados: {
      id_gravacao: gravacao.id_gravacao,
      arquivo: path.basename(gravacao.url_storage),
      data_gravacao: formatarDataHora(gravacao.data_hora),
      dispositivo: gravacao.id_device,
      duracao_s: numeroOuNulo(gravacao.duracao_segundos),
      hash_sha256: gravacao.hash_seguranca.trim(),
      carimbo_tempo: descreverCarimbo(gravacao),
    },
    video_url: acesso.url,
  };

  let resposta;
  try {
    resposta = await ia.postarParaIa('/laudo', pedido, TIMEOUT_LAUDO_PDF_MS);
  } catch (erro) {
    const motivo = ia.descreverFalhaDeEnvio(erro, TIMEOUT_LAUDO_PDF_MS);
    console.error(`[Laudo] PDF da gravação ${gravacao.id_gravacao}: ${motivo}`);
    throw erroHttp(502, 'O serviço de IA não respondeu. Tente de novo em instantes.');
  }

  if (resposta.status === 409) {
    throw erroHttp(409, 'O vídeo guardado não confere com o hash registrado; o laudo não foi gerado.');
  }
  if (!resposta.ok) {
    console.error(`[Laudo] PDF da gravação ${gravacao.id_gravacao}: IA respondeu HTTP ${resposta.status}`);
    throw erroHttp(502, 'O serviço de IA não conseguiu gerar o laudo. Tente de novo em instantes.');
  }

  return {
    pdf: Buffer.from(await resposta.arrayBuffer()),
    codigoVerificacao: resposta.headers.get('x-codigo-verificacao'),
  };
}

module.exports = { VALIDADE_URL_IA_MIN, consultarAnalise, gerarLaudoPdf };
