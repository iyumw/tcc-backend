const multer = require('multer');

function errorHandler(erro, req, res, next) {
  console.error('[ErrorHandler]', erro);

  // Erros do multer (ex.: mais arquivos que o limite do lote) são culpa do envio, não do servidor.
  const ehErroDeUpload = erro instanceof multer.MulterError;
  const statusCode = erro.statusCode || (ehErroDeUpload ? 400 : 500);
  res.status(statusCode).json({
    erro: erro.publicMessage || (ehErroDeUpload ? `Upload inválido: ${erro.message}` : 'Erro interno no servidor.'),
  });
}

module.exports = errorHandler;
