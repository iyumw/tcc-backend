// Carimbo de tempo RFC 3161: cada gravação é carimbada por uma autoridade (aqui,
// uma TSA falsa dos testes); o .tsr baixado prova a data do hash do vídeo.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente, esperar } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');
const { lerCarimbo } = require('../src/services/carimboTempoService');

const TEMPO_MAXIMO_CARIMBO_MS = 10000;

describe('carimbo de tempo RFC 3161', () => {
  let ambiente;
  let cliente;
  let chave;
  let token;
  let carimbada;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('carimbo@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
  });
  after(() => ambiente?.encerrar());

  async function aguardarCarimbo(idGravacao, statusEsperado) {
    const limite = Date.now() + TEMPO_MAXIMO_CARIMBO_MS;
    while (Date.now() < limite) {
      const { dados } = await cliente.requisicao('GET', `/evidencias/${idGravacao}`, { token });
      if (dados.carimbo_tempo.status === statusEsperado || dados.carimbo_tempo.ultimo_erro) return dados;
      await esperar(100);
    }
    throw new Error(`O carimbo da gravação ${idGravacao} não chegou a "${statusEsperado}" a tempo.`);
  }

  it('carimba a gravação assim que o vídeo é montado', async () => {
    const inicio = Date.now();
    const gravacao = await cliente.gravarEvidencia(token, chave, { sessionId: `${ID_CAMERA}-880001` });
    carimbada = await aguardarCarimbo(gravacao.id_gravacao, 'emitido');

    assert.equal(carimbada.carimbo_tempo.status, 'emitido');
    assert.equal(carimbada.carimbo_tempo.autoridade, ambiente.tsa.url);
    assert.ok(new Date(carimbada.carimbo_tempo.emitido_em).getTime() >= inicio - 1000);
  });

  it('o .tsr baixado é a resposta da TSA para o hash do vídeo', async () => {
    const { status, dados, headers } = await cliente.requisicao('GET', `/evidencias/${carimbada.id_gravacao}/carimbo.tsr`, { token });

    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), 'application/timestamp-reply');
    const lido = lerCarimbo(dados, carimbada.hash_sha256);
    assert.equal(lido.emitidoEm.toISOString(), new Date(carimbada.carimbo_tempo.emitido_em).toISOString());
  });

  it('a verificação de integridade confere o carimbo com o hash registrado', async () => {
    const { dados } = await cliente.requisicao('GET', `/evidencias/${carimbada.id_gravacao}/integridade`, { token });

    assert.equal(dados.integro, true);
    assert.equal(dados.carimbo_tempo.confere_com_hash, true);
  });

  it('o laudo traz o carimbo de tempo', async () => {
    const { dados } = await cliente.requisicao('GET', `/evidencias/${carimbada.id_gravacao}/laudo`, { token });

    assert.equal(dados.laudo.carimbo_tempo.status, 'emitido');
  });

  it('outra conta não baixa o carimbo (403)', async () => {
    const outraConta = await cliente.criarConta('carimbo-outra@teste.com', gerarCpf());
    const { status } = await cliente.requisicao('GET', `/evidencias/${carimbada.id_gravacao}/carimbo.tsr`, { token: outraConta });

    assert.equal(status, 403);
  });

  it('se a TSA recusar, a gravação fica pendente com o motivo e o .tsr responde 409', async () => {
    ambiente.tsa.estado.recusar = true;
    const gravacao = await cliente.gravarEvidencia(token, chave, { sessionId: `${ID_CAMERA}-880002` });
    const detalhe = await aguardarCarimbo(gravacao.id_gravacao, 'emitido');
    ambiente.tsa.estado.recusar = false;

    assert.equal(detalhe.carimbo_tempo.status, 'pendente');
    assert.match(detalhe.carimbo_tempo.ultimo_erro, /recusou/);
    const { status } = await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}/carimbo.tsr`, { token });
    assert.equal(status, 409);
  });
});
