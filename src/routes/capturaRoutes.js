
const express = require('express');
const capturaController = require('../controllers/capturaController');
const uploadFrame = require('../config/uploadFrame');

const router = express.Router();

router.post('/sessao/abrir', capturaController.abrirSessao);
router.post('/upload', uploadFrame.single('image'), capturaController.receberFrame);
router.post('/sessao/encerrar', capturaController.encerrarSessao);

module.exports = router;
