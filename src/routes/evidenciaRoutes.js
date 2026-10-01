const express = require('express');
const evidenciaController = require('../controllers/evidenciaController');
const autenticar = require('../middleware/autenticar');

const router = express.Router();

// O EventSource do navegador não manda cabeçalhos, então o SSE recebe o token na URL.
router.get('/eventos', autenticar.comQuery, evidenciaController.eventosSse);

// Sem login: protegido pela assinatura do link (ver storageService).
router.get('/:id/arquivo', evidenciaController.servirArquivoLocal);

router.use(autenticar);
router.get('/', evidenciaController.listar);
router.get('/:id', evidenciaController.detalhar);
router.get('/:id/url', evidenciaController.gerarUrl);
router.get('/:id/integridade', evidenciaController.verificarIntegridade);
router.get('/:id/laudo', evidenciaController.baixarLaudo);
router.get('/:id/laudo.pdf', evidenciaController.baixarLaudoPdf);
router.post('/:id/analise', evidenciaController.reprocessar);
router.delete('/:id', evidenciaController.excluir);

module.exports = router;
