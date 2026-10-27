const multer = require('multer');

const ERROS_DO_UPLOAD = {
  LIMIT_FILE_SIZE: [413, 'Imagem maior que o permitido.'],
  LIMIT_FILE_COUNT: [400, 'Imagens demais nesta requisição.'],
  LIMIT_UNEXPECTED_FILE: [400, 'Campo de arquivo inesperado (use "image" no /upload e "images" no /upload-lote).'],
};

// Converte erros conhecidos (JSON malformado, upload fora do limite) em
// respostas 4xx; o resto vira 500 sem detalhes internos.
function traduzirErro(erro) {
  if (erro.publicMessage) {
    return { status: erro.statusCode || 500, erro: erro.publicMessage, codigo: erro.codigo || 'ERRO_DA_REQUISICAO' };
  }
  if (erro.type === 'entity.parse.failed') return { status: 400, erro: 'JSON inválido no corpo da requisição.', codigo: 'JSON_INVALIDO' };
  if (erro.type === 'entity.too.large') return { status: 413, erro: 'Corpo da requisição grande demais.', codigo: 'CORPO_GRANDE_DEMAIS' };
  if (erro instanceof multer.MulterError) {
    const [status, mensagem] = ERROS_DO_UPLOAD[erro.code] || [400, 'Upload inválido.'];
    return { status, erro: mensagem, codigo: erro.code };
  }
  return { status: 500, erro: 'Erro interno no servidor.', codigo: 'ERRO_INTERNO' };
}

function tratarErros(erro, req, res, next) {
  if (res.headersSent) return next(erro);

  const { status, erro: mensagem, codigo } = traduzirErro(erro);
  if (status >= 500) console.error('[Erro]', erro);
  return res.status(status).json({ erro: mensagem, codigo });
}

function rotaNaoEncontrada(req, res) {
  res.status(404).json({ erro: 'Rota não encontrada.', codigo: 'ROTA_NAO_ENCONTRADA' });
}

module.exports = { tratarErros, rotaNaoEncontrada };
