function errorHandler(erro, req, res, next) {
  console.error('[ErrorHandler]', erro);

  const statusCode = erro.statusCode || 500;
  res.status(statusCode).json({
    erro: erro.publicMessage || 'Erro interno no servidor.',
  });
}

module.exports = errorHandler;
