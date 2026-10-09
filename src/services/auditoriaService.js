const db = require('../config/db');

function ipDa(req) {
  return req ? req.ip || (req.socket && req.socket.remoteAddress) || null : null;
}

// `cliente` permite gravar o log dentro da mesma transação da ação auditada.
async function inserir(acao, { idVitima = null, detalhes = {}, req = null, cliente = db } = {}) {
  await cliente.query(
    `INSERT INTO log_auditoria (id_vitima, acao, detalhes, ip) VALUES ($1, $2, $3, $4)`,
    [idVitima, acao, JSON.stringify(detalhes), ipDa(req)]
  );
}

// Para ações de custódia (acesso, integridade, exclusão): sem o registro, a ação falha.
async function registrarObrigatorio(acao, opcoes) {
  await inserir(acao, opcoes);
}

// Para eventos informativos (login, cadastro): uma falha no log não derruba a requisição.
async function registrar(acao, opcoes) {
  try {
    await inserir(acao, opcoes);
  } catch (erro) {
    console.error(`[Auditoria] Falha ao registrar "${acao}":`, erro.message);
  }
}

module.exports = { registrar, registrarObrigatorio };
