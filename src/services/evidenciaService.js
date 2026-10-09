const db = require('../config/db');
const storage = require('./storageService');
const auditoria = require('./auditoriaService');

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

// Os arquivos são apagados depois do banco: um arquivo que sobrar fica
// registrado na auditoria para ser removido à mão, em vez de só no console.
async function apagarArquivosERegistrarFalhas(urls, { idVitima, req }) {
  const falhas = [];
  for (const url of urls) {
    const { apagado, motivo } = await storage.apagar(url);
    if (!apagado) falhas.push({ arquivo: url, motivo });
  }
  if (falhas.length) {
    console.warn(`[Evidencias] ${falhas.length} arquivo(s) não foram apagados:`, falhas);
    await auditoria.registrar('arquivo_nao_apagado', { idVitima, detalhes: { falhas }, req });
  }
  return falhas;
}

module.exports = { buscarDaUsuaria, apagarArquivosERegistrarFalhas };
