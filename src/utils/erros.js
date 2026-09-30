// Erro com status e mensagem que podem ir para o cliente (ver middleware/errorHandler).
function erroHttp(statusCode, mensagem) {
  return Object.assign(new Error(mensagem), { statusCode, publicMessage: mensagem });
}

module.exports = { erroHttp };
