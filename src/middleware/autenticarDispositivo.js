// O banco guarda só o SHA-256 da chave de cada dispositivo (gerada com "npm run chave-dispositivo").
const crypto = require('crypto');
const db = require('../config/db');

const NAO_AUTENTICADO = 'Dispositivo não autenticado.';

function hashChave(chave) {
  return crypto.createHash('sha256').update(String(chave)).digest('hex');
}

// timingSafeEqual: o tempo de resposta não revela quanto da chave estava certo.
function chaveConfere(chave, chaveHash) {
  if (!chaveHash) return false;
  const esperado = Buffer.from(chaveHash.trim(), 'hex');
  const recebido = Buffer.from(hashChave(chave), 'hex');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

async function autenticarDispositivo(req, res, next) {
  const id = req.get('x-dispositivo-id');
  const chave = req.get('x-dispositivo-chave');

  if (!id || !chave) {
    return res.status(401).json({ erro: NAO_AUTENTICADO, codigo: 'DISPOSITIVO_SEM_CHAVE' });
  }

  try {
    const { rows } = await db.query(
      'SELECT id_dispositivo, chave_hash FROM dispositivo WHERE id_dispositivo = $1',
      [id]
    );

    if (!rows.length || !chaveConfere(chave, rows[0].chave_hash)) {
      console.warn(`[Dispositivo] Chave inválida para "${id}" (IP ${req.ip}).`);
      return res.status(401).json({ erro: NAO_AUTENTICADO, codigo: 'DISPOSITIVO_CHAVE_INVALIDA' });
    }

    req.dispositivo = { id: rows[0].id_dispositivo };
    return next();
  } catch (erro) {
    return next(erro);
  }
}

// O session_id vira nome de pasta: o formato restrito e o prefixo do dispositivo impedem
// que uma câmera escreva fora da pasta de frames ou na sessão de outra.
function sessaoPertenceAoDispositivo(sessionId, idDispositivo) {
  return (
    typeof sessionId === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(sessionId) &&
    sessionId.startsWith(`${idDispositivo}-`)
  );
}

module.exports = { autenticarDispositivo, hashChave, sessaoPertenceAoDispositivo };
