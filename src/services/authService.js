const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../config/db');
const emailService = require('./emailService');
const { lerSegredo } = require('../config/segredos');

const scrypt = promisify(crypto.scrypt);

const INATIVIDADE_MIN = Number(process.env.SESSAO_INATIVIDADE_MINUTOS) || 15;
const SESSAO_MAX_HORAS = Number(process.env.SESSAO_MAX_HORAS) || 8;
const MFA_VALIDADE_MIN = 5;
const MFA_MAX_TENTATIVAS = 5;
// Pedir um código novo zera as tentativas do código, mas não as da conta:
// sem este teto, os 10^6 códigos poderiam ser testados pedindo códigos sem parar.
const MFA_MAX_FALHAS_POR_CONTA = 10;
const MFA_JANELA_FALHAS_MIN = 15;

const JWT_SECRET = lerSegredo('JWT_SECRET');
const CABECALHO_JWT = { alg: 'HS256', typ: 'JWT' };
const CABECALHO_JWT_CODIFICADO = Buffer.from(JSON.stringify(CABECALHO_JWT)).toString('base64url');

async function gerarHashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(senha, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Usado quando o e-mail não existe, para o login levar o mesmo tempo e não
// revelar quais e-mails estão cadastrados.
const HASH_FALSO = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);

async function conferirSenha(senha, senhaHash) {
  const [alg, saltHex, hashHex] = String(senhaHash || HASH_FALSO).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = await scrypt(String(senha), Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado) && Boolean(senhaHash);
}

function assinarHmac(conteudo) {
  return crypto.createHmac('sha256', JWT_SECRET).update(conteudo).digest();
}

function assinarJwt(payload) {
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const assinatura = assinarHmac(`${CABECALHO_JWT_CODIFICADO}.${corpo}`).toString('base64url');
  return `${CABECALHO_JWT_CODIFICADO}.${corpo}.${assinatura}`;
}

function lerJson(base64url) {
  try {
    return JSON.parse(Buffer.from(base64url, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Só aceita o cabeçalho que o próprio backend emite (HS256): impede trocar o
// algoritmo no token (ex.: "none").
function cabecalhoValido(cabecalho) {
  const lido = lerJson(cabecalho);
  return Boolean(lido) && lido.alg === CABECALHO_JWT.alg && lido.typ === CABECALHO_JWT.typ;
}

function payloadValido(payload) {
  const agoraS = Date.now() / 1000;
  return (
    Boolean(payload) &&
    Number.isInteger(payload.sub) &&
    typeof payload.sid === 'string' &&
    Number.isFinite(payload.exp) &&
    payload.exp >= agoraS &&
    (payload.iat === undefined || payload.iat <= agoraS + 60)
  );
}

function lerJwt(token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  const [cabecalho, corpo, assinatura] = partes;
  if (!cabecalhoValido(cabecalho)) return null;
  const esperada = assinarHmac(`${cabecalho}.${corpo}`);
  const recebida = Buffer.from(assinatura, 'base64url');
  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) return null;
  const payload = lerJson(corpo);
  return payloadValido(payload) ? payload : null;
}

async function criarSessao(idVitima) {
  const { rows } = await db.query(
    `INSERT INTO sessao (id_vitima, expira_em)
     VALUES ($1, NOW() + ($2 * INTERVAL '1 hour'))
     RETURNING id_sessao`,
    [idVitima, SESSAO_MAX_HORAS]
  );
  const agoraS = Math.floor(Date.now() / 1000);
  const expiraS = agoraS + SESSAO_MAX_HORAS * 3600;
  const token = assinarJwt({ sub: idVitima, sid: rows[0].id_sessao, iat: agoraS, exp: expiraS });
  return { token, expira_em: new Date(expiraS * 1000).toISOString(), inatividade_minutos: INATIVIDADE_MIN };
}

async function validarSessao(token) {
  const payload = lerJwt(token);
  if (!payload) return { erro: 'Token inválido ou expirado.', codigo: 'TOKEN_INVALIDO' };

  const { rows } = await db.query(
    `SELECT id_vitima, encerrada_em,
            expira_em < NOW() AS expirada,
            ultimo_acesso < NOW() - ($2 * INTERVAL '1 minute') AS inativa
       FROM sessao WHERE id_sessao = $1`,
    [payload.sid, INATIVIDADE_MIN]
  );
  const sessao = rows[0];
  if (!sessao || sessao.encerrada_em) return { erro: 'Sessão encerrada.', codigo: 'SESSAO_ENCERRADA' };
  if (sessao.expirada) return { erro: 'Sessão expirada.', codigo: 'SESSAO_EXPIRADA' };
  if (sessao.inativa) {
    await encerrarSessao(payload.sid);
    return { erro: `Sessão encerrada por inatividade (${INATIVIDADE_MIN} min).`, codigo: 'SESSAO_INATIVA' };
  }

  // Grava o último acesso no máximo a cada 30 s, para não escrever no banco a cada requisição.
  await db.query(
    `UPDATE sessao SET ultimo_acesso = NOW()
      WHERE id_sessao = $1 AND ultimo_acesso < NOW() - INTERVAL '30 seconds'`,
    [payload.sid]
  );

  return { idVitima: sessao.id_vitima, idSessao: payload.sid };
}

// Não renova o último acesso: usado pela conexão SSE, que fica aberta sozinha.
async function sessaoAindaValida(idSessao) {
  const { rows } = await db.query(
    `SELECT 1 FROM sessao
      WHERE id_sessao = $1 AND encerrada_em IS NULL AND expira_em > NOW()
        AND ultimo_acesso > NOW() - ($2 * INTERVAL '1 minute')`,
    [idSessao, INATIVIDADE_MIN]
  );
  return rows.length > 0;
}

async function encerrarSessao(idSessao) {
  await db.query(`UPDATE sessao SET encerrada_em = NOW() WHERE id_sessao = $1 AND encerrada_em IS NULL`, [idSessao]);
}

async function encerrarTodasSessoes(idVitima, excetoIdSessao = null) {
  await db.query(
    `UPDATE sessao SET encerrada_em = NOW()
      WHERE id_vitima = $1 AND encerrada_em IS NULL AND ($2::uuid IS NULL OR id_sessao <> $2::uuid)`,
    [idVitima, excetoIdSessao]
  );
}

function hashCodigo(idCodigo, codigo) {
  return crypto.createHash('sha256').update(`${idCodigo}:${codigo}`).digest('hex');
}

async function criarCodigo(idVitima, finalidade) {
  await db.query(
    `UPDATE codigo_mfa SET usado_em = NOW()
      WHERE id_vitima = $1 AND finalidade = $2 AND usado_em IS NULL`,
    [idVitima, finalidade]
  );
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const idCodigo = crypto.randomUUID();
  await db.query(
    `INSERT INTO codigo_mfa (id_codigo, id_vitima, finalidade, codigo_hash, expira_em)
     VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 minute'))`,
    [idCodigo, idVitima, finalidade, hashCodigo(idCodigo, codigo), MFA_VALIDADE_MIN]
  );
  return { idCodigo, codigo, validadeMinutos: MFA_VALIDADE_MIN };
}

async function enviarCodigo(idVitima, email, finalidade) {
  const { idCodigo, codigo, validadeMinutos } = await criarCodigo(idVitima, finalidade);
  await emailService.enviarCodigo(email, codigo, finalidade, validadeMinutos);
  return { idCodigo, validadeMinutos };
}

async function falhasRecentesDaConta(idVitima, finalidade) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(tentativas), 0)::int AS falhas
       FROM codigo_mfa
      WHERE id_vitima = $1 AND finalidade = $2
        AND criado_em > NOW() - ($3 * INTERVAL '1 minute')`,
    [idVitima, finalidade, MFA_JANELA_FALHAS_MIN]
  );
  return rows[0].falhas;
}

// Reserva a tentativa antes de comparar: requisições simultâneas não passam do limite.
async function reservarTentativa(idCodigo) {
  const { rows } = await db.query(
    `UPDATE codigo_mfa SET tentativas = tentativas + 1
      WHERE id_codigo = $1 AND usado_em IS NULL AND expira_em > NOW() AND tentativas < $2
      RETURNING tentativas`,
    [idCodigo, MFA_MAX_TENTATIVAS]
  );
  return rows.length ? rows[0].tentativas : null;
}

// Só uma requisição consegue marcar o código como usado. A tentativa certa é
// devolvida, para "tentativas" contar só as erradas.
async function consumirCodigo(idCodigo) {
  const { rowCount } = await db.query(
    'UPDATE codigo_mfa SET usado_em = NOW(), tentativas = tentativas - 1 WHERE id_codigo = $1 AND usado_em IS NULL',
    [idCodigo]
  );
  return rowCount === 1;
}

function codigoConfere(registro, codigo) {
  const recebido = Buffer.from(hashCodigo(registro.id_codigo, String(codigo || '').trim()));
  const esperado = Buffer.from(registro.codigo_hash);
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

const CODIGO_INVALIDO = { ok: false, erro: 'Código inválido. Peça um novo código.' };

// Busca pelo id do código (login) ou pelo último código da usuária para a finalidade.
async function conferirCodigo({ idCodigo = null, idVitima = null, finalidade, codigo }) {
  const { rows } = await db.query(
    `SELECT id_codigo, id_vitima, codigo_hash, usado_em, expira_em < NOW() AS expirado
       FROM codigo_mfa
      WHERE finalidade = $1
        AND ($2::uuid IS NULL OR id_codigo = $2::uuid)
        AND ($3::int IS NULL OR id_vitima = $3::int)
      ORDER BY criado_em DESC
      LIMIT 1`,
    [finalidade, idCodigo, idVitima]
  );
  const registro = rows[0];
  if (!registro || registro.usado_em) return CODIGO_INVALIDO;
  if (registro.expirado) return { ok: false, erro: 'Código expirado. Peça um novo código.' };
  if ((await falhasRecentesDaConta(registro.id_vitima, finalidade)) >= MFA_MAX_FALHAS_POR_CONTA) {
    return { ok: false, erro: `Muitas tentativas. Aguarde ${MFA_JANELA_FALHAS_MIN} min e peça um novo código.` };
  }

  const tentativas = await reservarTentativa(registro.id_codigo);
  if (tentativas === null) return { ok: false, erro: 'Muitas tentativas. Peça um novo código.' };

  if (!codigoConfere(registro, codigo)) {
    const restantes = MFA_MAX_TENTATIVAS - tentativas;
    const dica = restantes > 0 ? `${restantes} tentativa(s) restante(s).` : 'Peça um novo código.';
    return { ok: false, erro: `Código incorreto. ${dica}` };
  }

  if (!(await consumirCodigo(registro.id_codigo))) return CODIGO_INVALIDO;
  return { ok: true, idVitima: registro.id_vitima };
}

module.exports = {
  INATIVIDADE_MIN,
  gerarHashSenha,
  conferirSenha,
  criarSessao,
  validarSessao,
  sessaoAindaValida,
  encerrarSessao,
  encerrarTodasSessoes,
  enviarCodigo,
  conferirCodigo,
};
