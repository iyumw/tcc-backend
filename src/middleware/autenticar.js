const authService = require('../services/authService');

function extrairToken(req, aceitarQuery) {
  const cabecalho = req.get('authorization') || '';
  if (cabecalho.startsWith('Bearer ')) return cabecalho.slice(7);
  if (aceitarQuery && req.query.token) return String(req.query.token);
  return null;
}

function criar({ aceitarQuery = false } = {}) {
  return async function autenticar(req, res, next) {
    try {
      const token = extrairToken(req, aceitarQuery);
      if (!token) {
        return res.status(401).json({ erro: 'Faça login para continuar.', codigo: 'SEM_TOKEN' });
      }
      const sessao = await authService.validarSessao(token);
      if (sessao.erro) {
        return res.status(401).json({ erro: sessao.erro, codigo: sessao.codigo });
      }
      req.usuario = { idVitima: sessao.idVitima, idSessao: sessao.idSessao };
      next();
    } catch (erro) {
      next(erro);
    }
  };
}

module.exports = criar();
module.exports.comQuery = criar({ aceitarQuery: true });
