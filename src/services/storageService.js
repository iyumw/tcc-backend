const fs = require('fs');
const crypto = require('crypto');
const { PassThrough } = require('stream');

// Vídeos no AWS S3 quando S3_BUCKET está definido; senão, em tmp/videos/ (modo local).
const S3_BUCKET = process.env.S3_BUCKET || '';
const MODO_S3 = Boolean(S3_BUCKET);
const VALIDADE_URL_MIN = Number(process.env.URL_VALIDADE_MINUTOS) || 15;

// Credenciais: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY no .env ou a IAM role da máquina.
const S3 = MODO_S3 ? require('@aws-sdk/client-s3') : null;
const { getSignedUrl } = MODO_S3 ? require('@aws-sdk/s3-request-presigner') : {};
const s3 = MODO_S3 ? new S3.S3Client({ region: process.env.AWS_REGION }) : null;

const segredoLocal = process.env.URL_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
if (!MODO_S3 && !process.env.URL_SIGNING_SECRET) {
  console.warn(
    '[StorageService] URL_SIGNING_SECRET não definido — usando um segredo ' +
      'aleatório. URLs geradas deixam de valer quando o servidor reinicia.'
  );
}

function assinarLocal(idGravacao, expiraEm) {
  return crypto.createHmac('sha256', segredoLocal).update(`${idGravacao}:${expiraEm}`).digest('hex');
}

function ehUrlS3(urlStorage) {
  return urlStorage.startsWith('s3://');
}

function chaveDe(urlStorage) {
  if (!MODO_S3) throw new Error('Gravação está no S3, mas S3_BUCKET não está configurado.');
  const prefixo = `s3://${S3_BUCKET}/`;
  if (!urlStorage.startsWith(prefixo)) {
    throw new Error(`url_storage "${urlStorage}" não pertence ao bucket ${S3_BUCKET}.`);
  }
  return urlStorage.slice(prefixo.length);
}

async function salvarVideo(caminhoLocal, nomeObjeto, { sha256, sessionId }) {
  if (!MODO_S3) return caminhoLocal;

  const chave = `videos/${nomeObjeto}`;
  await s3.send(
    new S3.PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: chave,
      Body: fs.createReadStream(caminhoLocal),
      ContentLength: fs.statSync(caminhoLocal).size,
      ContentType: 'video/mp4',
      // Write once: falha se já existir um objeto com essa chave.
      IfNoneMatch: '*',
      // O S3 confere o SHA-256 ao receber e recusa o upload se o arquivo chegar diferente.
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      // RN01: criptografia em repouso (AES-256).
      ServerSideEncryption: 'AES256',
      Metadata: { sha256, session_id: sessionId, recebido_em: new Date().toISOString() },
    })
  );

  fs.rmSync(caminhoLocal, { force: true });
  return `s3://${S3_BUCKET}/${chave}`;
}

// Devolve o stream na hora (como o fs.createReadStream); o download do S3 entra nele depois.
function abrirLeitura(urlStorage) {
  if (!ehUrlS3(urlStorage)) return fs.createReadStream(urlStorage);

  const saida = new PassThrough();
  s3.send(new S3.GetObjectCommand({ Bucket: S3_BUCKET, Key: chaveDe(urlStorage) }))
    .then((resposta) => {
      resposta.Body.on('error', (erro) => saida.destroy(erro));
      resposta.Body.pipe(saida);
    })
    .catch((erro) => saida.destroy(erro));
  return saida;
}

async function existe(urlStorage) {
  if (!ehUrlS3(urlStorage)) return fs.existsSync(urlStorage);
  try {
    await s3.send(new S3.HeadObjectCommand({ Bucket: S3_BUCKET, Key: chaveDe(urlStorage) }));
    return true;
  } catch (erro) {
    const naoExiste = erro.name === 'NotFound' || (erro.$metadata && erro.$metadata.httpStatusCode === 404);
    if (naoExiste) return false;
    throw erro;
  }
}

async function gerarUrlAssinada(idGravacao, urlStorage, baseUrl, validadeMin = VALIDADE_URL_MIN) {
  const expiraEm = Date.now() + validadeMin * 60 * 1000;
  const url = ehUrlS3(urlStorage)
    ? await getSignedUrl(s3, new S3.GetObjectCommand({ Bucket: S3_BUCKET, Key: chaveDe(urlStorage) }), {
        expiresIn: validadeMin * 60,
      })
    : `${baseUrl}/api/evidencias/${idGravacao}/arquivo?expira=${expiraEm}&assinatura=${assinarLocal(idGravacao, expiraEm)}`;
  return { url, expira_em: new Date(expiraEm).toISOString() };
}

function validarAssinaturaLocal(idGravacao, expira, assinatura) {
  const expiraEm = Number(expira);
  if (!expiraEm || !assinatura) return 'URL sem assinatura.';
  if (Date.now() > expiraEm) return 'URL expirada.';

  const esperada = Buffer.from(assinarLocal(idGravacao, expiraEm), 'hex');
  const recebida = Buffer.from(String(assinatura), 'hex');
  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) {
    return 'Assinatura inválida.';
  }
  return null;
}

async function apagar(urlStorage) {
  try {
    if (ehUrlS3(urlStorage)) {
      // Com Object Lock (RN09), o S3 guarda a versão até o fim da retenção mesmo assim.
      await s3.send(new S3.DeleteObjectCommand({ Bucket: S3_BUCKET, Key: chaveDe(urlStorage) }));
    } else {
      fs.rmSync(urlStorage, { force: true });
    }
    return { apagado: true };
  } catch (erro) {
    return { apagado: false, motivo: erro.message };
  }
}

module.exports = {
  MODO_S3,
  VALIDADE_URL_MIN,
  salvarVideo,
  abrirLeitura,
  existe,
  gerarUrlAssinada,
  validarAssinaturaLocal,
  apagar,
};
