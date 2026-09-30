const { EventEmitter } = require('events');
const db = require('../config/db');
const { numeroOuNulo } = require('../utils/validacao');

const emissor = new EventEmitter();
emissor.setMaxListeners(0);

function canalDa(idVitima) {
  return `vitima:${idVitima}`;
}

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
    const gravacao = rows[0];
    if (!gravacao || gravacao.id_vitima === null) return;
    emissor.emit(canalDa(gravacao.id_vitima), {
      tipo: 'status_analise',
      id_gravacao: gravacao.id_gravacao,
      status_analise: gravacao.status_analise,
      veredicto: gravacao.veredicto,
      score: numeroOuNulo(gravacao.score),
    });
  } catch (erro) {
    console.error('[Eventos] Falha ao notificar status:', erro.message);
  }
}

function assinar(idVitima, aoReceber) {
  const canal = canalDa(idVitima);
  emissor.on(canal, aoReceber);
  return () => emissor.off(canal, aoReceber);
}

module.exports = { notificarStatus, assinar };
