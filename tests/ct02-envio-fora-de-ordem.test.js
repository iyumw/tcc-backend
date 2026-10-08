// CT02 - Failover offline (RE02/RN05), parte do backend: frames que chegam
// atrasados e fora de ordem (como os reenviados do cartão SD depois que a rede
// volta) entram no vídeo na ordem certa, e o vídeo final fica íntegro (SHA-256).
// A queda do Wi-Fi e o buffer no microSD são testados à mão na câmera.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const INTERVALO_ENTRE_FRAMES_S = 0.5;

describe('CT02 - frames reenviados depois de queda de rede (backend)', () => {
  let ambiente;
  let cliente;
  let token;
  let chave;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('ct02@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
  });
  after(() => ambiente?.encerrar());

  it('monta o vídeo completo e íntegro com frames chegando fora de ordem', async () => {
    const sessionId = `${ID_CAMERA}-2001`;
    const ordemDeChegada = [0, 1, 4, 5, 2, 3]; // 2 e 3 "ficaram no SD" e chegaram depois

    for (const indice of ordemDeChegada) {
      const resposta = await cliente.enviarFrame(chave, sessionId, indice);
      assert.equal(resposta.status, 201, `frame ${indice} deveria ser aceito`);
    }
    const encerramento = await cliente.encerrarSessao(chave, sessionId);
    assert.equal(encerramento.status, 202);

    const gravacao = await cliente.aguardarGravacao(token, (item) => item.status_analise === 'Concluido');
    const duracaoEsperada = ordemDeChegada.length * INTERVALO_ENTRE_FRAMES_S;
    assert.ok(
      Math.abs(gravacao.duracao_segundos - duracaoEsperada) < 0.2,
      `duração ${gravacao.duracao_segundos}s deveria ser ~${duracaoEsperada}s (todos os frames no vídeo)`
    );

    const integridade = await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}/integridade`, { token });
    assert.equal(integridade.status, 200);
    assert.equal(integridade.dados.integro, true);
    assert.match(integridade.dados.hash_esperado, /^[0-9a-f]{64}$/);
  });
});
