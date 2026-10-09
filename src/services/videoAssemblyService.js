const fs = require('fs/promises');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const INTERVALO_PADRAO_MS = 300;
const DURACAO_MIN_MS = 10;
const DURACAO_MAX_MS = 5000;
const PADRAO_NOME = /^frame_(\d+)(?:_t(\d+))?\.jpg$/;
// O ffmpeg usa bastante CPU e memória: poucas montagens ao mesmo tempo, cada uma com prazo.
const MAX_MONTAGENS_SIMULTANEAS = 2;
const TIMEOUT_MONTAGEM_MS = 5 * 60 * 1000;

let montagensEmAndamento = 0;
const filaDeEspera = [];

async function comVagaParaMontar(tarefa) {
  if (montagensEmAndamento >= MAX_MONTAGENS_SIMULTANEAS) {
    await new Promise((liberar) => filaDeEspera.push(liberar));
  }
  montagensEmAndamento += 1;
  try {
    return await tarefa();
  } finally {
    montagensEmAndamento -= 1;
    const proxima = filaDeEspera.shift();
    if (proxima) proxima();
  }
}

async function lerFrames(pastaFrames) {
  return (await fs.readdir(pastaFrames))
    .map((nome) => {
      const partes = PADRAO_NOME.exec(nome);
      if (!partes) return null;
      return {
        nome,
        indice: Number(partes[1]),
        tempoCapturaMs: partes[2] !== undefined ? Number(partes[2]) : null,
      };
    })
    .filter(Boolean)
    .sort((frameA, frameB) => frameA.indice - frameB.indice);
}

// Cada frame dura até a captura do próximo, para o vídeo sair na velocidade real.
function calcularDuracoes(frames) {
  const intervalos = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const atual = frames[i].tempoCapturaMs;
    const proximo = frames[i + 1].tempoCapturaMs;
    if (atual !== null && proximo !== null && proximo > atual) {
      intervalos.push(proximo - atual);
    } else {
      intervalos.push(null);
    }
  }

  const conhecidos = intervalos.filter((intervalo) => intervalo !== null).sort((menor, maior) => menor - maior);
  const mediana = conhecidos.length ? conhecidos[Math.floor(conhecidos.length / 2)] : INTERVALO_PADRAO_MS;
  intervalos.push(mediana);

  return intervalos.map((intervaloMs) => {
    const valor = intervaloMs === null ? mediana : intervaloMs;
    return Math.min(Math.max(valor, DURACAO_MIN_MS), DURACAO_MAX_MS) / 1000;
  });
}

// Lista explícita (concat demuxer) porque a numeração pode ter buracos e o
// "-pattern_type glob" não funciona no ffmpeg do Windows.
function montarListaDeFrames(frames, duracoes) {
  const linhas = frames.flatMap((frame, i) => [`file '${frame.nome}'`, `duration ${duracoes[i].toFixed(3)}`]);
  // O concat ignora a duração do último arquivo se ele não for repetido no fim.
  linhas.push(`file '${frames[frames.length - 1].nome}'`);
  return linhas.join('\n');
}

function codificarVideo(listaFrames, caminhoSaida) {
  return new Promise((resolve, reject) => {
    const comando = ffmpeg()
      .input(listaFrames)
      .inputOptions(['-f concat', '-safe 0'])
      .videoCodec('libx264')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-vsync vfr',
        '-crf 18',
        '-preset medium',
        '-movflags +faststart',
      ])
      .output(caminhoSaida);

    const prazo = setTimeout(() => {
      comando.kill('SIGKILL');
      reject(new Error(`Montagem do vídeo passou de ${TIMEOUT_MONTAGEM_MS / 1000} s e foi interrompida.`));
    }, TIMEOUT_MONTAGEM_MS);

    comando
      .on('end', () => {
        clearTimeout(prazo);
        resolve();
      })
      .on('error', (erro) => {
        clearTimeout(prazo);
        reject(erro);
      })
      .run();
  });
}

async function montarVideoAPartirDeFrames(pastaFrames, caminhoSaida) {
  const frames = await lerFrames(pastaFrames);
  if (frames.length === 0) throw new Error(`Nenhum frame encontrado em ${pastaFrames}.`);

  const duracoes = calcularDuracoes(frames);
  const duracaoSegundos = Math.round(duracoes.reduce((soma, duracao) => soma + duracao, 0) * 1000) / 1000;

  const listaFrames = path.join(pastaFrames, 'frames.txt');
  await fs.writeFile(listaFrames, montarListaDeFrames(frames, duracoes));
  await comVagaParaMontar(() => codificarVideo(listaFrames, caminhoSaida));

  return { caminhoSaida, duracaoSegundos };
}

module.exports = {
  montarVideoAPartirDeFrames,
  calcularDuracoes,
  lerFrames,
};
