const express = require('express');
const perfilController = require('../controllers/perfilController');
const autenticar = require('../middleware/autenticar');
const { limitarTaxa } = require('../middleware/limitarTaxa');

const router = express.Router();
router.use(autenticar);

const limiteEnvioDeCodigo = limitarTaxa({ nome: 'perfil_codigo', maximo: 5, janelaMin: 15 });

router.get('/', perfilController.obter);
router.put('/', perfilController.atualizar);
router.delete('/', perfilController.excluirConta);
router.post('/codigo', limiteEnvioDeCodigo, perfilController.enviarCodigo);
router.post('/dispositivo', perfilController.vincularDispositivo);

module.exports = router;
