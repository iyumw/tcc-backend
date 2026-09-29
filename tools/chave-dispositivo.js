// Gera (ou troca) a chave secreta de um dispositivo e grava o hash no banco.
// Uso, na pasta backend:
//   npm run chave-dispositivo -- esp32cam-01
// A chave aparece UMA vez no terminal: copie para o DEVICE_KEY do firmware.
// Rodar de novo gera uma chave nova e a antiga para de funcionar.
require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/config/db');
const { hashChave } = require('../src/middleware/autenticarDispositivo');

async function main() {
  const id = process.argv[2];
  if (!id || !/^[A-Za-z0-9_-]{1,50}$/.test(id)) {
    console.error('Uso: npm run chave-dispositivo -- <id_dispositivo>   (ex.: esp32cam-01)');
    process.exitCode = 1;
    return;
  }

  const chave = crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO dispositivo (id_dispositivo, status_bateria, chave_hash)
     VALUES ($1, 100, $2)
     ON CONFLICT (id_dispositivo) DO UPDATE SET chave_hash = EXCLUDED.chave_hash
     RETURNING (xmax = 0) AS novo`,
    [id, hashChave(chave)]
  );

  console.log(`\nDispositivo "${id}" ${rows[0].novo ? 'cadastrado' : 'atualizado'}.`);
  console.log('Cole esta linha no firmware da câmera (esp32cam.ino) e grave de novo:\n');
  console.log(`  #define DEVICE_KEY "${chave}"\n`);
  console.log('A chave não fica salva em lugar nenhum além do firmware. Se perder, gere outra.\n');
}

main()
  .catch((erro) => {
    console.error('Erro:', erro.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
