// CT05 - Privacidade dos vídeos (RN11). O sistema não tem perfil
// administrativo: ninguém além da dona acessa vídeo ou laudo pela API. Outra
// conta recebe 403 em todas as rotas, nenhum byte do vídeo é devolvido e a
// tentativa fica no log de auditoria com quem tentou e quando.
// O bloqueio no console da AWS (S3 privado, sem acesso público) é conferido à mão.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

describe('CT05 - acesso a vídeo de outra usuária', () => {
  let ambiente;
  let cliente;
  let tokenDona;
  let tokenOutra;
  let idOutra;
  let gravacao;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    const chave = cliente.cadastrarCamera();
    tokenDona = await cliente.criarConta('dona@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token: tokenDona, corpo: { id_dispositivo: ID_CAMERA } });
    gravacao = await cliente.gravarEvidencia(tokenDona, chave);

    tokenOutra = await cliente.criarConta('outra@teste.com', gerarCpf());
    const { rows } = await ambiente.banco.query("SELECT id_vitima FROM vitima WHERE email = 'outra@teste.com'");
    idOutra = rows[0].id_vitima;
  });
  after(() => ambiente?.encerrar());

  const rotasDaEvidencia = (id) => [
    ['GET', `/evidencias/${id}`],
    ['GET', `/evidencias/${id}/url`],
    ['GET', `/evidencias/${id}/laudo`],
    ['GET', `/evidencias/${id}/laudo.pdf`],
    ['GET', `/evidencias/${id}/integridade`],
    ['DELETE', `/evidencias/${id}`],
  ];

  it('a dona acessa o próprio vídeo normalmente', async () => {
    const { status, dados } = await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}/url`, { token: tokenDona });

    assert.equal(status, 200);
    assert.ok(dados.url);
  });

  it('outra conta recebe 403 em todas as rotas e nenhum conteúdo do vídeo', async () => {
    for (const [metodo, rota] of rotasDaEvidencia(gravacao.id_gravacao)) {
      const corpo = metodo === 'DELETE' ? { confirmacao: true } : undefined;
      const { status, dados } = await cliente.requisicao(metodo, rota, { token: tokenOutra, corpo });

      assert.equal(status, 403, `${metodo} ${rota}`);
      assert.ok(!Buffer.isBuffer(dados), `${metodo} ${rota} não deveria devolver arquivo`);
      assert.equal(dados.url, undefined);
    }
  });

  it('a lista da outra conta não mostra a gravação', async () => {
    const { dados } = await cliente.requisicao('GET', '/evidencias', { token: tokenOutra });

    assert.deepEqual(dados, []);
  });

  it('cada tentativa fica no log de auditoria com a conta e o horário', async () => {
    const { rows } = await ambiente.banco.query(
      "SELECT id_vitima, criado_em, detalhes FROM log_auditoria WHERE acao = 'acesso_negado' ORDER BY id_log"
    );

    assert.equal(rows.length, rotasDaEvidencia(gravacao.id_gravacao).length);
    for (const linha of rows) {
      assert.equal(linha.id_vitima, idOutra);
      assert.ok(linha.criado_em instanceof Date);
      assert.equal(Number(linha.detalhes.id_gravacao), gravacao.id_gravacao);
    }
  });

  it('a gravação continua existindo depois da tentativa de exclusão', async () => {
    const { status } = await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}`, { token: tokenDona });

    assert.equal(status, 200);
  });
});
