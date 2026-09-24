const express = require('express');
const perfilController = require('../controllers/perfilController');
const autenticar = require('../middleware/autenticar');

const router = express.Router();
router.use(autenticar);

router.get('/', perfilController.obter);
router.put('/', perfilController.atualizar);
router.delete('/', perfilController.excluirConta);
router.post('/codigo', perfilController.enviarCodigo);
router.post('/dispositivo', perfilController.vincularDispositivo);

module.exports = router;
