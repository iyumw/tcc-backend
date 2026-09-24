const express = require('express');
const authController = require('../controllers/authController');
const autenticar = require('../middleware/autenticar');

const router = express.Router();

router.post('/cadastro', authController.cadastrar);
router.post('/login', authController.login);
router.post('/mfa', authController.verificarMfa);
router.post('/mfa/reenviar', authController.reenviarMfa);
router.post('/logout', autenticar, authController.logout);
router.post('/senha/esqueci', authController.esqueciSenha);
router.post('/senha/redefinir', authController.redefinirSenha);

module.exports = router;
