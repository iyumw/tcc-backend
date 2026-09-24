const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../config/db');

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

const HASH_FALSO = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);

async function conferirSenha(senha, senhaHash) {
  const [alg, saltHex, hashHex] = String(senhaHash || HASH_FALSO).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = await scrypt(String(senha), Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado) && Boolean(senhaHash);
}

function problemasDaSenha(senha) {
  const s = String(senha || '');
  const faltando = [];
  if (s.length < 8) faltando.push('pelo menos 8 caracteres');
  if (!/[A-Z]/.test(s)) faltando.push('uma letra maiúscula');
  if (!/[a-z]/.test(s)) faltando.push('uma letra minúscula');
  if (!/[0-9]/.test(s)) faltando.push('um número');
  if (!/[^A-Za-z0-9]/.test(s)) faltando.push('um caractere especial');
  return faltando;
}

function somenteDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function cpfValido(cpf) {
  const d = somenteDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(d.slice(0, 9)) === Number(d[9]) && digito(d.slice(0, 10)) === Number(d[10]);
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function base64url(dados) {
  return Buffer.from(dados).toString('base64url');
}

function assinarJwt(payload) {
  const cabecalho = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = base64url(JSON.stringify(payload));
  const assinatura = crypto.createHmac('sha256', JWT_SECRET).update(`${cabecalho}.${corpo}`).digest('base64url');
  return `${cabecalho}.${corpo}.${assinatura}`;
}

function lerJwt(token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  const [cabecalho, corpo, assinatura] = partes;
  const esperada = crypto.createHmac('sha256', JWT_SECRET).update(`${cabecalho}.${corpo}`).digest();
  const recebida = Buffer.from(assinatura, 'base64url');
  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) return null;
  try {
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
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
  const s = rows[0];
  if (!s || s.encerrada_em) return { erro: 'Sessão encerrada.', codigo: 'SESSAO_ENCERRADA' };
  if (new Date(s.expira_em) < new Date()) return { erro: 'Sessão expirada.', codigo: 'SESSAO_EXPIRADA' };
  if (s.inativa) {
    await db.query(`UPDATE sessao SET encerrada_em = NOW() WHERE id_sessao = $1`, [payload.sid]);
    return {
      erro: `Sessão encerrada por inatividade (${INATIVIDADE_MIN} min).`,
      codigo: 'SESSAO_INATIVA',
    };
  }

  await db.query(
    `UPDATE sessao SET ultimo_acesso = NOW()
      WHERE id_sessao = $1 AND ultimo_acesso < NOW() - INTERVAL '30 seconds'`,
    [payload.sid]
  );

  return { idVitima: s.id_vitima, idSessao: payload.sid };
}

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

function hashCodigo(idDesafio, codigo) {
  return crypto.createHash('sha256').update(`${idDesafio}:${codigo}`).digest('hex');
}

async function criarDesafio(idVitima, finalidade) {
  await db.query(
    `UPDATE desafio_mfa SET usado_em = NOW()
      WHERE id_vitima = $1 AND finalidade = $2 AND usado_em IS NULL`,
    [idVitima, finalidade]
  );
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const idDesafio = crypto.randomUUID();
  await db.query(
    `INSERT INTO desafio_mfa (id_desafio, id_vitima, finalidade, codigo_hash, expira_em)
     VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 minute'))`,
    [idDesafio, idVitima, finalidade, hashCodigo(idDesafio, codigo), MFA_VALIDADE_MIN]
  );
  return { idDesafio, codigo, validadeMinutos: MFA_VALIDADE_MIN };
}

async function conferirCodigo({ idDesafio = null, idVitima = null, finalidade, codigo }) {
  const { rows } = await db.query(
    `SELECT id_desafio, id_vitima, tentativas, usado_em, expira_em < NOW() AS expirado
       FROM desafio_mfa
      WHERE finalidade = $1
        AND ($2::uuid IS NULL OR id_desafio = $2::uuid)
        AND ($3::int IS NULL OR id_vitima = $3::int)
      ORDER BY criado_em DESC
      LIMIT 1`,
    [finalidade, idDesafio, idVitima]
  );
  const d = rows[0];
  if (!d || d.usado_em) return { ok: false, erro: 'Código inválido. Peça um novo código.' };
  if (d.expirado) return { ok: false, erro: 'Código expirado. Peça um novo código.' };
  if (d.tentativas >= MFA_MAX_TENTATIVAS) {
    return { ok: false, erro: 'Muitas tentativas. Peça um novo código.' };
  }

  const recebido = Buffer.from(hashCodigo(d.id_desafio, String(codigo || '').trim()));
  const esperado = Buffer.from(
    (await db.query('SELECT codigo_hash FROM desafio_mfa WHERE id_desafio = $1', [d.id_desafio])).rows[0].codigo_hash
  );
  if (!crypto.timingSafeEqual(recebido, esperado)) {
    await db.query('UPDATE desafio_mfa SET tentativas = tentativas + 1 WHERE id_desafio = $1', [d.id_desafio]);
    const restantes = MFA_MAX_TENTATIVAS - d.tentativas - 1;
    return { ok: false, erro: `Código incorreto. ${restantes > 0 ? `${restantes} tentativa(s) restante(s).` : 'Peça um novo código.'}` };
  }

  await db.query('UPDATE desafio_mfa SET usado_em = NOW() WHERE id_desafio = $1', [d.id_desafio]);
  return { ok: true, idVitima: d.id_vitima };
}

module.exports = {
  INATIVIDADE_MIN,
  gerarHashSenha,
  conferirSenha,
  problemasDaSenha,
  somenteDigitos,
  cpfValido,
  emailValido,
  criarSessao,
  validarSessao,
  sessaoAindaValida,
  encerrarSessao,
  encerrarTodasSessoes,
  criarDesafio,
  conferirCodigo,
};
