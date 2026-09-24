const db = require('../config/db');
const storage = require('./storageService');

async function buscarDaUsuaria(idGravacao, idVitima) {
  const { rows } = await db.query(
    `SELECT g.*, a.id_vitima, a.id_device, a.data_hora
       FROM gravacao g
       JOIN acionamento a ON a.id_acionamento = g.id_acionamento
      WHERE g.id_gravacao = $1`,
    [idGravacao]
  );
  if (!rows.length) return { status: 404 };
  if (rows[0].id_vitima !== idVitima) return { status: 403 };
  return { gravacao: rows[0] };
}

async function apagarArquivos(urls) {
  const falhas = [];
  for (const url of urls) {
    const r = await storage.apagar(url);
    if (!r.apagado) falhas.push({ arquivo: url, motivo: r.motivo });
  }
  return falhas;
}

module.exports = { buscarDaUsuaria, apagarArquivos };
