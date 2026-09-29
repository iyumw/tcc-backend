const express = require('express');
const capturaController = require('../controllers/capturaController');
const uploadFrame = require('../config/uploadFrame');
const { autenticarDispositivo } = require('../middleware/autenticarDispositivo');

const router = express.Router();

// Todas as rotas da câmera exigem a chave do dispositivo (antes de gravar qualquer arquivo).
router.use(autenticarDispositivo);

router.post('/sessao/abrir', capturaController.abrirSessao);
router.post('/upload', uploadFrame.single('image'), capturaController.receberFrame);
router.post('/sessao/encerrar', capturaController.encerrarSessao);

module.exports = router;
