const fs = require('fs');
const crypto = require('crypto');

const GCS_BUCKET = process.env.GCS_BUCKET || '';
const MODO_GCS = Boolean(GCS_BUCKET);

const VALIDADE_URL_MIN = Number(process.env.URL_VALIDADE_MINUTOS) || 15;

let bucket = null;
if (MODO_GCS) {
  const { Storage } = require('@google-cloud/storage');
  bucket = new Storage().bucket(GCS_BUCKET);
}

let segredoLocal = process.env.URL_SIGNING_SECRET;
if (!MODO_GCS && !segredoLocal) {
  segredoLocal = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[StorageService] URL_SIGNING_SECRET não definido — usando um segredo ' +
      'aleatório. URLs geradas deixam de valer quando o servidor reinicia.'
  );
}

function assinarLocal(idGravacao, expiraEm) {
  return crypto
    .createHmac('sha256', segredoLocal)
    .update(`${idGravacao}:${expiraEm}`)
    .digest('hex');
}

async function salvarVideo(caminhoLocal, nomeObjeto, { sha256, sessionId }) {
  if (!MODO_GCS) {
    return caminhoLocal;
  }

  const destino = `videos/${nomeObjeto}`;
  await bucket.upload(caminhoLocal, {
    destination: destino,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: 'video/mp4',
      metadata: {
        sha256,
        session_id: sessionId,
        recebido_em: new Date().toISOString(),
      },
    },
  });

  fs.rmSync(caminhoLocal, { force: true });
  return `gs://${GCS_BUCKET}/${destino}`;
}

function nomeObjetoDe(urlStorage) {
  const prefixo = `gs://${GCS_BUCKET}/`;
  if (!urlStorage.startsWith(prefixo)) {
    throw new Error(`url_storage "${urlStorage}" não pertence ao bucket ${GCS_BUCKET}.`);
  }
  return urlStorage.slice(prefixo.length);
}

function ehUrlGcs(urlStorage) {
  return urlStorage.startsWith('gs://');
}

function abrirLeitura(urlStorage) {
  if (ehUrlGcs(urlStorage)) {
    if (!MODO_GCS) {
      throw new Error('Gravação está no GCS, mas GCS_BUCKET não está configurado.');
    }
    return bucket.file(nomeObjetoDe(urlStorage)).createReadStream();
  }
  return fs.createReadStream(urlStorage);
}

async function existe(urlStorage) {
  if (ehUrlGcs(urlStorage)) {
    if (!MODO_GCS) return false;
    const [ok] = await bucket.file(nomeObjetoDe(urlStorage)).exists();
    return ok;
  }
  return fs.existsSync(urlStorage);
}

async function gerarUrlAssinada(idGravacao, urlStorage, baseUrl, validadeMin = VALIDADE_URL_MIN) {
  const expiraEm = Date.now() + validadeMin * 60 * 1000;

  if (ehUrlGcs(urlStorage)) {
    if (!MODO_GCS) {
      throw new Error('Gravação está no GCS, mas GCS_BUCKET não está configurado.');
    }
    const [url] = await bucket.file(nomeObjetoDe(urlStorage)).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiraEm,
    });
    return { url, expira_em: new Date(expiraEm).toISOString() };
  }

  const assinatura = assinarLocal(idGravacao, expiraEm);
  const url = `${baseUrl}/api/evidencias/${idGravacao}/arquivo?expira=${expiraEm}&assinatura=${assinatura}`;
  return { url, expira_em: new Date(expiraEm).toISOString() };
}

function validarAssinaturaLocal(idGravacao, expira, assinatura) {
  const expiraEm = Number(expira);
  if (!expiraEm || !assinatura) {
    return 'URL sem assinatura.';
  }
  if (Date.now() > expiraEm) {
    return 'URL expirada.';
  }
  const esperada = Buffer.from(assinarLocal(idGravacao, expiraEm), 'hex');
  const recebida = Buffer.from(String(assinatura), 'hex');

  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) {
    return 'Assinatura inválida.';
  }
  return null;
}

async function apagar(urlStorage) {
  try {
    if (ehUrlGcs(urlStorage)) {
      if (!MODO_GCS) return { apagado: false, motivo: 'GCS não configurado.' };
      await bucket.file(nomeObjetoDe(urlStorage)).delete({ ignoreNotFound: true });
      return { apagado: true };
    }
    fs.rmSync(urlStorage, { force: true });
    return { apagado: true };
  } catch (erro) {
    return { apagado: false, motivo: erro.message };
  }
}

module.exports = {
  apagar,
  MODO_GCS,
  VALIDADE_URL_MIN,
  salvarVideo,
  abrirLeitura,
  existe,
  gerarUrlAssinada,
  validarAssinaturaLocal,
};
