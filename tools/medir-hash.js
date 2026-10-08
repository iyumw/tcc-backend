// Mede o tempo do SHA-256 (o mesmo código da verificação de integridade) para
// arquivos de 1 a 50 MB. Uso: node tools/medir-hash.js
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { calcularHashSHA256 } = require('../src/services/custodiaService');

const TAMANHOS_MB = [1, 5, 10, 20, 50];
const REPETICOES = 15;
const BYTES_POR_MB = 1024 * 1024;

function mediana(valores) {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.floor(ordenados.length / 2)];
}

async function medir(tamanhoMb) {
  const arquivo = path.join(os.tmpdir(), `hash-${tamanhoMb}mb.bin`);
  fs.writeFileSync(arquivo, crypto.randomBytes(tamanhoMb * BYTES_POR_MB));
  await calcularHashSHA256(arquivo); // aquece o cache de disco
  const tempos = [];
  for (let i = 0; i < REPETICOES; i++) {
    const inicio = process.hrtime.bigint();
    await calcularHashSHA256(arquivo);
    tempos.push(Number(process.hrtime.bigint() - inicio) / 1e6);
  }
  fs.rmSync(arquivo);
  return mediana(tempos);
}

(async () => {
  console.log(`CPU: ${os.cpus()[0].model} | Node ${process.version}`);
  console.log('tamanho_mb;mediana_ms');
  for (const tamanho of TAMANHOS_MB) {
    console.log(`${tamanho};${(await medir(tamanho)).toFixed(2)}`);
  }
})();
