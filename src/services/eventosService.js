const { EventEmitter } = require('events');
const db = require('../config/db');

const emissor = new EventEmitter();
emissor.setMaxListeners(0);

async function notificarStatus(idGravacao) {
  try {
    const { rows } = await db.query(
      `SELECT g.id_gravacao, g.status_analise, a.id_vitima, ia.veredicto, ia.score
         FROM gravacao g
         JOIN acionamento a ON a.id_acionamento = g.id_acionamento
         LEFT JOIN analise_ia ia ON ia.id_gravacao = g.id_gravacao
        WHERE g.id_gravacao = $1`,
      [idGravacao]
    );
    const r = rows[0];
    if (!r || r.id_vitima === null) return;
    emissor.emit(`vitima:${r.id_vitima}`, {
      tipo: 'status_analise',
      id_gravacao: r.id_gravacao,
      status_analise: r.status_analise,
      veredicto: r.veredicto,
      score: r.score !== null ? Number(r.score) : null,
    });
  } catch (erro) {
    console.error('[Eventos] Falha ao notificar status:', erro.message);
  }
}

function assinar(idVitima, callback) {
  const canal = `vitima:${idVitima}`;
  emissor.on(canal, callback);
  return () => emissor.off(canal, callback);
}

module.exports = { notificarStatus, assinar };
