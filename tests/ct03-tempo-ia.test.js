// CT03 - Desempenho do pipeline de análise (RE04/RN16) com a IA real (YOLOv9).
// Ao encerrar a gravação o vídeo vai sozinho para a IA, e o laudo precisa ficar
// pronto em até 50% da duração do vídeo.
// Por padrão usa um vídeo sintético de 30 s. Para usar um vídeo de verdade:
//   TESTE_VIDEO=caminho/do/video.mp4
//   TESTE_VIDEO_AGRESSAO_S=12   (segundo em que a agressão encenada acontece)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const FRAMES_DO_VIDEO_SINTETICO = 60; // 60 frames a 2 fps = vídeo de 30 s
const TOLERANCIA_DA_MARCACAO_S = 5;
const caminhoDoVideo = process.env.TESTE_VIDEO;
const momentoDaAgressaoS = Number(process.env.TESTE_VIDEO_AGRESSAO_S);

describe('CT03 - tempo de resposta da IA real', () => {
  let ambiente;
  let cliente;
  let token;
  let laudo;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    const chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('ct03@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });

    const frames = caminhoDoVideo ? cliente.framesDoVideo(caminhoDoVideo) : undefined;
    const gravacao = await cliente.gravarEvidencia(token, chave, { quantidadeFrames: FRAMES_DO_VIDEO_SINTETICO, frames });
    const { dados } = await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}`, { token });
    laudo = dados.laudo;
  });
  after(() => ambiente?.encerrar());

  it('envia o vídeo para a IA sozinho e recebe o laudo', () => {
    assert.ok(laudo, 'o detalhe deveria trazer o laudo da IA');
  });

  it('disponibiliza o laudo dentro do prazo da RN16 (50% da duração)', (t) => {
    const prazoMs = laudo.duracao_video_segundos * 1000 * 0.5;
    t.diagnostic(`vídeo de ${laudo.duracao_video_segundos} s: análise em ${laudo.tempo_processamento_ms} ms (prazo ${prazoMs} ms)`);
    assert.ok(laudo.tempo_processamento_ms <= prazoMs, `${laudo.tempo_processamento_ms} ms > prazo de ${prazoMs} ms`);
    assert.equal(laudo.dentro_do_prazo_rn16, true);
  });

  it('o laudo traz marcações dentro do vídeo, a versão do modelo real e o hash', () => {
    assert.ok(Array.isArray(laudo.linha_do_tempo) && laudo.linha_do_tempo.length > 0);
    for (const trecho of [...laudo.linha_do_tempo, ...laudo.segmentos_criticos]) {
      assert.ok(trecho.inicio_s >= 0 && trecho.fim_s <= laudo.duracao_video_segundos + 0.01);
      assert.ok(trecho.inicio_s < trecho.fim_s);
    }
    assert.equal(laudo.algoritmo_versao, ambiente.versaoDoModelo);
    assert.match(laudo.hash_video_original, /^[0-9a-f]{64}$/);
  });

  it(
    'marca um trecho crítico perto do momento da agressão encenada (±5 s)',
    { skip: !caminhoDoVideo || Number.isNaN(momentoDaAgressaoS) ? 'defina TESTE_VIDEO e TESTE_VIDEO_AGRESSAO_S' : false },
    (t) => {
      const trechos = laudo.segmentos_criticos.map((trecho) => `${trecho.inicio_s}-${trecho.fim_s} s`);
      t.diagnostic(`trechos críticos: ${trechos.join(', ') || 'nenhum'}`);
      const encontrouOMomento = laudo.segmentos_criticos.some(
        (trecho) =>
          trecho.inicio_s - TOLERANCIA_DA_MARCACAO_S <= momentoDaAgressaoS &&
          momentoDaAgressaoS <= trecho.fim_s + TOLERANCIA_DA_MARCACAO_S
      );
      assert.ok(encontrouOMomento, `nenhum trecho crítico perto de ${momentoDaAgressaoS} s`);
    }
  );
});
