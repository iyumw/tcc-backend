const express = require('express');
const capturaController = require('../controllers/capturaController');
const { frameUnico, loteDeFrames } = require('../config/uploadFrame');
const { autenticarDispositivo } = require('../middleware/autenticarDispositivo');

const router = express.Router();

// Antes do upload, para nenhum arquivo ser gravado sem a chave do dispositivo.
router.use(autenticarDispositivo);

router.post('/sessao/abrir', capturaController.abrirSessao);
router.post('/upload', frameUnico.single('image'), capturaController.receberFrame);
router.post('/lote', loteDeFrames.array('images'), capturaController.receberLote);
router.post('/sessao/encerrar', capturaController.encerrarSessao);

module.exports = router;
