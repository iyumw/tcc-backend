const fs = require('fs/promises');
const path = require('path');
const db = require('../config/db');
const { FRAMES_DIR, VIDEOS_DIR } = require('../config/paths');
const { montarVideoAPartirDeFrames } = require('../services/videoAssemblyService');
const { calcularHashSHA256 } = require('../services/custodiaService');
const storage = require('../services/storageService');
const pipelineIA = require('../services/pipelineIAService');
const eventos = require('../services/eventosService');
const carimbo = require('../services/carimboTempoService');
const { sessaoPertenceAoDispositivo } = require('../middleware/autenticarDispositivo');
const { envolverControladores } = require('../utils/comTratamentoDeErros');

const ASSINATURA_JPEG = Buffer.from([0xff, 0xd8, 0xff]);
// Uma montagem "em andamento" há mais tempo que isso provavelmente morreu
// junto com o processo, e pode ser refeita.
const FINALIZACAO_TRAVADA_MIN = 15;

async function descartarArquivoRecebido(req) {
  if (req.file) await fs.rm(req.file.path, { force: true });
}

async function comecaComoJpeg(caminho) {
  const arquivo = await fs.open(caminho, 'r');
  try {
    const inicio = Buffer.alloc(ASSINATURA_JPEG.length);
    await arquivo.read(inicio, 0, inicio.length, 0);
    return inicio.equals(ASSINATURA_JPEG);
  } finally {
    await arquivo.close();
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

function problemaNoFrame(req) {
  const { device_id: idDispositivo, session_id: sessionId } = req.body || {};
  if (!idDispositivo || !sessionId) return [400, 'Campos "device_id" e "session_id" são obrigatórios.'];
  if (idDispositivo !== req.dispositivo.id) return [403, 'device_id diferente do dispositivo autenticado.'];
  if (!req.file) return [400, 'Campo "image" (arquivo) é obrigatório.'];
  return null;
}

async function receberFrame(req, res) {
  const problema = problemaNoFrame(req);
  if (problema) {
    await descartarArquivoRecebido(req);
    const [status, erro] = problema;
    return res.status(status).json({ erro });
  }
  if (!(await comecaComoJpeg(req.file.path))) {
    await descartarArquivoRecebido(req);
    return res.status(415).json({ erro: 'O arquivo enviado não é um JPEG.' });
  }

  await criarSessaoSeNova(req.dispositivo.id, req.body.session_id);
  return res.status(201).json({ recebido: true, frame_index: Number(req.body.frame_index) || 0 });
}

async function situacaoDaSessao(sessionId, idDispositivo) {
  const { rows } = await db.query(
    `SELECT a.id_acionamento, g.id_gravacao
       FROM acionamento a
       LEFT JOIN gravacao g ON g.id_acionamento = a.id_acionamento
      WHERE a.external_session_id = $1 AND a.id_device = $2`,
    [sessionId, idDispositivo]
  );
  return rows[0] || null;
}

// Só uma chamada consegue reservar a montagem: encerrar duas vezes não gera dois vídeos.
async function reservarFinalizacao(idAcionamento) {
  const { rowCount } = await db.query(
    `UPDATE acionamento a SET finalizacao_iniciada_em = NOW()
      WHERE a.id_acionamento = $1
        AND NOT EXISTS (SELECT 1 FROM gravacao g WHERE g.id_acionamento = a.id_acionamento)
        AND (a.finalizacao_iniciada_em IS NULL
             OR a.finalizacao_iniciada_em < NOW() - ($2 * INTERVAL '1 minute'))`,
    [idAcionamento, FINALIZACAO_TRAVADA_MIN]
  );
  return rowCount === 1;
}

async function liberarFinalizacao(idAcionamento) {
  await db.query('UPDATE acionamento SET finalizacao_iniciada_em = NULL WHERE id_acionamento = $1', [idAcionamento]);
}

async function temFrames(pastaFrames) {
  try {
    return (await fs.readdir(pastaFrames)).length > 0;
  } catch {
    return false;
  }
}

async function encerrarSessao(req, res) {
  const { session_id: sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ erro: 'Campo "session_id" é obrigatório.' });
  if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
    return res.status(403).json({ erro: 'session_id inválido para este dispositivo.' });
  }

  const sessao = await situacaoDaSessao(sessionId, req.dispositivo.id);
  if (!sessao) {
    return res.status(404).json({ erro: `Sessão "${sessionId}" não encontrada (nenhum frame foi recebido para ela?).` });
  }
  if (sessao.id_gravacao) {
    return res.status(200).json({ session_id: sessionId, status: 'concluida', id_gravacao: sessao.id_gravacao });
  }

  const pastaFrames = path.join(FRAMES_DIR, sessionId);
  if (!(await temFrames(pastaFrames))) {
    return res.status(400).json({ erro: 'Nenhum frame encontrado pra essa sessão — nada para montar.' });
  }

  if (await reservarFinalizacao(sessao.id_acionamento)) {
    finalizarGravacao(sessao.id_acionamento, sessionId, pastaFrames);
  }
  return res.status(202).json({ session_id: sessionId, status: 'processando' });
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

    await fs.rm(pastaFrames, { recursive: true, force: true });
    console.log(`[Captura] Sessão "${sessionId}" finalizada: gravacao ${idGravacao}, ${urlStorage}, SHA-256 ${hash}`);

    eventos.notificarStatus(idGravacao);
    carimbo.carimbarGravacao(idGravacao).catch((erro) =>
      console.error(`[Captura] Erro ao carimbar a gravação ${idGravacao}:`, erro)
    );
    pipelineIA.solicitarAnalise(idGravacao).catch((erro) =>
      console.error(`[Captura] Erro ao pedir a análise da gravação ${idGravacao}:`, erro)
    );
  } catch (erro) {
    console.error(`[Captura] Erro ao finalizar sessão "${sessionId}":`, erro);
    await liberarFinalizacao(idAcionamento).catch(() => {});
  }
}

// Na subida do servidor: termina as montagens interrompidas por uma queda do processo.
async function retomarFinalizacoesInterrompidas() {
  const { rows } = await db.query(
    `SELECT a.id_acionamento, a.external_session_id
       FROM acionamento a
      WHERE a.finalizacao_iniciada_em IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gravacao g WHERE g.id_acionamento = a.id_acionamento)`
  );
  for (const { id_acionamento: idAcionamento, external_session_id: sessionId } of rows) {
    const pastaFrames = path.join(FRAMES_DIR, sessionId);
    if (!(await temFrames(pastaFrames))) continue;
    console.log(`[Captura] Retomando a montagem da sessão "${sessionId}".`);
    await db.query('UPDATE acionamento SET finalizacao_iniciada_em = NOW() WHERE id_acionamento = $1', [idAcionamento]);
    await finalizarGravacao(idAcionamento, sessionId, pastaFrames);
  }
}

module.exports = envolverControladores({
  receberFrame,
  encerrarSessao,
});
module.exports.retomarFinalizacoesInterrompidas = retomarFinalizacoesInterrompidas;
