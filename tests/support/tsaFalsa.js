// Autoridade de carimbo de tempo falsa para os testes: devolve um TimeStampResp
// com a estrutura da RFC 3161 (hash e nonce do pedido), mas sem assinatura.
const http = require('node:http');
const der = require('../../src/utils/der');

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_POLITICA_DE_TESTE = '1.2.3.4.1';
const STATUS_RECUSADO = 2;

function formatarMomento(data) {
  return data.toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
}

function montarResposta(pedidoDer, numeroSerie, momento) {
  const [, impressao, ...opcionais] = der.ler(pedidoDer).filhos;
  const nonce = opcionais.find((elemento) => elemento.tag === der.TAG.INTEIRO);

  const infoDoCarimbo = der.sequencia(
    der.inteiro(1),
    der.oid(OID_POLITICA_DE_TESTE),
    impressao.bruto,
    der.inteiro(numeroSerie),
    der.tempoGeneralizado(formatarMomento(momento)),
    ...(nonce ? [nonce.bruto] : [])
  );
  const dadosAssinados = der.sequencia(
    der.inteiro(3),
    der.conjunto(der.sequencia(der.oid(OID_SHA256), der.nulo())),
    der.sequencia(der.oid(OID_TST_INFO), der.explicito(0, der.octetos(infoDoCarimbo))),
    der.conjunto()
  );
  const token = der.sequencia(der.oid(OID_SIGNED_DATA), der.explicito(0, dadosAssinados));
  return der.sequencia(der.sequencia(der.inteiro(0)), token);
}

/** Sobe a TSA falsa numa porta livre. `recusar` = true faz ela responder "rejection". */
function iniciarTsaFalsa() {
  let numeroSerie = 0;
  const estado = { recusar: false, pedidos: 0 };

  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      estado.pedidos += 1;
      const resposta = estado.recusar
        ? der.sequencia(der.sequencia(der.inteiro(STATUS_RECUSADO)))
        : montarResposta(Buffer.concat(partes), ++numeroSerie, new Date());
      res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' });
      res.end(resposta);
    });
  });

  return new Promise((resolve) => {
    servidor.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${servidor.address().port}/tsr`,
        estado,
        encerrar: () => new Promise((fechou) => servidor.close(fechou)),
      });
    });
  });
}

module.exports = { iniciarTsaFalsa, montarResposta };
