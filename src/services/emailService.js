const SMTP_HOST = process.env.SMTP_HOST || '';
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || 'Safe Evidence <nao-responda@safe-evidence.local>';
// Sem SMTP configurado, o código aparece no terminal (pra testar sem e-mail).
const MOSTRAR_NO_TERMINAL = !SMTP_HOST;

let transporte = null;
if (SMTP_HOST) {
  const nodemailer = require('nodemailer');
  const porta = Number(process.env.SMTP_PORT) || 465;
  transporte = nodemailer.createTransport({
    host: SMTP_HOST,
    port: porta,
    secure: porta === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const ASSUNTOS = {
  login: 'Seu código de acesso',
  recuperar_senha: 'Código para redefinir sua senha',
  alterar_dados: 'Código para alterar seus dados',
  excluir_conta: 'Código para excluir sua conta',
};

async function enviar(para, assunto, texto) {
  if (!transporte) {
    console.log(`[Email] (SMTP não configurado) Para: ${para} | ${assunto}\n${texto}`);
    return;
  }
  await transporte.sendMail({ from: EMAIL_FROM, to: para, subject: assunto, text: texto });
}

async function enviarCodigo(para, codigo, finalidade, validadeMinutos) {
  if (MOSTRAR_NO_TERMINAL) {
    console.log(`[MFA] Código ${finalidade} para ${para}: ${codigo}`);
  }

  const texto =
    `Seu código de verificação é: ${codigo}\n\n` +
    `Ele vale por ${validadeMinutos} minutos. Se você não pediu este código, ignore este e-mail.`;
  try {
    await enviar(para, ASSUNTOS[finalidade] || 'Código de verificação', texto);
  } catch (erro) {
    console.error('[Email] Falha ao enviar código:', erro.message);
    throw Object.assign(new Error('Não foi possível enviar o código por e-mail. Tente novamente.'), {
      statusCode: 502,
      publicMessage: 'Não foi possível enviar o código por e-mail. Tente novamente.',
    });
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
