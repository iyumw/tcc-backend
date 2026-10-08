// CT04 - Integridade da prova via SHA-256 (RN05) e log imutável (RN06).
// Altera 1 byte na posição 1024 do vídeo guardado (por fora do sistema) e
// confere que a verificação acusa a adulteração; depois restaura o byte.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const POSICAO_ADULTERADA = 1024;
const TEMPO_MAXIMO_VERIFICACAO_MS = 500;

describe('CT04 - integridade da prova via hash SHA-256', () => {
  let ambiente;
  let cliente;
  let token;
  let gravacao;
  let caminhoDoVideo;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    const chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('ct04@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
    gravacao = await cliente.gravarEvidencia(token, chave, { sessionId: `${ID_CAMERA}-4001` });
    caminhoDoVideo = path.join(ambiente.pastaTmp, 'videos', `${ID_CAMERA}-4001.mp4`);
  });
  after(() => ambiente?.encerrar());

  const verificar = () => cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}/integridade`, { token });

  it('arquivo original é validado como íntegro', async () => {
    const { status, dados } = await verificar();

    assert.equal(status, 200);
    assert.equal(dados.integro, true);
    assert.equal(dados.hash_calculado, dados.hash_esperado);
  });

  it('detecta 1 byte alterado, mostra hash esperado x calculado, em até 500 ms', async (t) => {
    const video = fs.readFileSync(caminhoDoVideo);
    const byteOriginal = video[POSICAO_ADULTERADA];
    video[POSICAO_ADULTERADA] = byteOriginal ^ 0xff;
    fs.writeFileSync(caminhoDoVideo, video);

    const { status, dados, tempoMs } = await verificar();

    assert.equal(status, 409);
    assert.equal(dados.integro, false);
    assert.equal(dados.id_gravacao, gravacao.id_gravacao);
    assert.notEqual(dados.hash_calculado, dados.hash_esperado);
    assert.ok(tempoMs < TEMPO_MAXIMO_VERIFICACAO_MS, `resposta levou ${tempoMs.toFixed(0)} ms`);
    t.diagnostic(`adulteração detectada em ${tempoMs.toFixed(1)} ms (hash: ${dados.tempo_verificacao_ms} ms)`);

    video[POSICAO_ADULTERADA] = byteOriginal;
    fs.writeFileSync(caminhoDoVideo, video);
  });

  it('volta a validar como íntegro depois de restaurar o byte original', async () => {
    const { status, dados } = await verificar();

    assert.equal(status, 200);
    assert.equal(dados.integro, true);
  });

  it('o log de auditoria não aceita alteração nem exclusão (imutável)', async () => {
    const { rows: antes } = await ambiente.banco.query('SELECT * FROM log_auditoria ORDER BY id_log');
    assert.ok(antes.length > 0);

    await assert.rejects(
      ambiente.banco.query("UPDATE log_auditoria SET acao = 'adulterado' WHERE id_log = $1", [antes[0].id_log]),
      /imutável/
    );
    await assert.rejects(ambiente.banco.query('DELETE FROM log_auditoria WHERE id_log = $1', [antes[0].id_log]), /imutável/);

    const { rows: depois } = await ambiente.banco.query('SELECT * FROM log_auditoria WHERE id_log <= $1 ORDER BY id_log', [
      antes[antes.length - 1].id_log,
    ]);
    assert.deepEqual(depois, antes);
  });

  it('cada verificação fica registrada na auditoria com o resultado', async () => {
    const { rows } = await ambiente.banco.query(
      "SELECT detalhes->>'integro' AS integro FROM log_auditoria WHERE acao = 'verificacao_integridade' ORDER BY id_log"
    );

    assert.deepEqual(
      rows.map((linha) => linha.integro),
      ['true', 'false', 'true']
    );
  });
});
