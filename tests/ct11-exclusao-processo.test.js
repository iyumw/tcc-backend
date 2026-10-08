// CT11 - Exclusão com processo judicial ativo (RE09), regra aplicada no
// backend: exige a segunda confirmação, bloqueia a exclusão de evidência
// vinculada a processo e permite as demais. As telas são conferidas no front.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const NUMERO_DO_PROCESSO = '0001234-56.2026.8.26.0100';

describe('CT11 - exclusão com processo judicial ativo', () => {
  let ambiente;
  let cliente;
  let token;
  let vinculada;
  let semVinculo;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    const chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('ct11@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
    vinculada = await cliente.gravarEvidencia(token, chave, { sessionId: `${ID_CAMERA}-11001` });
    semVinculo = await cliente.gravarEvidencia(token, chave, { sessionId: `${ID_CAMERA}-11002` });
    await ambiente.banco.query('UPDATE gravacao SET processo_judicial = $1 WHERE id_gravacao = $2', [
      NUMERO_DO_PROCESSO,
      vinculada.id_gravacao,
    ]);
  });
  after(() => ambiente?.encerrar());

  const excluir = (gravacao, corpo) => cliente.requisicao('DELETE', `/evidencias/${gravacao.id_gravacao}`, { token, corpo });
  const detalhe = (gravacao) => cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}`, { token });

  it('sem a segunda confirmação, nada é excluído (400)', async () => {
    const { status, dados } = await excluir(semVinculo, {});

    assert.equal(status, 400);
    assert.equal(dados.codigo, 'CONFIRMACAO_OBRIGATORIA');
    assert.equal((await detalhe(semVinculo)).status, 200);
  });

  it('bloqueia a exclusão da evidência vinculada a processo, com mensagem explicativa (409)', async () => {
    const { status, dados } = await excluir(vinculada, { confirmacao: true });

    assert.equal(status, 409);
    assert.equal(dados.codigo, 'VINCULO_JUDICIAL');
    assert.match(dados.erro, /processo judicial/);
  });

  it('a evidência vinculada continua íntegra no sistema', async () => {
    const integridade = await cliente.requisicao('GET', `/evidencias/${vinculada.id_gravacao}/integridade`, { token });

    assert.equal((await detalhe(vinculada)).status, 200);
    assert.equal(integridade.dados.integro, true);
  });

  it('a evidência sem vínculo é excluída com a confirmação (204)', async () => {
    const { status } = await excluir(semVinculo, { confirmacao: true });

    assert.equal(status, 204);
    assert.equal((await detalhe(semVinculo)).status, 404);
  });

  it('depois que o vínculo é removido, a exclusão é permitida', async () => {
    await ambiente.banco.query('UPDATE gravacao SET processo_judicial = NULL WHERE id_gravacao = $1', [vinculada.id_gravacao]);

    const { status } = await excluir(vinculada, { confirmacao: true });

    assert.equal(status, 204);
  });
});
