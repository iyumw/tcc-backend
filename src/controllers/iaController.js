const pipelineIA = require('../services/pipelineIAService');
const { lerIdPositivo } = require('../utils/validacao');
const { envolverControladores } = require('../utils/comTratamentoDeErros');

async function receberResultado(req, res) {
  const id = lerIdPositivo(req.params.id);
  if (id === null) return res.status(400).json({ erro: 'id_gravacao inválido.' });
  const { statusHttp, corpo } = await pipelineIA.registrarResultado(id, req.body || {});
  return res.status(statusHttp).json(corpo);
}

module.exports = envolverControladores({ receberResultado });
