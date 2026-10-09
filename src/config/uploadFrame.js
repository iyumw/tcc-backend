const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const { FRAMES_DIR } = require('./paths');
const { sessaoPertenceAoDispositivo } = require('../middleware/autenticarDispositivo');
const { erroHttp } = require('../utils/erros');

// Um frame VGA da câmera tem ~20 KB; 2 MB dá folga até para resoluções maiores.
const TAMANHO_MAX_FRAME_BYTES = 2 * 1024 * 1024;
// ~1h20 de gravação a 4 fps: impede que uma chave vazada encha o disco.
const MAX_FRAMES_POR_SESSAO = 20000;

function nomeDoFrame(frameIndex, tCapturaMs) {
  const indice = String(Number(frameIndex) || 0).padStart(6, '0');
  const tempo = Number(tCapturaMs);
  const sufixoTempo = Number.isInteger(tempo) && tempo >= 0 ? `_t${String(tempo).padStart(9, '0')}` : '';
  return `frame_${indice}${sufixoTempo}.jpg`;
}

async function quantidadeDeFrames(pasta) {
  try {
    return (await fs.readdir(pasta)).length;
  } catch {
    return 0;
  }
}

async function prepararPastaDaSessao(req) {
  const sessionId = req.body.session_id;
  if (!sessionId) {
    throw erroHttp(400, 'Campo "session_id" ausente ou fora de ordem no multipart (tem que vir antes do "image").');
  }
  if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
    throw erroHttp(403, 'session_id inválido para este dispositivo.');
  }
  const pasta = path.join(FRAMES_DIR, sessionId);
  if ((await quantidadeDeFrames(pasta)) >= MAX_FRAMES_POR_SESSAO) {
    throw erroHttp(413, `Limite de ${MAX_FRAMES_POR_SESSAO} frames por sessão atingido.`);
  }
  await fs.mkdir(pasta, { recursive: true });
  return pasta;
}

const armazenamento = multer.diskStorage({
  destination: (req, file, cb) => {
    prepararPastaDaSessao(req).then((pasta) => cb(null, pasta), cb);
  },
  filename: (req, file, cb) => cb(null, nomeDoFrame(req.body.frame_index, req.body.t_captura_ms)),
});

function somenteJpeg(req, file, cb) {
  if (file.mimetype === 'image/jpeg') return cb(null, true);
  return cb(erroHttp(415, 'A imagem precisa ser JPEG (Content-Type: image/jpeg).'));
}

module.exports = multer({
  storage: armazenamento,
  fileFilter: somenteJpeg,
  limits: { fileSize: TAMANHO_MAX_FRAME_BYTES, files: 1, fields: 10, fieldSize: 1024 },
});
