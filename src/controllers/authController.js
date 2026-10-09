const db = require('../config/db');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const auditoria = require('../services/auditoriaService');
const validacao = require('../utils/validacao');
const { envolverControladores } = require('../utils/comTratamentoDeErros');

const BLOQUEIO_TEMPORARIO_MIN = 30;
const FALHAS_ATE_BLOQUEIO_TEMPORARIO = 3;
const FALHAS_ATE_BLOQUEIO_PERMANENTE = 2;

const BLOQUEIO_PERMANENTE = {
  erro: 'Conta bloqueada por excesso de tentativas. Entre em contato com o suporte.',
  codigo: 'BLOQUEIO_PERMANENTE',
};
const CREDENCIAIS_INVALIDAS = { erro: 'E-mail ou senha incorretos.', codigo: 'CREDENCIAIS_INVALIDAS' };
const CAMPOS_ENDERECO_OBRIGATORIOS = ['logradouro', 'numero', 'bairro', 'cidade'];

function lerCadastro(corpo) {
  const endereco = corpo.endereco || {};
  return {
    nome: validacao.texto(corpo.nome),
    cpf: validacao.somenteDigitos(corpo.cpf),
    email: validacao.normalizarEmail(corpo.email),
    telefone: validacao.somenteDigitos(corpo.telefone),
    senha: corpo.senha,
    consentimento: corpo.consentimento,
    endereco: {
      cep: validacao.somenteDigitos(endereco.cep),
      logradouro: validacao.texto(endereco.logradouro),
      numero: validacao.texto(endereco.numero),
      complemento: validacao.texto(endereco.complemento) || null,
      bairro: validacao.texto(endereco.bairro),
      cidade: validacao.texto(endereco.cidade),
      uf: String(endereco.uf || '').toUpperCase(),
    },
  };
}

function validarCadastro(dados) {
  const campos = {};
  if (!validacao.nomeValido(dados.nome)) campos.nome = 'Informe o nome completo.';
  if (!validacao.cpfValido(dados.cpf)) campos.cpf = 'CPF inválido.';
  if (!validacao.emailValido(dados.email)) campos.email = 'E-mail inválido.';
  if (!validacao.telefoneValido(dados.telefone)) campos.telefone = 'Telefone inválido (DDD + número).';
  const faltaNaSenha = validacao.problemasDaSenha(dados.senha);
  if (faltaNaSenha.length) campos.senha = validacao.mensagemSenhaFraca(faltaNaSenha);
  if (dados.endereco.cep.length !== 8) campos['endereco.cep'] = 'CEP inválido.';
  for (const campo of CAMPOS_ENDERECO_OBRIGATORIOS) {
    if (!dados.endereco[campo]) campos[`endereco.${campo}`] = 'Campo obrigatório.';
  }
  if (!validacao.ufValida(dados.endereco.uf)) campos['endereco.uf'] = 'UF inválida.';
  if (dados.consentimento !== true) {
    campos.consentimento = 'É preciso aceitar a Política de Privacidade e o Termo de Consentimento.';
  }
  return campos;
}

async function conflitosDeCadastro(cpf, email) {
  const { rows } = await db.query('SELECT cpf, email FROM vitima WHERE cpf = $1 OR email = $2', [cpf, email]);
  const conflitos = {};
  if (rows.some((conta) => conta.email === email)) conflitos.email = 'E-mail já cadastrado.';
  if (rows.some((conta) => conta.cpf === cpf)) conflitos.cpf = 'CPF já cadastrado.';
  return conflitos;
}

async function cadastrar(req, res) {
  const dados = lerCadastro(req.body || {});
  const campos = validarCadastro(dados);
  if (Object.keys(campos).length) {
    return res.status(400).json({ erro: 'Verifique os campos do cadastro.', campos });
  }

  const conflitos = await conflitosDeCadastro(dados.cpf, dados.email);
  if (Object.keys(conflitos).length) {
    return res.status(409).json({ erro: 'Já existe uma conta com esses dados.', campos: conflitos });
  }

  const { endereco } = dados;
  const { rows } = await db.query(
    `INSERT INTO vitima (nome, cpf, telefone, email, consentimento, consentimento_em, senha_hash,
                         cep, logradouro, numero, complemento, bairro, cidade, uf)
     VALUES ($1, $2, $3, $4, TRUE, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id_vitima`,
    [
      dados.nome.slice(0, 100), dados.cpf, dados.telefone, dados.email,
      await authService.gerarHashSenha(dados.senha),
      endereco.cep, endereco.logradouro.slice(0, 150), endereco.numero.slice(0, 20),
      endereco.complemento && endereco.complemento.slice(0, 100),
      endereco.bairro.slice(0, 100), endereco.cidade.slice(0, 100), endereco.uf,
    ]
  );
  const idVitima = rows[0].id_vitima;

  await auditoria.registrar('cadastro', { idVitima, req });
  emailService.enviarBoasVindas(dados.email, dados.nome);

  return res.status(201).json({ id_vitima: idVitima, mensagem: 'Cadastro concluído. Faça login para continuar.' });
}

function mascararEmail(email) {
  const [usuario, dominio] = email.split('@');
  return `${usuario.slice(0, 2)}${'*'.repeat(Math.max(usuario.length - 2, 1))}@${dominio}`;
}

async function buscarContaParaLogin(email) {
  const { rows } = await db.query(
    `SELECT id_vitima, email, senha_hash, bloqueio_permanente,
            bloqueada_ate > NOW() AS bloqueada_agora,
            CEIL(EXTRACT(EPOCH FROM (bloqueada_ate - NOW())) / 60) AS minutos_restantes
       FROM vitima WHERE email = $1`,
    [email]
  );
  return rows[0];
}

// O contador é incrementado no próprio banco: tentativas simultâneas não passam do limite.
async function incrementarFalhas(idVitima) {
  const { rows } = await db.query(
    `UPDATE vitima SET falhas_login = falhas_login + 1 WHERE id_vitima = $1
      RETURNING falhas_login, ja_foi_bloqueada`,
    [idVitima]
  );
  return rows[0];
}

async function bloquearPermanentemente(idVitima, req) {
  await db.query('UPDATE vitima SET falhas_login = 0, bloqueio_permanente = TRUE WHERE id_vitima = $1', [idVitima]);
  await auditoria.registrar('bloqueio_permanente', { idVitima, req });
  return { status: 423, corpo: BLOQUEIO_PERMANENTE };
}

async function bloquearTemporariamente(idVitima, req) {
  await db.query(
    `UPDATE vitima SET falhas_login = 0, ja_foi_bloqueada = TRUE,
            bloqueada_ate = NOW() + ($2 * INTERVAL '1 minute')
      WHERE id_vitima = $1`,
    [idVitima, BLOQUEIO_TEMPORARIO_MIN]
  );
  await auditoria.registrar('bloqueio_temporario', { idVitima, req });
  return {
    status: 423,
    corpo: {
      erro: `Muitas tentativas incorretas. Conta bloqueada por ${BLOQUEIO_TEMPORARIO_MIN} min.`,
      codigo: 'BLOQUEIO_TEMPORARIO',
      minutos_restantes: BLOQUEIO_TEMPORARIO_MIN,
    },
  };
}

async function registrarFalhaDeLogin(idVitima, req) {
  const { falhas_login: falhas, ja_foi_bloqueada: jaFoiBloqueada } = await incrementarFalhas(idVitima);

  if (jaFoiBloqueada && falhas >= FALHAS_ATE_BLOQUEIO_PERMANENTE) return bloquearPermanentemente(idVitima, req);
  if (!jaFoiBloqueada && falhas >= FALHAS_ATE_BLOQUEIO_TEMPORARIO) return bloquearTemporariamente(idVitima, req);

  await auditoria.registrar('login_falha', { idVitima, detalhes: { falhas }, req });
  return { status: 401, corpo: CREDENCIAIS_INVALIDAS };
}

async function login(req, res) {
  const email = validacao.normalizarEmail(req.body && req.body.email);
  const senha = (req.body && req.body.senha) || '';
  const conta = await buscarContaParaLogin(email);

  // A senha é conferida em todos os casos (conta inexistente ou bloqueada), para o
  // tempo de resposta não revelar nada sobre a conta.
  const senhaCorreta = await authService.conferirSenha(senha, conta ? conta.senha_hash : null);

  if (conta && conta.bloqueio_permanente) {
    await auditoria.registrar('login_negado_bloqueio_permanente', { idVitima: conta.id_vitima, req });
    return res.status(423).json(BLOQUEIO_PERMANENTE);
  }
  if (conta && conta.bloqueada_agora) {
    await auditoria.registrar('login_negado_bloqueio_temporario', { idVitima: conta.id_vitima, req });
    return res.status(423).json({
      erro: `Conta bloqueada temporariamente. Tente de novo em ${conta.minutos_restantes} min.`,
      codigo: 'BLOQUEIO_TEMPORARIO',
      minutos_restantes: Number(conta.minutos_restantes),
    });
  }
  if (!conta) {
    await auditoria.registrar('login_falha_email_desconhecido', { req });
    return res.status(401).json(CREDENCIAIS_INVALIDAS);
  }
  if (!senhaCorreta) {
    const { status, corpo } = await registrarFalhaDeLogin(conta.id_vitima, req);
    return res.status(status).json(corpo);
  }

  await db.query(
    'UPDATE vitima SET falhas_login = 0, ja_foi_bloqueada = FALSE, bloqueada_ate = NULL WHERE id_vitima = $1',
    [conta.id_vitima]
  );
  const { idCodigo, validadeMinutos } = await authService.enviarCodigo(conta.id_vitima, conta.email, 'login');
  await auditoria.registrar('login_senha_ok_mfa_enviado', { idVitima: conta.id_vitima, req });

  return res.json({
    mfa_token: idCodigo,
    validade_minutos: validadeMinutos,
    email_mascarado: mascararEmail(conta.email),
    mensagem: 'Enviamos um código de 6 dígitos para o seu e-mail.',
  });
}

async function verificarMfa(req, res) {
  const { mfa_token: mfaToken, codigo } = req.body || {};
  if (!validacao.ehUuid(mfaToken)) return res.status(400).json({ erro: 'mfa_token inválido.' });

  const resultado = await authService.conferirCodigo({ idCodigo: mfaToken, finalidade: 'login', codigo });
  if (!resultado.ok) {
    await auditoria.registrar('mfa_falha', { detalhes: { mfa_token: mfaToken }, req });
    return res.status(401).json({ erro: resultado.erro, codigo: 'MFA_INVALIDO' });
  }

  const sessao = await authService.criarSessao(resultado.idVitima);
  const { rows } = await db.query('SELECT id_vitima, nome, email FROM vitima WHERE id_vitima = $1', [resultado.idVitima]);
  await auditoria.registrar('login_sucesso', { idVitima: resultado.idVitima, req });

  return res.json({ ...sessao, usuario: rows[0] });
}

async function reenviarMfa(req, res) {
  const { mfa_token: mfaToken } = req.body || {};
  if (!validacao.ehUuid(mfaToken)) return res.status(400).json({ erro: 'mfa_token inválido.' });

  const { rows } = await db.query(
    `SELECT codigo.id_vitima, vitima.email FROM codigo_mfa codigo JOIN vitima ON vitima.id_vitima = codigo.id_vitima
      WHERE codigo.id_codigo = $1 AND codigo.finalidade = 'login' AND codigo.criado_em > NOW() - INTERVAL '15 minutes'`,
    [mfaToken]
  );
  if (!rows.length) return res.status(401).json({ erro: 'Faça login novamente.', codigo: 'MFA_EXPIRADO' });

  const { idCodigo, validadeMinutos } = await authService.enviarCodigo(rows[0].id_vitima, rows[0].email, 'login');
  return res.json({ mfa_token: idCodigo, validade_minutos: validadeMinutos });
}

async function logout(req, res) {
  await authService.encerrarSessao(req.usuario.idSessao);
  await auditoria.registrar('logout', { idVitima: req.usuario.idVitima, req });
  return res.status(204).end();
}

// Responde sempre igual, exista ou não o e-mail, para não revelar quem tem conta.
async function esqueciSenha(req, res) {
  const email = validacao.normalizarEmail(req.body && req.body.email);
  const { rows } = await db.query('SELECT id_vitima, email, bloqueio_permanente FROM vitima WHERE email = $1', [email]);
  const conta = rows[0];
  if (conta && !conta.bloqueio_permanente) {
    await authService.enviarCodigo(conta.id_vitima, conta.email, 'recuperar_senha');
    await auditoria.registrar('recuperacao_senha_solicitada', { idVitima: conta.id_vitima, req });
  }
  return res.json({ mensagem: 'Se o e-mail estiver cadastrado, enviamos um código para ele.' });
}

async function redefinirSenha(req, res) {
  const email = validacao.normalizarEmail(req.body && req.body.email);
  const { codigo, nova_senha: novaSenha } = req.body || {};

  const faltaNaSenha = validacao.problemasDaSenha(novaSenha);
  if (faltaNaSenha.length) {
    return res.status(400).json({ erro: validacao.mensagemSenhaFraca(faltaNaSenha), campos: { nova_senha: faltaNaSenha } });
  }

  const { rows } = await db.query('SELECT id_vitima FROM vitima WHERE email = $1', [email]);
  if (!rows.length) return res.status(401).json({ erro: 'Código inválido. Peça um novo código.' });

  const resultado = await authService.conferirCodigo({ idVitima: rows[0].id_vitima, finalidade: 'recuperar_senha', codigo });
  if (!resultado.ok) return res.status(401).json({ erro: resultado.erro, codigo: 'MFA_INVALIDO' });

  await db.query(
    `UPDATE vitima SET senha_hash = $2, falhas_login = 0, bloqueada_ate = NULL, ja_foi_bloqueada = FALSE
      WHERE id_vitima = $1`,
    [resultado.idVitima, await authService.gerarHashSenha(novaSenha)]
  );
  await authService.encerrarTodasSessoes(resultado.idVitima);
  await auditoria.registrar('senha_redefinida', { idVitima: resultado.idVitima, req });

  return res.json({ mensagem: 'Senha alterada. Faça login com a nova senha.' });
}

module.exports = envolverControladores({
  cadastrar,
  login,
  verificarMfa,
  reenviarMfa,
  logout,
  esqueciSenha,
  redefinirSenha,
});
