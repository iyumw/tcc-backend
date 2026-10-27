// Upload em lote (firmware manda vários frames por requisição): os lotes podem
// chegar fora de ordem, como os reenviados do cartão SD, e o vídeo sai completo.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const INTERVALO_ENTRE_FRAMES_S = 0.5;

describe('upload de frames em lote', () => {
  let ambiente;
  let cliente;
  let token;
  let chave;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('lote@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
  });
  after(() => ambiente?.encerrar());

  const pastaDaSessao = (sessionId) => path.join(ambiente.pastaTmp, 'frames', sessionId);

  it('monta o vídeo completo com lotes chegando fora de ordem e um lote repetido', async () => {
    const sessionId = `${ID_CAMERA}-3001`;
    const lotes = [[0, 1, 2], [6, 7], [3, 4, 5], [6, 7]];

    for (const indices of lotes) {
      const resposta = await cliente.enviarLote(chave, sessionId, indices);
      assert.equal(resposta.status, 201, JSON.stringify(resposta.dados));
      assert.equal(resposta.dados.recebidos, indices.length);
    }
    assert.equal(fs.readdirSync(pastaDaSessao(sessionId)).length, 8);

    assert.equal((await cliente.encerrarSessao(chave, sessionId)).status, 202);
    const gravacao = await cliente.aguardarGravacao(token, (item) => item.status_analise === 'Concluido');
    const duracaoEsperada = 8 * INTERVALO_ENTRE_FRAMES_S;
    assert.ok(
      Math.abs(gravacao.duracao_segundos - duracaoEsperada) < 0.2,
      `duração ${gravacao.duracao_segundos}s deveria ser ~${duracaoEsperada}s`
    );
  });

  it('um nome de arquivo fora do padrão recusa o lote inteiro sem deixar arquivo', async () => {
    const sessionId = `${ID_CAMERA}-3002`;
    const formulario = new FormData();
    formulario.append('device_id', ID_CAMERA);
    formulario.append('session_id', sessionId);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    formulario.append('images', new Blob([jpeg], { type: 'image/jpeg' }), '0_0.jpg');
    formulario.append('images', new Blob([jpeg], { type: 'image/jpeg' }), 'frame.jpg');

    const resposta = await cliente.requisicao('POST', '/captura/upload-lote', {
      formulario,
      cabecalhos: cliente.cabecalhosDaCamera(chave),
    });

    assert.equal(resposta.status, 400);
    const restantes = fs.existsSync(pastaDaSessao(sessionId)) ? fs.readdirSync(pastaDaSessao(sessionId)) : [];
    assert.deepEqual(restantes, []);
  });
});
