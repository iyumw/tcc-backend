// CT07 - Bloqueio de login por força bruta (RN10), regra aplicada no backend:
// 3 senhas erradas bloqueiam por 30 min (exatamente na 3ª); depois do
// desbloqueio, mais 2 erradas bloqueiam a conta até o suporte liberar.
// A mensagem na tela é conferida à mão no front.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, dadosDeCadastro, gerarCpf, SENHA_PADRAO } = require('./support/cliente');

const EMAIL = 'ct07@teste.com';
const SENHA_ERRADA = 'Teste@1234X';

describe('CT07 - bloqueio de login por força bruta', () => {
  let ambiente;
  let cliente;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    await cliente.requisicao('POST', '/auth/cadastro', { corpo: dadosDeCadastro(EMAIL, gerarCpf()) });
  });
  after(() => ambiente?.encerrar());

  const tentarLogin = (senha) => cliente.requisicao('POST', '/auth/login', { corpo: { email: EMAIL, senha } });

  it('a 1ª e a 2ª senha errada só recusam o login (401), sem bloquear', async () => {
    assert.equal((await tentarLogin(SENHA_ERRADA)).status, 401);
    assert.equal((await tentarLogin(SENHA_ERRADA)).status, 401);
  });

  it('a 3ª senha errada bloqueia a conta por 30 minutos (423)', async () => {
    const { status, dados } = await tentarLogin(SENHA_ERRADA);

    assert.equal(status, 423);
    assert.equal(dados.codigo, 'BLOQUEIO_TEMPORARIO');
    assert.equal(dados.minutos_restantes, 30);
  });

  it('durante o bloqueio, nem a senha certa entra (ex.: aos 29 min)', async () => {
    await ambiente.banco.query(
      "UPDATE vitima SET bloqueada_ate = NOW() + INTERVAL '1 minute' WHERE email = $1", // falta 1 min = minuto 29
      [EMAIL]
    );

    const { status, dados } = await tentarLogin(SENHA_PADRAO);

    assert.equal(status, 423);
    assert.equal(dados.codigo, 'BLOQUEIO_TEMPORARIO');
  });

  it('depois dos 30 min, mais 2 senhas erradas bloqueiam a conta de vez', async () => {
    await ambiente.banco.query("UPDATE vitima SET bloqueada_ate = NOW() - INTERVAL '1 second' WHERE email = $1", [EMAIL]);

    assert.equal((await tentarLogin(SENHA_ERRADA)).status, 401);
    const { status, dados } = await tentarLogin(SENHA_ERRADA);

    assert.equal(status, 423);
    assert.equal(dados.codigo, 'BLOQUEIO_PERMANENTE');
  });

  it('com o bloqueio permanente, a senha certa continua sem entrar', async () => {
    const { status, dados } = await tentarLogin(SENHA_PADRAO);

    assert.equal(status, 423);
    assert.equal(dados.codigo, 'BLOQUEIO_PERMANENTE');
  });

  it('os bloqueios ficam registrados na auditoria', async () => {
    const { rows } = await ambiente.banco.query(
      "SELECT acao FROM log_auditoria WHERE acao IN ('bloqueio_temporario', 'bloqueio_permanente') ORDER BY id_log"
    );

    assert.deepEqual(
      rows.map((linha) => linha.acao),
      ['bloqueio_temporario', 'bloqueio_permanente']
    );
  });
});
