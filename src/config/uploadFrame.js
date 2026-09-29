const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { FRAMES_DIR } = require('./paths');
const { sessaoPertenceAoDispositivo } = require('../middleware/autenticarDispositivo');

// Salva cada frame em uma pasta por sessão.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.body.session_id;
    if (!sessionId) {
      return cb(new Error('Campo "session_id" ausente ou fora de ordem no multipart.'));
    }
    if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
      return cb(Object.assign(new Error('session_id inválido para este dispositivo.'), {
        statusCode: 403,
        publicMessage: 'session_id inválido para este dispositivo.',
      }));
    }
    const pasta = path.join(FRAMES_DIR, sessionId);
    fs.mkdirSync(pasta, { recursive: true });
    cb(null, pasta);
  },
  filename: (req, file, cb) => {
    // Mantém o nome do frame ordenado por índice e timestamp.
    const frameIndex = Number(req.body.frame_index) || 0;
    const nomePadded = String(frameIndex).padStart(6, '0');
    const tCaptura = Number(req.body.t_captura_ms);
    const sufixoTempo =
      Number.isInteger(tCaptura) && tCaptura >= 0 ? `_t${String(tCaptura).padStart(9, '0')}` : '';

    cb(null, `frame_${nomePadded}${sufixoTempo}.jpg`);
  },
});

const uploadFrame = multer({ storage });

module.exports = uploadFrame;
