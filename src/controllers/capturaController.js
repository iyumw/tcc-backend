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

async function abrirSessao(req, res) {
  // O dispositivo é o autenticado pela chave; o corpo, se vier, tem que bater.
  const id_dispositivo = req.dispositivo.id;
  if (req.body.id_dispositivo && req.body.id_dispositivo !== id_dispositivo) {
    return res.status(403).json({ erro: 'id_dispositivo diferente do dispositivo autenticado.' });
  }

  try {
    const dispositivo = await db.query(
      'SELECT id_dispositivo FROM dispositivo WHERE id_dispositivo = $1',
      [id_dispositivo]
    );

    if (dispositivo.rows.length === 0) {
      return res.status(404).json({
        erro: `Dispositivo "${id_dispositivo}" não encontrado.`,
      });
    }

    const resultado = await db.query(
      `INSERT INTO acionamento (id_device, id_vitima)
       SELECT id_dispositivo, id_vitima FROM dispositivo WHERE id_dispositivo = $1
       RETURNING id_acionamento, data_hora`,
      [id_dispositivo]
    );

    const sessao = resultado.rows[0];

    return res.status(201).json({
      id_acionamento: sessao.id_acionamento,
      data_hora_inicio: sessao.data_hora,
    });
  } catch (erro) {
    console.error('[EvidenciaController] Erro ao abrir sessão:', erro);
    return res.status(500).json({ erro: 'Erro interno ao abrir a sessão.' });
  }
}

async function receberFrame(req, res) {
  const { device_id, session_id, frame_index } = req.body;

  if (!device_id || !session_id) {
    return res.status(400).json({
      erro: 'Campos "device_id" e "session_id" são obrigatórios.',
    });
  }

  if (device_id !== req.dispositivo.id) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(403).json({ erro: 'device_id diferente do dispositivo autenticado.' });
  }

  if (!req.file) {
    return res.status(400).json({ erro: 'Campo "image" (arquivo) é obrigatório.' });
  }

  try {
    const existente = await db.query(
      'SELECT id_acionamento FROM acionamento WHERE external_session_id = $1',
      [session_id]
    );

    if (existente.rows.length === 0) {
      const dispositivo = await db.query(
        'SELECT id_dispositivo FROM dispositivo WHERE id_dispositivo = $1',
        [device_id]
      );

      if (dispositivo.rows.length === 0) {
        return res.status(404).json({
          erro: `Dispositivo "${device_id}" não encontrado.`,
        });
      }

      await db.query(
        `INSERT INTO acionamento (id_device, external_session_id, id_vitima)
         SELECT id_dispositivo, $2, id_vitima FROM dispositivo WHERE id_dispositivo = $1`,
        [device_id, session_id]
      );
    }

    return res.status(201).json({
      recebido: true,
      frame_index: Number(frame_index) || 0,
    });
  } catch (erro) {
    console.error('[EvidenciaController] Erro ao receber frame:', erro);
    return res.status(500).json({ erro: 'Erro interno ao receber o frame.' });
  }
}

async function encerrarSessao(req, res) {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ erro: 'Campo "session_id" é obrigatório.' });
  }

  if (!sessaoPertenceAoDispositivo(session_id, req.dispositivo.id)) {
    return res.status(403).json({ erro: 'session_id inválido para este dispositivo.' });
  }

  try {
    const sessao = await db.query(
      'SELECT id_acionamento FROM acionamento WHERE external_session_id = $1 AND id_device = $2',
      [session_id, req.dispositivo.id]
    );

    if (sessao.rows.length === 0) {
      return res.status(404).json({
        erro: `Sessão "${session_id}" não encontrada (nenhum frame foi recebido para ela?).`,
      });
    }

    const idAcionamento = sessao.rows[0].id_acionamento;
    const pastaFrames = path.join(FRAMES_DIR, session_id);

    if (!fs.existsSync(pastaFrames) || fs.readdirSync(pastaFrames).length === 0) {
      return res.status(400).json({
        erro: 'Nenhum frame encontrado pra essa sessão — nada para montar.',
      });
    }

    const caminhoVideo = path.join(VIDEOS_DIR, `${session_id}.mp4`);

    res.status(202).json({
      session_id,
      status: 'processando',
      url_storage: caminhoVideo,
    });

    finalizarGravacao(idAcionamento, session_id, pastaFrames, caminhoVideo);
  } catch (erro) {
    console.error('[EvidenciaController] Erro ao encerrar sessão:', erro);
    return res.status(500).json({ erro: 'Erro interno ao encerrar a sessão.' });
  }
}

async function finalizarGravacao(idAcionamento, sessionId, pastaFrames, caminhoVideo) {
  try {
    const { duracaoSegundos } = await montarVideoAPartirDeFrames(pastaFrames, caminhoVideo);

    const hash = await calcularHashSHA256(caminhoVideo);

    const urlStorage = await storage.salvarVideo(caminhoVideo, `${sessionId}.mp4`, {
      sha256: hash,
      sessionId,
    });

    const gravacao = await db.query(
      `INSERT INTO gravacao (id_acionamento, url_storage, hash_seguranca, duracao_segundos)
       VALUES ($1, $2, $3, $4)
       RETURNING id_gravacao`,
      [idAcionamento, urlStorage, hash, duracaoSegundos]
    );

    fs.rmSync(pastaFrames, { recursive: true, force: true });

    console.log(
      `[EvidenciaController] Sessão "${sessionId}" finalizada: gravacao ${gravacao.rows[0].id_gravacao}, ` +
        `${urlStorage}, SHA-256 ${hash}`
    );

    eventos.notificarStatus(gravacao.rows[0].id_gravacao);

    pipelineIA.solicitarAnalise(gravacao.rows[0].id_gravacao).catch((erro) =>
      console.error('[EvidenciaController] Erro ao solicitar análise:', erro)
    );
  } catch (erro) {

    console.error(`[EvidenciaController] Erro ao finalizar sessão "${sessionId}":`, erro);
  }
}

module.exports = {
  abrirSessao,
  receberFrame,
  encerrarSessao,
};
