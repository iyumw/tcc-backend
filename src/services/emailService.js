const { erroHttp } = require('../utils/erros');
const { EM_PRODUCAO } = require('../config/segredos');

const SMTP_HOST = process.env.SMTP_HOST || '';
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || 'Safe Evidence <nao-responda@safe-evidence.local>';

const ASSUNTOS = {
  login: 'Seu código de acesso',
  recuperar_senha: 'Código para redefinir sua senha',
  alterar_dados: 'Código para alterar seus dados',
  excluir_conta: 'Código para excluir sua conta',
};

function criarTransporte() {
  if (!SMTP_HOST) return null;
  const nodemailer = require('nodemailer');
  const porta = Number(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: porta,
    secure: porta === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const transporte = criarTransporte();
if (!transporte && EM_PRODUCAO) {
  console.error('[Email] SMTP_HOST não definido: os códigos de acesso não serão enviados.');
}

async function enviar(para, assunto, texto) {
  if (!transporte) {
    if (EM_PRODUCAO) throw new Error('SMTP não configurado.');
    console.log(`[Email] (SMTP não configurado) Para: ${para} | ${assunto}\n${texto}`);
    return;
  }
  await transporte.sendMail({ from: EMAIL_FROM, to: para, subject: assunto, text: texto });
}

async function enviarCodigo(para, codigo, finalidade, validadeMinutos) {
  // Sem SMTP, o código vai para o terminal para testar sem e-mail (nunca em produção).
  if (!transporte && !EM_PRODUCAO) console.log(`[MFA] Código ${finalidade} para ${para}: ${codigo}`);

  const texto =
    `Seu código de verificação é: ${codigo}\n\n` +
    `Ele vale por ${validadeMinutos} minutos. Se você não pediu este código, ignore este e-mail.`;
  try {
    await enviar(para, ASSUNTOS[finalidade] || 'Código de verificação', texto);
  } catch (erro) {
    console.error('[Email] Falha ao enviar código:', erro.message);
    throw erroHttp(502, 'Não foi possível enviar o código por e-mail. Tente novamente.');
  }
}

async function enviarBoasVindas(para, nome) {
  try {
    await enviar(
      para,
      'Cadastro confirmado',
      `Olá, ${nome}.\n\nSeu cadastro foi concluído. Você já pode entrar no portal com seu e-mail e senha.`
    );
  } catch (erro) {
    console.error('[Email] Falha ao enviar boas-vindas:', erro.message);
  }
}

module.exports = { enviarCodigo, enviarBoasVindas };
