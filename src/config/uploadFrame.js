const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { FRAMES_DIR } = require('./paths');
const { sessaoPertenceAoDispositivo } = require('../middleware/autenticarDispositivo');
const { erroHttp } = require('../utils/erros');

function nomeDoFrame(frameIndex, tCapturaMs) {
  const indice = String(Number(frameIndex) || 0).padStart(6, '0');
  const tempo = Number(tCapturaMs);
  const sufixoTempo = Number.isInteger(tempo) && tempo >= 0 ? `_t${String(tempo).padStart(9, '0')}` : '';
  return `frame_${indice}${sufixoTempo}.jpg`;
}

// Lote: cada arquivo leva o próprio índice e tempo de captura no nome ("<indice>_<t_captura_ms>.jpg").
const LIMITE_FRAMES_POR_LOTE = 10;
const NOME_DO_ARQUIVO_NO_LOTE = /^(\d{1,6})_(\d{1,9})\.jpg$/;

function pastaDaSessao(req, file, cb) {
  const sessionId = req.body.session_id;
  if (!sessionId) {
    return cb(erroHttp(400, 'Campo "session_id" ausente ou fora de ordem no multipart (tem que vir antes das imagens).'));
  }
  if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
    return cb(erroHttp(403, 'session_id inválido para este dispositivo.'));
  }
  const pasta = path.join(FRAMES_DIR, sessionId);
  fs.mkdirSync(pasta, { recursive: true });
  cb(null, pasta);
}

const frameUnico = multer({
  storage: multer.diskStorage({
    destination: pastaDaSessao,
    filename: (req, file, cb) => cb(null, nomeDoFrame(req.body.frame_index, req.body.t_captura_ms)),
  }),
});

const loteDeFrames = multer({
  storage: multer.diskStorage({
    destination: pastaDaSessao,
    filename: (req, file, cb) => {
      const partes = NOME_DO_ARQUIVO_NO_LOTE.exec(file.originalname);
      if (!partes) return cb(erroHttp(400, `Nome de arquivo inválido no lote: "${file.originalname}".`));
      cb(null, nomeDoFrame(partes[1], partes[2]));
    },
  }),
  limits: { files: LIMITE_FRAMES_POR_LOTE },
});

module.exports = { frameUnico, loteDeFrames };
