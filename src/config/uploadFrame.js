const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const { FRAMES_DIR } = require('./paths');
const { sessaoPertenceAoDispositivo } = require('../middleware/autenticarDispositivo');
const { erroHttp } = require('../utils/erros');

// Um frame VGA da câmera tem ~20 KB; 2 MB dá folga até para resoluções maiores.
const TAMANHO_MAX_FRAME_BYTES = 2 * 1024 * 1024;
// ~1h20 de gravação a 4 fps: impede que uma chave vazada encha o disco.
const MAX_FRAMES_POR_SESSAO = 20000;
// O firmware manda até 10; a folga permite ajustar o firmware sem mexer aqui.
const MAX_FRAMES_POR_LOTE = 20;
// No lote cada arquivo se identifica pelo nome: "<frame_index>_<t_captura_ms>.jpg".
// Frames antigos do cartão SD podem vir sem o tempo: "<frame_index>.jpg".
const NOME_NO_LOTE = /^(\d{1,9})(?:_(\d{1,10}))?\.jpg$/;

function nomeDoFrame(frameIndex, tCapturaMs) {
  const indice = String(Number(frameIndex) || 0).padStart(6, '0');
  const tempo = Number(tCapturaMs);
  const sufixoTempo = Number.isInteger(tempo) && tempo >= 0 ? `_t${String(tempo).padStart(9, '0')}` : '';
  return `frame_${indice}${sufixoTempo}.jpg`;
}

function nomeDoFrameDoLote(arquivo) {
  const partes = NOME_NO_LOTE.exec(arquivo.originalname);
  if (!partes) {
    throw erroHttp(400, `Nome "${arquivo.originalname}" inválido no lote (use "<frame_index>_<t_captura_ms>.jpg").`);
  }
  const [, frameIndex, tCapturaMs] = partes;
  return nomeDoFrame(frameIndex, tCapturaMs);
}

async function quantidadeDeFrames(pasta) {
  try {
    return (await fs.readdir(pasta)).length;
  } catch {
    return 0;
  }
}

async function prepararPastaDaSessao(req) {
  const sessionId = req.body.session_id;
  if (!sessionId) {
    throw erroHttp(400, 'Campo "session_id" ausente ou fora de ordem no multipart (tem que vir antes das imagens).');
  }
  if (!sessaoPertenceAoDispositivo(sessionId, req.dispositivo.id)) {
    throw erroHttp(403, 'session_id inválido para este dispositivo.');
  }
  const pasta = path.join(FRAMES_DIR, sessionId);
  if ((await quantidadeDeFrames(pasta)) >= MAX_FRAMES_POR_SESSAO) {
    throw erroHttp(413, `Limite de ${MAX_FRAMES_POR_SESSAO} frames por sessão atingido.`);
  }
  await fs.mkdir(pasta, { recursive: true });
  return pasta;
}

function armazenarNaPastaDaSessao(nomearArquivo) {
  return multer.diskStorage({
    destination: (req, arquivo, cb) => {
      prepararPastaDaSessao(req).then((pasta) => cb(null, pasta), cb);
    },
    filename: (req, arquivo, cb) => {
      try {
        cb(null, nomearArquivo(req, arquivo));
      } catch (erro) {
        cb(erro);
      }
    },
  });
}

function somenteJpeg(req, file, cb) {
  if (file.mimetype === 'image/jpeg') return cb(null, true);
  return cb(erroHttp(415, 'A imagem precisa ser JPEG (Content-Type: image/jpeg).'));
}

const LIMITES_DOS_CAMPOS = { fileSize: TAMANHO_MAX_FRAME_BYTES, fields: 10, fieldSize: 1024 };

const uploadFrame = multer({
  storage: armazenarNaPastaDaSessao((req) => nomeDoFrame(req.body.frame_index, req.body.t_captura_ms)),
  fileFilter: somenteJpeg,
  limits: { ...LIMITES_DOS_CAMPOS, files: 1 },
});

// Se qualquer arquivo do lote falhar, o multer apaga os que já tinha gravado:
// a câmera reenvia o lote inteiro e os nomes iguais só sobrescrevem.
const uploadLote = multer({
  storage: armazenarNaPastaDaSessao((req, arquivo) => nomeDoFrameDoLote(arquivo)),
  fileFilter: somenteJpeg,
  limits: { ...LIMITES_DOS_CAMPOS, files: MAX_FRAMES_POR_LOTE },
});

module.exports = { uploadFrame, uploadLote, MAX_FRAMES_POR_LOTE };
