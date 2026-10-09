const fs = require('fs');
const { Pool } = require('pg');
const { EM_PRODUCAO } = require('./segredos');

const MAX_CONEXOES = Number(process.env.DB_MAX_CONEXOES) || 10;
const OCIOSA_MS = 30000;
const TIMEOUT_CONEXAO_MS = 10000;
const TIMEOUT_CONSULTA_MS = 15000;

// O RDS exige SSL. Com DB_SSL_CA (certificado da AWS), o backend também confere
// que está falando com o RDS de verdade; em produção isso é obrigatório.
function configurarSsl() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_CA) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  }
  if (EM_PRODUCAO) throw new Error('DB_SSL_CA não definido. Em produção o certificado do banco precisa ser conferido.');
  console.warn('[DB] DB_SSL_CA não definido: conexão cifrada, mas sem conferir o certificado do servidor.');
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: configurarSsl(),
  max: MAX_CONEXOES,
  idleTimeoutMillis: OCIOSA_MS,
  connectionTimeoutMillis: TIMEOUT_CONEXAO_MS,
  statement_timeout: TIMEOUT_CONSULTA_MS,
});

pool.on('error', (erro) => {
  console.error('[DB] Erro inesperado em cliente ocioso do pool:', erro);
});

async function emTransacao(operacao) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await operacao(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}

module.exports = {
  query: (texto, parametros) => pool.query(texto, parametros),
  getClient: () => pool.connect(),
  emTransacao,
  pool,
};
