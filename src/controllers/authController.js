const db = require('../config/db');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const auditoria = require('../services/auditoriaService');

const BLOQUEIO_MIN = 30;

function erro400(res, mensagem, extra = {}) {
  return res.status(400).json({ erro: mensagem, ...extra });
}

async function cadastrar(req, res, next) {
  try {
    const b = req.body || {};
    const cpf = authService.somenteDigitos(b.cpf);
    const telefone = authService.somenteDigitos(b.telefone);
    const email = String(b.email || '').trim().toLowerCase();
    const end = b.endereco || {};
    const cep = authService.somenteDigitos(end.cep);

    const campos = {};
    if (!b.nome || String(b.nome).trim().length < 3) campos.nome = 'Informe o nome completo.';
    if (!authService.cpfValido(cpf)) campos.cpf = 'CPF inválido.';
    if (!authService.emailValido(email)) campos.email = 'E-mail inválido.';
    if (telefone.length < 10 || telefone.length > 11) campos.telefone = 'Telefone inválido (DDD + número).';
    const faltaSenha = authService.problemasDaSenha(b.senha);
    if (faltaSenha.length) campos.senha = `A senha precisa ter: ${faltaSenha.join(', ')}.`;
    if (cep.length !== 8) campos['endereco.cep'] = 'CEP inválido.';
    for (const c of ['logradouro', 'numero', 'bairro', 'cidade']) {
      if (!end[c] || !String(end[c]).trim()) campos[`endereco.${c}`] = 'Campo obrigatório.';
    }
    if (!/^[A-Za-z]{2}$/.test(String(end.uf || ''))) campos['endereco.uf'] = 'UF inválida.';
    if (b.consentimento !== true) {
      campos.consentimento = 'É preciso aceitar a Política de Privacidade e o Termo de Consentimento.';
    }
    if (Object.keys(campos).length) return erro400(res, 'Verifique os campos do cadastro.', { campos });

    const existentes = await db.query('SELECT cpf, email FROM vitima WHERE cpf = $1 OR email = $2', [cpf, email]);
    if (existentes.rows.length) {
      const conflito = {};
      if (existentes.rows.some((r) => r.email === email)) conflito.email = 'E-mail já cadastrado.';
      if (existentes.rows.some((r) => r.cpf === cpf)) conflito.cpf = 'CPF já cadastrado.';
      return res.status(409).json({ erro: 'Já existe uma conta com esses dados.', campos: conflito });
    }

    const senhaHash = await authService.gerarHashSenha(b.senha);
    const { rows } = await db.query(
      `INSERT INTO vitima (nome, cpf, telefone, email, consentimento, consentimento_em, senha_hash,
                           cep, logradouro, numero, complemento, bairro, cidade, uf)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id_vitima`,
      [String(b.nome).trim().slice(0, 100), cpf, telefone, email, senhaHash, cep,
       String(end.logradouro).trim().slice(0, 150), String(end.numero).trim().slice(0, 20),
       end.complemento ? String(end.complemento).trim().slice(0, 100) : null,
       String(end.bairro).trim().slice(0, 100), String(end.cidade).trim().slice(0, 100),
       String(end.uf).toUpperCase()]
    );

    await auditoria.registrar('cadastro', { idVitima: rows[0].id_vitima, req });
    emailService.enviarBoasVindas(email, String(b.nome).trim());

    return res.status(201).json({ id_vitima: rows[0].id_vitima, mensagem: 'Cadastro concluído. Faça login para continuar.' });
  } catch (erro) {
    next(erro);
  }
}

async function login(req, res, next) {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const senha = (req.body && req.body.senha) || '';

    const { rows } = await db.query(
      `SELECT id_vitima, email, senha_hash, falhas_login, ja_foi_bloqueada, bloqueio_permanente,
              bloqueada_ate, bloqueada_ate > NOW() AS bloqueada_agora,
              CEIL(EXTRACT(EPOCH FROM (bloqueada_ate - NOW())) / 60) AS minutos_restantes
         FROM vitima WHERE email = $1`,
      [email]
    );
    const v = rows[0];

    if (v && v.bloqueio_permanente) {
      await auditoria.registrar('login_negado_bloqueio_permanente', { idVitima: v.id_vitima, req });
      return res.status(423).json({
        erro: 'Conta bloqueada por excesso de tentativas. Entre em contato com o suporte.',
        codigo: 'BLOQUEIO_PERMANENTE',
      });
    }
    if (v && v.bloqueada_agora) {
      await auditoria.registrar('login_negado_bloqueio_temporario', { idVitima: v.id_vitima, req });
      return res.status(423).json({
        erro: `Conta bloqueada temporariamente. Tente de novo em ${v.minutos_restantes} min.`,
        codigo: 'BLOQUEIO_TEMPORARIO',
        minutos_restantes: Number(v.minutos_restantes),
      });
    }


    const senhaOk = await authService.conferirSenha(senha, v ? v.senha_hash : null);

    if (!v || !senhaOk) {
      if (v) {

        const falhas = v.falhas_login + 1;
        if (v.ja_foi_bloqueada && falhas >= 2) {
          await db.query(
            `UPDATE vitima SET falhas_login = 0, bloqueio_permanente = TRUE WHERE id_vitima = $1`,
            [v.id_vitima]
          );
          await auditoria.registrar('bloqueio_permanente', { idVitima: v.id_vitima, req });
          return res.status(423).json({
            erro: 'Conta bloqueada por excesso de tentativas. Entre em contato com o suporte.',
            codigo: 'BLOQUEIO_PERMANENTE',
          });
        }
        if (!v.ja_foi_bloqueada && falhas >= 3) {
          await db.query(
            `UPDATE vitima SET falhas_login = 0, ja_foi_bloqueada = TRUE,
                    bloqueada_ate = NOW() + ($2 * INTERVAL '1 minute')
              WHERE id_vitima = $1`,
            [v.id_vitima, BLOQUEIO_MIN]
          );
          await auditoria.registrar('bloqueio_temporario', { idVitima: v.id_vitima, req });
          return res.status(423).json({
            erro: `Muitas tentativas incorretas. Conta bloqueada por ${BLOQUEIO_MIN} min.`,
            codigo: 'BLOQUEIO_TEMPORARIO',
            minutos_restantes: BLOQUEIO_MIN,
          });
        }
        await db.query(`UPDATE vitima SET falhas_login = $2 WHERE id_vitima = $1`, [v.id_vitima, falhas]);
        await auditoria.registrar('login_falha', { idVitima: v.id_vitima, detalhes: { falhas }, req });
      } else {
        await auditoria.registrar('login_falha_email_desconhecido', { req });
      }
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.', codigo: 'CREDENCIAIS_INVALIDAS' });
    }

    await db.query(
      `UPDATE vitima SET falhas_login = 0, ja_foi_bloqueada = FALSE, bloqueada_ate = NULL WHERE id_vitima = $1`,
      [v.id_vitima]
    );
    const desafio = await authService.criarDesafio(v.id_vitima, 'login');
    await emailService.enviarCodigo(v.email, desafio.codigo, 'login', desafio.validadeMinutos);
    await auditoria.registrar('login_senha_ok_mfa_enviado', { idVitima: v.id_vitima, req });

    return res.json({
      mfa_token: desafio.idDesafio,
      validade_minutos: desafio.validadeMinutos,
      email_mascarado: mascararEmail(v.email),
      mensagem: 'Enviamos um código de 6 dígitos para o seu e-mail.',
    });
  } catch (erro) {
    next(erro);
  }
}

function mascararEmail(email) {
  const [usuario, dominio] = email.split('@');
  return `${usuario.slice(0, 2)}${'*'.repeat(Math.max(usuario.length - 2, 1))}@${dominio}`;
}

async function verificarMfa(req, res, next) {
  try {
    const { mfa_token: mfaToken, codigo } = req.body || {};
    if (!mfaToken || !/^[0-9a-f-]{36}$/i.test(String(mfaToken))) {
      return erro400(res, 'mfa_token inválido.');
    }
    const r = await authService.conferirCodigo({ idDesafio: mfaToken, finalidade: 'login', codigo });
    if (!r.ok) {
      await auditoria.registrar('mfa_falha', { detalhes: { mfa_token: mfaToken }, req });
      return res.status(401).json({ erro: r.erro, codigo: 'MFA_INVALIDO' });
    }

    const sessao = await authService.criarSessao(r.idVitima);
    const { rows } = await db.query('SELECT id_vitima, nome, email FROM vitima WHERE id_vitima = $1', [r.idVitima]);
    await auditoria.registrar('login_sucesso', { idVitima: r.idVitima, req });

    return res.json({ ...sessao, usuario: rows[0] });
  } catch (erro) {
    next(erro);
  }
}

async function reenviarMfa(req, res, next) {
  try {
    const { mfa_token: mfaToken } = req.body || {};
    if (!mfaToken || !/^[0-9a-f-]{36}$/i.test(String(mfaToken))) return erro400(res, 'mfa_token inválido.');


    const { rows } = await db.query(
      `SELECT d.id_vitima, v.email FROM desafio_mfa d JOIN vitima v ON v.id_vitima = d.id_vitima
        WHERE d.id_desafio = $1 AND d.finalidade = 'login' AND d.criado_em > NOW() - INTERVAL '15 minutes'`,
      [mfaToken]
    );
    if (!rows.length) return res.status(401).json({ erro: 'Faça login novamente.', codigo: 'MFA_EXPIRADO' });

    const desafio = await authService.criarDesafio(rows[0].id_vitima, 'login');
    await emailService.enviarCodigo(rows[0].email, desafio.codigo, 'login', desafio.validadeMinutos);
    return res.json({ mfa_token: desafio.idDesafio, validade_minutos: desafio.validadeMinutos });
  } catch (erro) {
    next(erro);
  }
}

async function logout(req, res, next) {
  try {
    await authService.encerrarSessao(req.usuario.idSessao);
    await auditoria.registrar('logout', { idVitima: req.usuario.idVitima, req });
    return res.status(204).end();
  } catch (erro) {
    next(erro);
  }
}

async function esqueciSenha(req, res, next) {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const { rows } = await db.query(
      'SELECT id_vitima, email, bloqueio_permanente FROM vitima WHERE email = $1',
      [email]
    );
    if (rows.length && !rows[0].bloqueio_permanente) {
      const desafio = await authService.criarDesafio(rows[0].id_vitima, 'recuperar_senha');
      await emailService.enviarCodigo(rows[0].email, desafio.codigo, 'recuperar_senha', desafio.validadeMinutos);
      await auditoria.registrar('recuperacao_senha_solicitada', { idVitima: rows[0].id_vitima, req });
    }
    return res.json({ mensagem: 'Se o e-mail estiver cadastrado, enviamos um código para ele.' });
  } catch (erro) {
    next(erro);
  }
}

async function redefinirSenha(req, res, next) {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const { codigo, nova_senha: novaSenha } = req.body || {};

    const falta = authService.problemasDaSenha(novaSenha);
    if (falta.length) return erro400(res, `A senha precisa ter: ${falta.join(', ')}.`, { campos: { nova_senha: falta } });

    const { rows } = await db.query('SELECT id_vitima FROM vitima WHERE email = $1', [email]);
    if (!rows.length) return res.status(401).json({ erro: 'Código inválido. Peça um novo código.' });

    const r = await authService.conferirCodigo({ idVitima: rows[0].id_vitima, finalidade: 'recuperar_senha', codigo });
    if (!r.ok) return res.status(401).json({ erro: r.erro, codigo: 'MFA_INVALIDO' });

    await db.query(
      `UPDATE vitima SET senha_hash = $2, falhas_login = 0, bloqueada_ate = NULL, ja_foi_bloqueada = FALSE
        WHERE id_vitima = $1`,
      [r.idVitima, await authService.gerarHashSenha(novaSenha)]
    );

    await authService.encerrarTodasSessoes(r.idVitima);
    await auditoria.registrar('senha_redefinida', { idVitima: r.idVitima, req });
    return res.json({ mensagem: 'Senha alterada. Faça login com a nova senha.' });
  } catch (erro) {
    next(erro);
  }
}

module.exports = {
  cadastrar,
  login,
  verificarMfa,
  reenviarMfa,
  logout,
  esqueciSenha,
  redefinirSenha,
};
