const fs = require('fs');
const crypto = require('crypto');

function calcularHashDeStream(leitura) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    leitura.on('data', (pedaco) => hash.update(pedaco));
    leitura.on('end', () => resolve(hash.digest('hex')));
    leitura.on('error', reject);
  });
}

function calcularHashSHA256(caminhoArquivo) {
  return calcularHashDeStream(fs.createReadStream(caminhoArquivo));
}

module.exports = {
  calcularHashSHA256,
  calcularHashDeStream,
};
