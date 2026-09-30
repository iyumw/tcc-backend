const express = require('express');
const iaController = require('../controllers/iaController');
const { autenticarCallback } = require('../services/pipelineIAService');

const router = express.Router();

router.post('/resultado/:id', autenticarCallback, iaController.receberResultado);

module.exports = router;
