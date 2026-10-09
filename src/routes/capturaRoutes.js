const express = require('express');
const capturaController = require('../controllers/capturaController');
const uploadFrame = require('../config/uploadFrame');
const { autenticarDispositivo } = require('../middleware/autenticarDispositivo');

const router = express.Router();

// Antes do upload, para nenhum arquivo ser gravado sem a chave do dispositivo.
router.use(autenticarDispositivo);

router.post('/upload', uploadFrame.single('image'), capturaController.receberFrame);
router.post('/sessao/encerrar', capturaController.encerrarSessao);

module.exports = router;
