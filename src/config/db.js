const { Pool } = require('pg');

const usaSocketUnix = Boolean(process.env.DB_SOCKET_PATH);

const configuracaoPool = usaSocketUnix
  ? {
      host: process.env.DB_SOCKET_PATH,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

// Pool único do PostgreSQL; usa socket Unix em produção e TCP local em desenvolvimento.
const pool = new Pool(configuracaoPool);

pool.on('error', (erro) => {
  console.error('[DB] Erro inesperado em cliente ocioso do pool:', erro);
});

module.exports = {
  query: (texto, parametros) => pool.query(texto, parametros),
  getClient: () => pool.connect(),
  pool,
};