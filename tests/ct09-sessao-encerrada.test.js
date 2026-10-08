// CT09 - Rotas protegidas depois do fim da sessão (RE11), parte do backend:
// depois do logout, de 15 min sem uso ou do limite de 8 h, o token deixa de
// valer e nenhum dado é devolvido. O redirecionamento (AuthGuard) é conferido no front.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf } = require('./support/cliente');

describe('CT09 - acesso depois do fim da sessão (backend)', () => {
  let ambiente;
  let cliente;
  let cpf;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    cpf = gerarCpf();
    await cliente.criarConta('ct09@teste.com', cpf);
  });
  after(() => ambiente?.encerrar());

  const perfil = (token) => cliente.requisicao('GET', '/perfil', { token });
  const ultimaSessao = "SELECT id_sessao FROM sessao ORDER BY criada_em DESC LIMIT 1";

  it('com sessão ativa, o perfil é devolvido', async () => {
    const token = await cliente.entrar('ct09@teste.com');

    const { status, dados } = await perfil(token);

    assert.equal(status, 200);
    assert.equal(dados.email, 'ct09@teste.com');
  });

  it('depois do logout, o mesmo token é recusado (401) sem devolver dados', async () => {
    const token = await cliente.entrar('ct09@teste.com');

    assert.equal((await cliente.requisicao('POST', '/auth/logout', { token })).status, 204);
    const { status, dados } = await perfil(token);

    assert.equal(status, 401);
    assert.equal(dados.email, undefined);
  });

  it('depois de 15 min sem uso, a sessão é encerrada (RE11)', async () => {
    const token = await cliente.entrar('ct09@teste.com');
    await ambiente.banco.query(
      `UPDATE sessao SET ultimo_acesso = NOW() - INTERVAL '16 minutes' WHERE id_sessao = (${ultimaSessao})`
    );

    const { status, dados } = await perfil(token);

    assert.equal(status, 401);
    assert.equal(dados.codigo, 'SESSAO_INATIVA');
  });

  it('depois do limite de 8 h, a sessão expira mesmo com uso', async () => {
    const token = await cliente.entrar('ct09@teste.com');
    await ambiente.banco.query(`UPDATE sessao SET expira_em = NOW() - INTERVAL '1 second' WHERE id_sessao = (${ultimaSessao})`);

    const { status } = await perfil(token);

    assert.equal(status, 401);
  });

  it('token alterado ou sem token é recusado (401)', async () => {
    const token = await cliente.entrar('ct09@teste.com');
    const tokenAlterado = `${token.slice(0, -2)}xx`;

    assert.equal((await perfil(tokenAlterado)).status, 401);
    assert.equal((await perfil(undefined)).status, 401);
  });

  it('o CPF não aparece em nenhuma resposta sem login', async () => {
    const { dados } = await perfil(undefined);

    assert.ok(!JSON.stringify(dados).includes(cpf));
  });
});
