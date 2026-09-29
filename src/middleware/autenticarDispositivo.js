const crypto = require('crypto');
const db = require('../config/db');

// Autentica a ESP32-CAM nas rotas /api/captura/*.
// Cada dispositivo tem uma chave secreta (gerada com "npm run chave-dispositivo");
// o banco guarda só o SHA-256 dela. A câmera manda os cabeçalhos:
//   X-Dispositivo-Id: esp32cam-01
//   X-Dispositivo-Chave: <chave>
function hashChave(chave) {
  return crypto.createHash('sha256').update(String(chave)).digest('hex');
}

async function autenticarDispositivo(req, res, next) {
  const id = req.get('x-dispositivo-id');
  const chave = req.get('x-dispositivo-chave');

  if (!id || !chave) {
    return res.status(401).json({ erro: 'Dispositivo não autenticado.', codigo: 'DISPOSITIVO_SEM_CHAVE' });
  }

  try {
    const { rows } = await db.query(
      'SELECT id_dispositivo, chave_hash FROM dispositivo WHERE id_dispositivo = $1',
      [id]
    );

    const esperado = rows.length && rows[0].chave_hash ? Buffer.from(rows[0].chave_hash.trim(), 'hex') : null;
    const recebido = Buffer.from(hashChave(chave), 'hex');

    // timingSafeEqual: não deixa o tempo de resposta revelar quanto da chave estava certo.
    if (!esperado || esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) {
      console.warn(`[Dispositivo] Chave inválida para "${id}" (IP ${req.ip}).`);
      return res.status(401).json({ erro: 'Dispositivo não autenticado.', codigo: 'DISPOSITIVO_CHAVE_INVALIDA' });
    }

    req.dispositivo = { id: rows[0].id_dispositivo };
    return next();
  } catch (erro) {
    return next(erro);
  }
}

// O session_id vira nome de pasta: só aceita letras, números, "-" e "_", e
// tem que começar com o id do próprio dispositivo (ex.: "esp32cam-01-123456").
// Assim uma câmera não escreve fora da pasta de frames nem na sessão de outra.
function sessaoPertenceAoDispositivo(sessionId, idDispositivo) {
  return (
    typeof sessionId === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(sessionId) &&
    sessionId.startsWith(`${idDispositivo}-`)
  );
}

module.exports = { autenticarDispositivo, hashChave, sessaoPertenceAoDispositivo };
