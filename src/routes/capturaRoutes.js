const express = require('express');
const capturaController = require('../controllers/capturaController');
const { uploadFrame, uploadLote, MAX_FRAMES_POR_LOTE } = require('../config/uploadFrame');
const { autenticarDispositivo } = require('../middleware/autenticarDispositivo');

const router = express.Router();

// Antes do upload, para nenhum arquivo ser gravado sem a chave do dispositivo.
router.use(autenticarDispositivo);

router.post('/upload', uploadFrame.single('image'), capturaController.receberFrame);
router.post('/upload-lote', uploadLote.array('images', MAX_FRAMES_POR_LOTE), capturaController.receberLote);
router.post('/sessao/encerrar', capturaController.encerrarSessao);

module.exports = router;
