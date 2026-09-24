const db = require('../config/db');

async function registrar(acao, { idVitima = null, detalhes = {}, req = null } = {}) {
  try {
    const ip = req ? (req.ip || (req.socket && req.socket.remoteAddress) || null) : null;
    await db.query(
      `INSERT INTO log_auditoria (id_vitima, acao, detalhes, ip) VALUES ($1, $2, $3, $4)`,
      [idVitima, acao, JSON.stringify(detalhes), ip]
    );
  } catch (erro) {
    console.error(`[Auditoria] Falha ao registrar "${acao}":`, erro.message);
  }
}

module.exports = { registrar };
