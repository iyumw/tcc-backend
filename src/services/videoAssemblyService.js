const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const INTERVALO_PADRAO_MS = 300;
const DURACAO_MIN_MS = 10;
const DURACAO_MAX_MS = 5000;
const PADRAO_NOME = /^frame_(\d+)(?:_t(\d+))?\.jpg$/;

function lerFrames(pastaFrames) {
  return fs
    .readdirSync(pastaFrames)
    .map((nome) => {
      const m = PADRAO_NOME.exec(nome);
      if (!m) return null;
      return {
        nome,
        indice: Number(m[1]),
        tMs: m[2] !== undefined ? Number(m[2]) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.indice - b.indice);
}

function calcularDuracoes(frames) {
  const intervalos = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const atual = frames[i].tMs;
    const proximo = frames[i + 1].tMs;
    if (atual !== null && proximo !== null && proximo > atual) {
      intervalos.push(proximo - atual);
    } else {
      intervalos.push(null);
    }
  }

  const conhecidos = intervalos.filter((v) => v !== null).sort((a, b) => a - b);
  const mediana = conhecidos.length ? conhecidos[Math.floor(conhecidos.length / 2)] : INTERVALO_PADRAO_MS;
  intervalos.push(mediana);

  return intervalos.map((ms) => {
    const valor = ms === null ? mediana : ms;
    return Math.min(Math.max(valor, DURACAO_MIN_MS), DURACAO_MAX_MS) / 1000;
  });
}

function montarVideoAPartirDeFrames(pastaFrames, caminhoSaida) {
  return new Promise((resolve, reject) => {
    const frames = lerFrames(pastaFrames);

    if (frames.length === 0) {
      return reject(new Error(`Nenhum frame encontrado em ${pastaFrames}.`));
    }

    const duracoes = calcularDuracoes(frames);
    const duracaoSegundos = Math.round(duracoes.reduce((soma, d) => soma + d, 0) * 1000) / 1000;

    const linhas = [];
    frames.forEach((frame, i) => {
      linhas.push(`file '${frame.nome}'`);
      linhas.push(`duration ${duracoes[i].toFixed(3)}`);
    });

    linhas.push(`file '${frames[frames.length - 1].nome}'`);

    const listaFrames = path.join(pastaFrames, 'frames.txt');
    fs.writeFileSync(listaFrames, linhas.join('\n'));

    ffmpeg()
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
      .output(caminhoSaida)
      .on('end', () => resolve({ caminhoSaida, duracaoSegundos }))
      .on('error', (erro) => reject(erro))
      .run();
  });
}

module.exports = {
  montarVideoAPartirDeFrames,
  calcularDuracoes,
  lerFrames,
};
