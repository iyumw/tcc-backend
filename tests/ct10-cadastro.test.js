// CT10 - Criação de perfil (RE05/RN03), regras validadas no backend: cadastro
// completo, endereço de entrega no perfil, e-mail de confirmação, e recusa de
// CPF inválido, e-mail repetido e senha fraca com mensagens diferentes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente, esperar } = require('./support/ambiente');
const { criarCliente, dadosDeCadastro, gerarCpf } = require('./support/cliente');

const EMAIL = 'ct10@teste.com';
const PRAZO_EMAIL_MS = 60000;

describe('CT10 - criação de perfil', () => {
  let ambiente;
  let cliente;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
  });
  after(() => ambiente?.encerrar());

  const cadastrar = (dados) => cliente.requisicao('POST', '/auth/cadastro', { corpo: dados });

  it('cria a conta com todos os campos obrigatórios (201)', async () => {
    const { status } = await cadastrar(dadosDeCadastro(EMAIL, gerarCpf()));

    assert.equal(status, 201);
  });

  it('envia o e-mail de confirmação em até 1 minuto', async () => {
    const limite = Date.now() + PRAZO_EMAIL_MS;
    const confirmacaoEnviada = () => /Para: ct10@teste\.com \| Cadastro confirmado/.test(ambiente.textoDoLog());
    while (!confirmacaoEnviada() && Date.now() < limite) await esperar(100);

    assert.ok(confirmacaoEnviada(), 'e-mail de confirmação não foi enviado');
  });

  it('o endereço de entrega fica no perfil', async () => {
    const token = await cliente.entrar(EMAIL);

    const { dados } = await cliente.requisicao('GET', '/perfil', { token });

    assert.equal(dados.endereco.logradouro, 'Av. Paulista');
    assert.equal(dados.endereco.numero, '1000');
    assert.equal(dados.endereco.cidade, 'São Paulo');
  });

  it('recusa CPF inválido (000.000.000-00) apontando o campo', async () => {
    const { status, dados } = await cadastrar(dadosDeCadastro('outro@teste.com', '000.000.000-00'));

    assert.equal(status, 400);
    assert.ok(dados.campos.cpf, 'deveria indicar o campo cpf');
  });

  it('recusa e-mail já cadastrado com mensagem diferente da do CPF', async () => {
    const cpfInvalido = await cadastrar(dadosDeCadastro('mais-um@teste.com', '000.000.000-00'));
    const emailRepetido = await cadastrar(dadosDeCadastro(EMAIL.toUpperCase(), gerarCpf()));

    assert.equal(emailRepetido.status, 409);
    assert.ok(emailRepetido.dados.campos.email, 'deveria indicar o campo email');
    assert.notEqual(emailRepetido.dados.erro, cpfInvalido.dados.erro);
  });

  it('recusa senha fraca (RN03) e cadastro sem aceite dos termos', async () => {
    const senhaFraca = await cadastrar({ ...dadosDeCadastro('fraca@teste.com', gerarCpf()), senha: 'senha123' });
    const semAceite = await cadastrar({ ...dadosDeCadastro('aceite@teste.com', gerarCpf()), consentimento: false });

    assert.equal(senhaFraca.status, 400);
    assert.ok(senhaFraca.dados.campos.senha);
    assert.equal(semAceite.status, 400);
    assert.ok(semAceite.dados.campos.consentimento);
  });
});
