const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { FRAMES_DIR, VIDEOS_DIR } = require('../config/paths');
const { montarVideoAPartirDeFrames } = require('../services/videoAssemblyService');
const { calcularHashSHA256 } = require('../services/custodiaService');
const storage = require('../services/storageService');
const pipelineIA = require('../services/pipelineIAService');
const eventos = require('../services/eventosService');
const { sessaoPertenceAoDispositivo } = require('../middleware/autenticarDispositivo');

async function abrirSessao(req, res, next) {
  try {
    const idDispositivo = req.dispositivo.id;
    const { id_dispositivo: idInformado } = req.body || {};
    if (idInformado && idInformado !== idDispositivo) {
      return res.status(403).json({ erro: 'id_dispositivo diferente do dispositivo autenticado.' });
    }

    const { rows } = await db.query(
      `INSERT INTO acionamento (id_device, id_vitima)
       SELECT id_dispositivo, id_vitima FROM dispositivo WHERE id_dispositivo = $1
       RETURNING id_acionamento, data_hora`,
      [idDispositivo]
    );
    return res.status(201).json({ id_acionamento: rows[0].id_acionamento, data_hora_inicio: rows[0].data_hora });
  } catch (erro) {
    next(erro);
  }
}

// O SELECT evita gastar um id da sequência a cada frame; o ON CONFLICT cobre dois frames
// da mesma sessão nova chegando ao mesmo tempo.
async function criarSessaoSeNova(idDispositivo, sessionId) {
  const { rows } = await db.query('SELECT 1 FROM acionamento WHERE external_session_id = $1', [sessionId]);
  if (rows.length) return;
  await db.query(
    `INSERT INTO acionamento (id_device, external_session_id, id_vitima)
     SELECT id_dispositivo, $2, id_vitima FROM dispositivo WHERE id_dispositivo = $1
     ON CONFLICT (external_session_id) DO NOTHING`,
    [idDispositivo, sessionId]
  );
}

async function receberFrame(req, res, next) {
  try {
    const { device_id: idDispositivo, session_id: sessionId, frame_index: frameIndex } = req.body || {};
    if (!idDispositivo || !sessionId) {
      return res.status(400).json({ erro: 'Campos "device_id" e "session_id" são obrigatórios.' });
    }
    if (idDispositivo !== req.dispositivo.id) {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      return res.status(403).json({ erro: 'device_id diferente do dispositivo autenticado.' });
    }
    if (!req.file) return res.status(400).json({ erro: 'Campo "image" (arquivo) é obrigatório.' });

    await criarSessaoSeNova(idDispositivo, sessionId);
    return res.status(201).json({ recebido: true, frame_index: Number(frameIndex) || 0 });
  } catch (erro) {
    next(erro);
  }
}

async function encerrarSessao(req, res, next) {
  try {
    const { session_id: sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ erro: 'Campo "session_id" é obrigatório.' });
    if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
      return res.status(403).json({ erro: 'session_id inválido para este dispositivo.' });
    }

    const { rows } = await db.query(
      'SELECT id_acionamento FROM acionamento WHERE external_session_id = $1 AND id_device = $2',
      [sessionId, req.dispositivo.id]
    );
    if (!rows.length) {
      return res.status(404).json({
        erro: `Sessão "${sessionId}" não encontrada (nenhum frame foi recebido para ela?).`,
      });
    }

    const pastaFrames = path.join(FRAMES_DIR, sessionId);
    if (!fs.existsSync(pastaFrames) || fs.readdirSync(pastaFrames).length === 0) {
      return res.status(400).json({ erro: 'Nenhum frame encontrado pra essa sessão — nada para montar.' });
    }

    res.status(202).json({ session_id: sessionId, status: 'processando' });
    finalizarGravacao(rows[0].id_acionamento, sessionId, pastaFrames);
  } catch (erro) {
    next(erro);
  }
}

// Se falhar, os frames continuam na pasta e dá para encerrar a sessão de novo.
async function finalizarGravacao(idAcionamento, sessionId, pastaFrames) {
  try {
    const caminhoVideo = path.join(VIDEOS_DIR, `${sessionId}.mp4`);
    const { duracaoSegundos } = await montarVideoAPartirDeFrames(pastaFrames, caminhoVideo);
    const hash = await calcularHashSHA256(caminhoVideo);
    const urlStorage = await storage.salvarVideo(caminhoVideo, `${sessionId}.mp4`, { sha256: hash, sessionId });

    const { rows } = await db.query(
      `INSERT INTO gravacao (id_acionamento, url_storage, hash_seguranca, duracao_segundos)
       VALUES ($1, $2, $3, $4)
       RETURNING id_gravacao`,
      [idAcionamento, urlStorage, hash, duracaoSegundos]
    );
    const idGravacao = rows[0].id_gravacao;

    fs.rmSync(pastaFrames, { recursive: true, force: true });
    console.log(`[Captura] Sessão "${sessionId}" finalizada: gravacao ${idGravacao}, ${urlStorage}, SHA-256 ${hash}`);

    eventos.notificarStatus(idGravacao);
    pipelineIA.solicitarAnalise(idGravacao).catch((erro) =>
      console.error(`[Captura] Erro ao pedir a análise da gravação ${idGravacao}:`, erro)
    );
  } catch (erro) {
    console.error(`[Captura] Erro ao finalizar sessão "${sessionId}":`, erro);
  }
}

module.exports = {
  abrirSessao,
  receberFrame,
  encerrarSessao,
};
