const express = require('express');
const authController = require('../controllers/authController');
const autenticar = require('../middleware/autenticar');
const { limitarTaxa } = require('../middleware/limitarTaxa');

const router = express.Router();

const limiteCadastro = limitarTaxa({ nome: 'cadastro', maximo: 10, janelaMin: 60 });
const limiteLogin = limitarTaxa({ nome: 'login', maximo: 10, janelaMin: 15, porEmail: true });
const limiteMfa = limitarTaxa({ nome: 'mfa', maximo: 10, janelaMin: 15 });
const limiteReenvio = limitarTaxa({ nome: 'mfa_reenvio', maximo: 5, janelaMin: 15 });
const limiteEsqueci = limitarTaxa({ nome: 'senha_esqueci', maximo: 5, janelaMin: 15, porEmail: true });
const limiteRedefinir = limitarTaxa({ nome: 'senha_redefinir', maximo: 10, janelaMin: 15, porEmail: true });

router.post('/cadastro', limiteCadastro, authController.cadastrar);
router.post('/login', limiteLogin, authController.login);
router.post('/mfa', limiteMfa, authController.verificarMfa);
router.post('/mfa/reenviar', limiteReenvio, authController.reenviarMfa);
router.post('/logout', autenticar, authController.logout);
router.post('/senha/esqueci', limiteEsqueci, authController.esqueciSenha);
router.post('/senha/redefinir', limiteRedefinir, authController.redefinirSenha);

module.exports = router;
