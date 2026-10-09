// Carimbo de tempo RFC 3161: uma autoridade (TSA) assina "este hash existia neste
// instante", o que prova a data do vídeo sem depender do relógio do servidor.
const crypto = require('crypto');
const db = require('../config/db');
const der = require('../utils/der');

const TSA_URL = process.env.TSA_URL ?? 'https://freetsa.org/tsr';
const TIMEOUT_TSA_MS = 15000;
const MAX_TENTATIVAS = 5;
const INTERVALO_REENVIO_MS = 5 * 60 * 1000;
const LOTE_REENVIO = 5;
const TAMANHO_NONCE_BYTES = 8;

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const STATUS_CONCEDIDOS = [0, 1]; // granted, grantedWithMods

let reenvioEmAndamento = false;
let temporizadorDeReenvio = null;

function carimboConfigurado() {
  return Boolean(TSA_URL);
}

// certReq = true: a TSA inclui o próprio certificado, para o token ser verificável sozinho.
function montarPedido(hashHex, nonce) {
  const algoritmo = der.sequencia(der.oid(OID_SHA256), der.nulo());
  const impressao = der.sequencia(algoritmo, der.octetos(Buffer.from(hashHex, 'hex')));
  return der.sequencia(der.inteiro(1), impressao, der.inteiro(nonce), der.booleano(true));
}

function lerInfoDoToken(token) {
  const [tipoDeConteudo, conteudo] = token.filhos;
  if (!tipoDeConteudo || der.lerOid(tipoDeConteudo) !== OID_SIGNED_DATA) {
    throw new Error('o token não é um SignedData');
  }
  const dadosAssinados = conteudo.filhos[0];
  const conteudoEncapsulado = dadosAssinados.filhos[2];
  if (der.lerOid(conteudoEncapsulado.filhos[0]) !== OID_TST_INFO) throw new Error('o token não traz um TSTInfo');

  const info = der.ler(conteudoEncapsulado.filhos[1].filhos[0].valor);
  const [, , impressao, numeroDeSerie, momento, ...opcionais] = info.filhos;
  const nonce = opcionais.find((elemento) => elemento.tag === der.TAG.INTEIRO);
  return {
    algoritmo: der.lerOid(impressao.filhos[0].filhos[0]),
    hash: impressao.filhos[1].valor.toString('hex'),
    numeroSerie: der.semZerosAEsquerda(numeroDeSerie.valor).toString('hex'),
    emitidoEm: der.lerTempoGeneralizado(momento),
    nonce: nonce ? der.semZerosAEsquerda(nonce.valor) : null,
  };
}

/**
 * Lê a resposta da TSA (TimeStampResp, em DER) e confere que ela carimba `hashHex`
 * (e o `nonce` do pedido, quando informado). Não confere a assinatura: isso é feito
 * com o certificado da TSA (ver docs/carimbo-tempo.md).
 */
function lerCarimbo(respostaDer, hashHex, nonce = null) {
  const resposta = der.ler(respostaDer);
  const [situacao, token] = resposta.filhos;
  const status = der.semZerosAEsquerda(situacao.filhos[0].valor)[0];
  if (!STATUS_CONCEDIDOS.includes(status) || !token) throw new Error(`a TSA recusou o pedido (status ${status})`);

  const info = lerInfoDoToken(token);
  if (info.algoritmo !== OID_SHA256 || info.hash !== hashHex.toLowerCase()) {
    throw new Error('o carimbo não corresponde ao hash do vídeo');
  }
  if (nonce && (!info.nonce || !info.nonce.equals(der.semZerosAEsquerda(nonce)))) {
    throw new Error('o nonce da resposta não confere com o do pedido');
  }
  return { emitidoEm: info.emitidoEm, numeroSerie: info.numeroSerie };
}

function carimboConfere(respostaDer, hashHex) {
  try {
    lerCarimbo(respostaDer, hashHex);
    return true;
  } catch {
    return false;
  }
}

async function pedirCarimbo(hashHex) {
  const nonce = crypto.randomBytes(TAMANHO_NONCE_BYTES);
  const resposta = await fetch(TSA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: montarPedido(hashHex, nonce),
    signal: AbortSignal.timeout(TIMEOUT_TSA_MS),
  });
  if (!resposta.ok) throw new Error(`a TSA respondeu HTTP ${resposta.status}`);

  const respostaDer = Buffer.from(await resposta.arrayBuffer());
  return { respostaDer, ...lerCarimbo(respostaDer, hashHex, nonce) };
}

function descreverFalha(erro) {
  if (erro.name === 'TimeoutError') return `a TSA não respondeu em ${TIMEOUT_TSA_MS / 1000} s`;
  const codigo = erro.cause && erro.cause.code;
  return codigo ? `TSA inacessível em ${TSA_URL} (${codigo})` : erro.message;
}

async function registrarFalha(idGravacao, motivo) {
  await db.query(
    `UPDATE gravacao SET carimbo_tentativas = carimbo_tentativas + 1, carimbo_ultimo_erro = $2
      WHERE id_gravacao = $1`,
    [idGravacao, motivo.slice(0, 1000)]
  );
  console.warn(`[Carimbo] Gravação ${idGravacao}: ${motivo}`);
}

async function carimbarGravacao(idGravacao) {
  if (!carimboConfigurado()) return;
  const { rows } = await db.query(
    'SELECT hash_seguranca FROM gravacao WHERE id_gravacao = $1 AND carimbo_tempo IS NULL',
    [idGravacao]
  );
  if (!rows.length) return;

  try {
    const carimbo = await pedirCarimbo(rows[0].hash_seguranca.trim());
    await db.query(
      `UPDATE gravacao
          SET carimbo_tempo = $2, carimbo_emitido_em = $3, carimbo_autoridade = $4,
              carimbo_numero_serie = $5, carimbo_ultimo_erro = NULL
        WHERE id_gravacao = $1 AND carimbo_tempo IS NULL`,
      [idGravacao, carimbo.respostaDer, carimbo.emitidoEm, TSA_URL, carimbo.numeroSerie]
    );
    console.log(`[Carimbo] Gravação ${idGravacao} carimbada em ${carimbo.emitidoEm.toISOString()}.`);
  } catch (erro) {
    await registrarFalha(idGravacao, descreverFalha(erro));
  }
}

// Gravações que ficaram sem carimbo (TSA fora do ar) são tentadas de novo depois.
async function carimbarPendentes() {
  if (reenvioEmAndamento) return;
  reenvioEmAndamento = true;
  try {
    const { rows } = await db.query(
      `SELECT id_gravacao FROM gravacao
        WHERE carimbo_tempo IS NULL AND carimbo_tentativas < $1
        ORDER BY id_gravacao
        LIMIT $2`,
      [MAX_TENTATIVAS, LOTE_REENVIO]
    );
    for (const { id_gravacao: idGravacao } of rows) await carimbarGravacao(idGravacao);
  } catch (erro) {
    console.error('[Carimbo] Erro ao carimbar pendentes:', erro);
  } finally {
    reenvioEmAndamento = false;
  }
}

function iniciarCarimboPeriodico() {
  if (!carimboConfigurado()) {
    console.log('[Carimbo] TSA_URL vazio: os vídeos ficam sem carimbo de tempo RFC 3161.');
    return;
  }
  temporizadorDeReenvio = setInterval(carimbarPendentes, INTERVALO_REENVIO_MS);
  console.log(`[Carimbo] Autoridade de carimbo de tempo: ${TSA_URL}`);
}

function pararCarimboPeriodico() {
  clearInterval(temporizadorDeReenvio);
}

function descreverCarimbo(gravacao) {
  if (gravacao.carimbo_emitido_em) {
    return {
      status: 'emitido',
      emitido_em: gravacao.carimbo_emitido_em,
      autoridade: gravacao.carimbo_autoridade,
      numero_serie: gravacao.carimbo_numero_serie,
    };
  }
  const esgotado = gravacao.carimbo_tentativas >= MAX_TENTATIVAS;
  return { status: esgotado ? 'falhou' : 'pendente', ultimo_erro: gravacao.carimbo_ultimo_erro || null };
}

module.exports = {
  montarPedido,
  lerCarimbo,
  carimboConfere,
  carimbarGravacao,
  carimbarPendentes,
  iniciarCarimboPeriodico,
  pararCarimboPeriodico,
  descreverCarimbo,
};
