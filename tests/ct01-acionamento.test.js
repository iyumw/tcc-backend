// CT01 - Acionamento da captura (RE01), parte do backend: a câmera só é aceita
// com a chave certa, e o primeiro frame cria uma sessão única com o horário de início.
// O acionamento pelo relógio (1,5 s, sem LED/vibração) é testado à mão.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, ID_CAMERA } = require('./support/cliente');

describe('CT01 - acionamento da captura (backend)', () => {
  let ambiente;
  let cliente;
  let chave;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    chave = cliente.cadastrarCamera();
  });
  after(() => ambiente?.encerrar());

  it('recusa frame de câmera sem chave ou com chave errada (401)', async () => {
    const sessionId = `${ID_CAMERA}-1001`;
    const semChave = await cliente.requisicao('POST', '/captura/upload', {
      formulario: cliente.formularioDeFrame(sessionId, 0),
    });
    const chaveErrada = await cliente.requisicao('POST', '/captura/upload', {
      formulario: cliente.formularioDeFrame(sessionId, 0),
      cabecalhos: cliente.cabecalhosDaCamera('chave-errada'),
    });

    assert.equal(semChave.status, 401);
    assert.equal(chaveErrada.status, 401);
  });

  it('cria uma sessão com o horário de início no primeiro frame', async () => {
    const sessionId = `${ID_CAMERA}-1002`;

    const resposta = await cliente.enviarFrame(chave, sessionId, 0);

    assert.equal(resposta.status, 201);
    // Calculado pelo relógio do banco, o mesmo que gravou o horário de início.
    const { rows } = await ambiente.banco.query(
      `SELECT id_device, data_hora, EXTRACT(EPOCH FROM (NOW() - data_hora)) AS segundos_desde_inicio
         FROM acionamento WHERE external_session_id = $1`,
      [sessionId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id_device, ID_CAMERA);
    assert.ok(rows[0].data_hora, 'horário de início deveria estar registrado');
    assert.ok(Number(rows[0].segundos_desde_inicio) < 5, 'horário de início deveria ser o do primeiro frame');
  });

  it('não cria sessões duplicadas quando chegam vários frames da mesma gravação', async () => {
    const sessionId = `${ID_CAMERA}-1003`;

    await Promise.all([0, 1, 2, 3].map((indice) => cliente.enviarFrame(chave, sessionId, indice)));

    const { rows } = await ambiente.banco.query(
      'SELECT COUNT(*)::int AS total FROM acionamento WHERE external_session_id = $1',
      [sessionId]
    );
    assert.equal(rows[0].total, 1);
  });

  it('recusa sessão que não pertence à câmera autenticada (403)', async () => {
    const resposta = await cliente.enviarFrame(chave, 'outra-camera-1004', 0);

    assert.equal(resposta.status, 403);
  });
});
