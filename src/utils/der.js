// Codificação ASN.1 DER mínima para o carimbo de tempo (RFC 3161).
const TAG = {
  BOOLEANO: 0x01,
  INTEIRO: 0x02,
  OCTETOS: 0x04,
  NULO: 0x05,
  OID: 0x06,
  TEMPO_GENERALIZADO: 0x18,
  SEQUENCIA: 0x30,
  CONJUNTO: 0x31,
};
const TAG_EXPLICITA_BASE = 0xa0;
const BIT_CONSTRUIDO = 0x20;

function codificarTamanho(tamanho) {
  if (tamanho < 0x80) return Buffer.from([tamanho]);
  const bytes = [];
  for (let restante = tamanho; restante > 0; restante >>= 8) bytes.unshift(restante & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, conteudo) {
  return Buffer.concat([Buffer.from([tag]), codificarTamanho(conteudo.length), conteudo]);
}

const sequencia = (...partes) => tlv(TAG.SEQUENCIA, Buffer.concat(partes));
const conjunto = (...partes) => tlv(TAG.CONJUNTO, Buffer.concat(partes));
const octetos = (bytes) => tlv(TAG.OCTETOS, bytes);
const nulo = () => tlv(TAG.NULO, Buffer.alloc(0));
const booleano = (valor) => tlv(TAG.BOOLEANO, Buffer.from([valor ? 0xff : 0x00]));
const explicito = (numero, conteudo) => tlv(TAG_EXPLICITA_BASE + numero, conteudo);
const tempoGeneralizado = (texto) => tlv(TAG.TEMPO_GENERALIZADO, Buffer.from(texto, 'ascii'));

// Inteiro positivo a partir de bytes big-endian (0x00 na frente se o bit de sinal estiver ligado).
function inteiro(bytes) {
  const valor = Buffer.isBuffer(bytes) ? bytes : Buffer.from([bytes]);
  return tlv(TAG.INTEIRO, valor[0] & 0x80 ? Buffer.concat([Buffer.from([0]), valor]) : valor);
}

function oid(texto) {
  const [primeiro, segundo, ...resto] = texto.split('.').map(Number);
  const bytes = [primeiro * 40 + segundo];
  for (const numero of resto) {
    const grupos = [numero & 0x7f];
    for (let restante = numero >> 7; restante > 0; restante >>= 7) grupos.unshift((restante & 0x7f) | 0x80);
    bytes.push(...grupos);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

function lerTamanho(buffer, posicao) {
  const primeiro = buffer[posicao];
  if (primeiro < 0x80) return { tamanho: primeiro, inicioConteudo: posicao + 1 };
  const quantidadeDeBytes = primeiro & 0x7f;
  if (quantidadeDeBytes === 0 || quantidadeDeBytes > 4) throw new Error('DER: tamanho inválido.');
  let tamanho = 0;
  for (let i = 1; i <= quantidadeDeBytes; i++) tamanho = tamanho * 256 + buffer[posicao + i];
  return { tamanho, inicioConteudo: posicao + 1 + quantidadeDeBytes };
}

function lerElemento(buffer, posicao) {
  if (posicao + 2 > buffer.length) throw new Error('DER: dados truncados.');
  const tag = buffer[posicao];
  const { tamanho, inicioConteudo } = lerTamanho(buffer, posicao + 1);
  const fim = inicioConteudo + tamanho;
  if (fim > buffer.length) throw new Error('DER: dados truncados.');

  const valor = buffer.subarray(inicioConteudo, fim);
  const filhos = tag & BIT_CONSTRUIDO ? lerSequenciaDeElementos(valor) : [];
  return { elemento: { tag, valor, filhos, bruto: buffer.subarray(posicao, fim) }, proximaPosicao: fim };
}

function lerSequenciaDeElementos(buffer) {
  const elementos = [];
  for (let posicao = 0; posicao < buffer.length; ) {
    const { elemento, proximaPosicao } = lerElemento(buffer, posicao);
    elementos.push(elemento);
    posicao = proximaPosicao;
  }
  return elementos;
}

/** Lê um DER completo e devolve a árvore { tag, valor, filhos, bruto }. */
function ler(buffer) {
  const { elemento, proximaPosicao } = lerElemento(buffer, 0);
  if (proximaPosicao !== buffer.length) throw new Error('DER: sobraram bytes no fim.');
  return elemento;
}

function lerOid(elemento) {
  const [primeiro, ...resto] = elemento.valor;
  const numeros = [Math.floor(primeiro / 40), primeiro % 40];
  let acumulado = 0;
  for (const byte of resto) {
    acumulado = acumulado * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      numeros.push(acumulado);
      acumulado = 0;
    }
  }
  return numeros.join('.');
}

// "20261009143005.123Z" -> Date
function lerTempoGeneralizado(elemento) {
  const texto = elemento.valor.toString('ascii');
  const partes = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(texto);
  if (!partes) throw new Error(`DER: data em formato inesperado (${texto}).`);
  const [, ano, mes, dia, hora, minuto, segundo, fracao = ''] = partes;
  return new Date(`${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}${fracao}Z`);
}

function semZerosAEsquerda(bytes) {
  let inicio = 0;
  while (inicio < bytes.length - 1 && bytes[inicio] === 0) inicio++;
  return bytes.subarray(inicio);
}

module.exports = {
  TAG,
  TAG_EXPLICITA_BASE,
  sequencia,
  conjunto,
  octetos,
  nulo,
  booleano,
  explicito,
  inteiro,
  oid,
  tempoGeneralizado,
  ler,
  lerOid,
  lerTempoGeneralizado,
  semZerosAEsquerda,
};
