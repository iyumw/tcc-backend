// Robustez (code review de 08/10/2026): concorrência, limites de upload,
// hash obrigatório no callback, logs sem token e limite de tentativas.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarAmbiente, esperar } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const EMAIL_A = 'robustez-a@teste.com';
const EMAIL_B = 'robustez-b@teste.com';
const TOKEN_FALSO = 'token-que-nao-pode-aparecer-no-log';

describe('robustez do backend', () => {
  let ambiente;
  let cliente;
  let chave;
  let tokenA;
  let gravacao;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    chave = cliente.cadastrarCamera();
    tokenA = await cliente.criarConta(EMAIL_A, gerarCpf());
    await cliente.criarConta(EMAIL_B, gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token: tokenA, corpo: { id_dispositivo: ID_CAMERA } });
  });
  after(() => ambiente?.encerrar());

  const pastaDaSessao = (sessionId) => path.join(ambiente.pastaTmp, 'frames', sessionId);

  function enviarArquivo(sessionId, conteudo, tipo, campos = { device_id: ID_CAMERA }) {
    const formulario = new FormData();
    for (const [nome, valor] of Object.entries(campos)) formulario.append(nome, valor);
    formulario.append('session_id', sessionId);
    formulario.append('frame_index', '0');
    formulario.append('image', new Blob([conteudo], { type: tipo }), 'frame.jpg');
    return cliente.requisicao('POST', '/captura/upload', {
      formulario,
      cabecalhos: cliente.cabecalhosDaCamera(chave),
    });
  }

  it('encerrar a mesma sessão duas vezes ao mesmo tempo gera uma gravação só', async () => {
    const sessionId = `${ID_CAMERA}-990001`;
    for (let indice = 0; indice < 4; indice++) await cliente.enviarFrame(chave, sessionId, indice);

    const respostas = await Promise.all([
      cliente.encerrarSessao(chave, sessionId),
      cliente.encerrarSessao(chave, sessionId),
    ]);
    assert.deepEqual(respostas.map((resposta) => resposta.status), [202, 202]);

    gravacao = await cliente.aguardarGravacao(tokenA, (item) => item.status_analise === 'Concluido');
    const { rows } = await ambiente.banco.query(
      `SELECT COUNT(*)::int AS total FROM gravacao g
         JOIN acionamento a ON a.id_acionamento = g.id_acionamento
        WHERE a.external_session_id = $1`,
      [sessionId]
    );
    assert.equal(rows[0].total, 1);

    const repetida = await cliente.encerrarSessao(chave, sessionId);
    assert.equal(repetida.status, 200);
    assert.equal(repetida.dados.status, 'concluida');
  });

  it('o mesmo código MFA certo só abre uma sessão, mesmo enviado duas vezes ao mesmo tempo', async () => {
    const { resposta, codigo } = await cliente.pedirCodigo(EMAIL_B, 'login', () =>
      cliente.requisicao('POST', '/auth/login', { corpo: { email: EMAIL_B, senha: 'Senha@123' } })
    );
    const corpo = { mfa_token: resposta.dados.mfa_token, codigo };

    const tentativas = await Promise.all([
      cliente.requisicao('POST', '/auth/mfa', { corpo }),
      cliente.requisicao('POST', '/auth/mfa', { corpo }),
    ]);

    assert.deepEqual(tentativas.map((tentativa) => tentativa.status).sort(), [200, 401]);
  });

  it('trocar o e-mail para um já cadastrado responde 409 sem gastar o código', async () => {
    const { codigo } = await cliente.pedirCodigo(EMAIL_A, 'alterar_dados', () =>
      cliente.requisicao('POST', '/perfil/codigo', { token: tokenA, corpo: { finalidade: 'alterar_dados' } })
    );

    const duplicado = await cliente.requisicao('PUT', '/perfil', { token: tokenA, corpo: { email: EMAIL_B, codigo } });
    assert.equal(duplicado.status, 409);

    const outraAlteracao = await cliente.requisicao('PUT', '/perfil', {
      token: tokenA,
      corpo: { telefone: '(11) 97777-6666', codigo },
    });
    assert.equal(outraAlteracao.status, 200);
  });

  it('o callback da IA sem o hash do vídeo analisado é recusado (409) e vira Erro', async () => {
    const { rows } = await ambiente.banco.query(
      `WITH acionamento_novo AS (
         INSERT INTO acionamento (id_device, external_session_id, id_vitima)
         SELECT id_dispositivo, $1, id_vitima FROM dispositivo WHERE id_dispositivo = $2
         RETURNING id_acionamento)
       INSERT INTO gravacao (id_acionamento, url_storage, hash_seguranca, status_analise)
       SELECT id_acionamento, '/nao/existe.mp4', $3, 'Processando' FROM acionamento_novo
       RETURNING id_gravacao`,
      [`${ID_CAMERA}-990002`, ID_CAMERA, 'c'.repeat(64)]
    );
    const idGravacao = rows[0].id_gravacao;

    const { status } = await cliente.requisicao('POST', `/ia/resultado/${idGravacao}`, {
      cabecalhos: { Authorization: `Bearer ${ambiente.env.IA_CALLBACK_TOKEN}` },
      corpo: { status: 'concluido', score: 10, veredicto: 'Normal', versao_modelo: 'teste' },
    });

    assert.equal(status, 409);
    const situacao = await ambiente.banco.query('SELECT status_analise FROM gravacao WHERE id_gravacao = $1', [idGravacao]);
    assert.equal(situacao.rows[0].status_analise, 'Erro');
  });

  it('upload que não é JPEG ou sem device_id é recusado e não deixa arquivo no disco', async () => {
    const sessionId = `${ID_CAMERA}-990003`;

    assert.equal((await enviarArquivo(sessionId, 'texto', 'text/plain')).status, 415);
    assert.equal((await enviarArquivo(sessionId, 'não sou jpeg', 'image/jpeg')).status, 415);
    assert.equal((await enviarArquivo(sessionId, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', {})).status, 400);

    const restantes = fs.existsSync(pastaDaSessao(sessionId)) ? fs.readdirSync(pastaDaSessao(sessionId)) : [];
    assert.deepEqual(restantes, []);
  });

  it('a exclusão aceita a confirmação na URL (?confirmacao=true)', async () => {
    const { status } = await cliente.requisicao('DELETE', `/evidencias/${gravacao.id_gravacao}?confirmacao=true`, {
      token: tokenA,
    });

    assert.equal(status, 204);
  });

  it('o token passado na URL não aparece no log', async () => {
    await cliente.requisicao('GET', `/evidencias/eventos?token=${TOKEN_FALSO}`);
    await esperar(100);

    assert.ok(!ambiente.textoDoLog().includes(TOKEN_FALSO));
    assert.ok(ambiente.textoDoLog().includes('token=***'));
  });

  it('rota inexistente responde 404 em JSON', async () => {
    const { status, dados } = await cliente.requisicao('GET', '/rota-que-nao-existe');

    assert.equal(status, 404);
    assert.equal(dados.codigo, 'ROTA_NAO_ENCONTRADA');
  });

  it('depois de 10 tentativas de login em 15 min, o mesmo IP recebe 429', async () => {
    const tentar = () => cliente.requisicao('POST', '/auth/login', { corpo: { email: 'ninguem@teste.com', senha: 'x' } });
    let ultima;
    for (let tentativa = 0; tentativa < 11; tentativa++) ultima = await tentar();

    assert.equal(ultima.status, 429);
    assert.equal(ultima.dados.codigo, 'MUITAS_TENTATIVAS');
  });
});
