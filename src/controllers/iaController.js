const pipelineIA = require('../services/pipelineIAService');
const { lerIdPositivo } = require('../utils/validacao');

async function receberResultado(req, res, next) {
  try {
    const id = lerIdPositivo(req.params.id);
    if (id === null) return res.status(400).json({ erro: 'id_gravacao inválido.' });
    const { statusHttp, corpo } = await pipelineIA.registrarResultado(id, req.body || {});
    return res.status(statusHttp).json(corpo);
  } catch (erro) {
    next(erro);
  }
}

module.exports = { receberResultado };
