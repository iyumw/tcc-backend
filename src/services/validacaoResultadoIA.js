// Formato do callback: docs/contrato-ia.md
const { erroHttp } = require('../utils/erros');
const { ehPercentual } = require('../utils/validacao');

const VEREDICTOS = ['Alerta Alto', 'Anomalia', 'Normal'];
const NIVEIS_LINHA_DO_TEMPO = ['normal', 'alerta', 'critico'];

function lerIntervalo(item, campo, i) {
  const inicio = Number(item && item.inicio_s);
  const fim = Number(item && item.fim_s);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio < 0 || fim < inicio) {
    throw erroHttp(400, `${campo}[${i}]: "inicio_s" e "fim_s" devem ser números, com inicio_s <= fim_s.`);
  }
  return { inicio_s: inicio, fim_s: fim };
}

function lerNumeroOpcional(item, chave, campo, i) {
  if (item[chave] === undefined || item[chave] === null) return undefined;
  const valor = Number(item[chave]);
  if (!Number.isFinite(valor) || valor < 0) throw erroHttp(400, `${campo}[${i}].${chave} deve ser um número >= 0.`);
  return valor;
}

function validarSegmentos(segmentos) {
  if (segmentos === undefined || segmentos === null) return [];
  if (!Array.isArray(segmentos)) throw erroHttp(400, '"segmentos_criticos" deve ser uma lista.');

  return segmentos.map((segmentoRecebido, i) => {
    const segmento = lerIntervalo(segmentoRecebido, 'segmentos_criticos', i);
    if (segmentoRecebido.score !== undefined) {
      const score = Number(segmentoRecebido.score);
      if (!ehPercentual(score)) throw erroHttp(400, `segmentos_criticos[${i}].score deve estar entre 0 e 100.`);
      segmento.score = score;
    }
    const pico = lerNumeroOpcional(segmentoRecebido, 'pico_s', 'segmentos_criticos', i);
    if (pico !== undefined) segmento.pico_s = pico;
    return segmento;
  });
}

// Uma entrada por segundo do vídeo, para o gráfico do front. Opcional: IA antiga não manda.
function validarLinhaDoTempo(linhaDoTempo) {
  if (linhaDoTempo === undefined || linhaDoTempo === null) return null;
  if (!Array.isArray(linhaDoTempo)) throw erroHttp(400, '"linha_do_tempo" deve ser uma lista.');

  return linhaDoTempo.map((itemRecebido, i) => {
    const item = lerIntervalo(itemRecebido, 'linha_do_tempo', i);
    const score = Number(itemRecebido.score);
    if (!ehPercentual(score)) throw erroHttp(400, `linha_do_tempo[${i}].score deve estar entre 0 e 100.`);
    if (!NIVEIS_LINHA_DO_TEMPO.includes(itemRecebido.nivel)) {
      throw erroHttp(400, `linha_do_tempo[${i}].nivel deve ser um de: ${NIVEIS_LINHA_DO_TEMPO.join(', ')}.`);
    }
    item.score = score;
    const scoreFrame = lerNumeroOpcional(itemRecebido, 'score_frame', 'linha_do_tempo', i);
    if (scoreFrame !== undefined) item.score_frame = scoreFrame;
    const pico = lerNumeroOpcional(itemRecebido, 'pico_s', 'linha_do_tempo', i);
    if (pico !== undefined) item.pico_s = pico;
    item.nivel = itemRecebido.nivel;
    return item;
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
  const linhaDoTempo = validarLinhaDoTempo(dados.linha_do_tempo);
  const tempoMs = Math.round(Number(dados.tempo_processamento_ms));
  return {
    score,
    veredicto: dados.veredicto,
    segmentos,
    linhaDoTempo,
    versaoModelo: dados.versao_modelo.slice(0, 100),
    tempoMs: dados.tempo_processamento_ms !== undefined && Number.isFinite(tempoMs) ? tempoMs : null,
  };
}

// Obrigatório (cadeia de custódia): a IA prova que analisou exatamente o arquivo registrado.
function hashConfere(dados, hashRegistrado) {
  if (typeof dados.hash_sha256_verificado !== 'string') return false;
  return dados.hash_sha256_verificado.toLowerCase() === hashRegistrado;
}

module.exports = { validarResultadoConcluido, hashConfere };
