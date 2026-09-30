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

const armazenamento = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.body.session_id;
    if (!sessionId) {
      return cb(erroHttp(400, 'Campo "session_id" ausente ou fora de ordem no multipart (tem que vir antes do "image").'));
    }
    if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
      return cb(erroHttp(403, 'session_id inválido para este dispositivo.'));
    }
    const pasta = path.join(FRAMES_DIR, sessionId);
    fs.mkdirSync(pasta, { recursive: true });
    cb(null, pasta);
  },
  filename: (req, file, cb) => cb(null, nomeDoFrame(req.body.frame_index, req.body.t_captura_ms)),
});

module.exports = multer({ storage: armazenamento });
