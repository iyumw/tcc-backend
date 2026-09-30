const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../config/db');
const emailService = require('./emailService');

const scrypt = promisify(crypto.scrypt);

const INATIVIDADE_MIN = Number(process.env.SESSAO_INATIVIDADE_MINUTOS) || 15;
const SESSAO_MAX_HORAS = Number(process.env.SESSAO_MAX_HORAS) || 8;
const MFA_VALIDADE_MIN = 5;
const MFA_MAX_TENTATIVAS = 5;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[AuthService] JWT_SECRET não definido — usando um aleatório (todas as sessões caem ao reiniciar).');
}

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
  const cabecalho = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const assinatura = assinarHmac(`${cabecalho}.${corpo}`).toString('base64url');
  return `${cabecalho}.${corpo}.${assinatura}`;
}

function lerJwt(token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  const [cabecalho, corpo, assinatura] = partes;
  const esperada = assinarHmac(`${cabecalho}.${corpo}`);
  const recebida = Buffer.from(assinatura, 'base64url');
  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) return null;
  try {
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    return payload.exp && payload.exp * 1000 >= Date.now() ? payload : null;
  } catch {
    return null;
  }
}

async function criarSessao(idVitima) {
  const { rows } = await db.query(
    `INSERT INTO sessao (id_vitima, expira_em)
     VALUES ($1, NOW() + ($2 * INTERVAL '1 hour'))
     RETURNING id_sessao, expira_em`,
    [idVitima, SESSAO_MAX_HORAS]
  );
  const sessao = rows[0];
  const token = assinarJwt({
    sub: idVitima,
    sid: sessao.id_sessao,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(new Date(sessao.expira_em).getTime() / 1000),
  });
  return { token, expira_em: sessao.expira_em, inatividade_minutos: INATIVIDADE_MIN };
}

async function validarSessao(token) {
  const payload = lerJwt(token);
  if (!payload) return { erro: 'Token inválido ou expirado.', codigo: 'TOKEN_INVALIDO' };

  const { rows } = await db.query(
    `SELECT id_vitima, encerrada_em, expira_em,
            ultimo_acesso < NOW() - ($2 * INTERVAL '1 minute') AS inativa
       FROM sessao WHERE id_sessao = $1`,
    [payload.sid, INATIVIDADE_MIN]
  );
  const sessao = rows[0];
  if (!sessao || sessao.encerrada_em) return { erro: 'Sessão encerrada.', codigo: 'SESSAO_ENCERRADA' };
  if (new Date(sessao.expira_em) < new Date()) return { erro: 'Sessão expirada.', codigo: 'SESSAO_EXPIRADA' };
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

// Busca pelo id do código (login) ou pelo último código da usuária para a finalidade.
async function conferirCodigo({ idCodigo = null, idVitima = null, finalidade, codigo }) {
  const { rows } = await db.query(
    `SELECT id_codigo, id_vitima, codigo_hash, tentativas, usado_em, expira_em < NOW() AS expirado
       FROM codigo_mfa
      WHERE finalidade = $1
        AND ($2::uuid IS NULL OR id_codigo = $2::uuid)
        AND ($3::int IS NULL OR id_vitima = $3::int)
      ORDER BY criado_em DESC
      LIMIT 1`,
    [finalidade, idCodigo, idVitima]
  );
  const registro = rows[0];
  if (!registro || registro.usado_em) return { ok: false, erro: 'Código inválido. Peça um novo código.' };
  if (registro.expirado) return { ok: false, erro: 'Código expirado. Peça um novo código.' };
  if (registro.tentativas >= MFA_MAX_TENTATIVAS) return { ok: false, erro: 'Muitas tentativas. Peça um novo código.' };

  const recebido = Buffer.from(hashCodigo(registro.id_codigo, String(codigo || '').trim()));
  const esperado = Buffer.from(registro.codigo_hash);
  if (!crypto.timingSafeEqual(recebido, esperado)) {
    await db.query('UPDATE codigo_mfa SET tentativas = tentativas + 1 WHERE id_codigo = $1', [registro.id_codigo]);
    const restantes = MFA_MAX_TENTATIVAS - registro.tentativas - 1;
    const dica = restantes > 0 ? `${restantes} tentativa(s) restante(s).` : 'Peça um novo código.';
    return { ok: false, erro: `Código incorreto. ${dica}` };
  }

  await db.query('UPDATE codigo_mfa SET usado_em = NOW() WHERE id_codigo = $1', [registro.id_codigo]);
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
