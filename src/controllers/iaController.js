const pipelineIA = require('../services/pipelineIAService');

async function receberResultado(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ erro: 'id_gravacao inválido.' });
    }
    const { statusHttp, corpo } = await pipelineIA.registrarResultado(id, req.body || {});
    return res.status(statusHttp).json(corpo);
  } catch (erro) {
    next(erro);
  }
}

module.exports = { receberResultado };
