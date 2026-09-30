const fs = require('fs');
const { Pool } = require('pg');

// O RDS exige SSL. Com DB_SSL_CA (certificado da AWS), o backend também confere
// que está falando com o RDS de verdade.
function configurarSsl() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_CA) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  }
  console.warn('[DB] DB_SSL_CA não definido: conexão cifrada, mas sem conferir o certificado do servidor.');
  return { rejectUnauthorized: false };
}

const configuracaoPool = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: configurarSsl(),
};

const pool = new Pool(configuracaoPool);

pool.on('error', (erro) => {
  console.error('[DB] Erro inesperado em cliente ocioso do pool:', erro);
});

module.exports = {
  query: (texto, parametros) => pool.query(texto, parametros),
  getClient: () => pool.connect(),
  pool,
};