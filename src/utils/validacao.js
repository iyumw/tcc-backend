const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function somenteDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function texto(valor) {
  return String(valor || '').trim();
}

function normalizarEmail(email) {
  return texto(email).toLowerCase();
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function cpfValido(cpf) {
  const digitos = somenteDigitos(cpf);
  if (digitos.length !== 11 || /^(\d)\1{10}$/.test(digitos)) return false;
  const digitoVerificador = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return (
    digitoVerificador(digitos.slice(0, 9)) === Number(digitos[9]) &&
    digitoVerificador(digitos.slice(0, 10)) === Number(digitos[10])
  );
}

function telefoneValido(digitos) {
  return digitos.length === 10 || digitos.length === 11;
}

function ufValida(uf) {
  return /^[A-Za-z]{2}$/.test(String(uf || ''));
}

function nomeValido(nome) {
  return texto(nome).length >= 3;
}

function problemasDaSenha(senha) {
  const valor = String(senha || '');
  const faltando = [];
  if (valor.length < 8) faltando.push('pelo menos 8 caracteres');
  if (!/[A-Z]/.test(valor)) faltando.push('uma letra maiúscula');
  if (!/[a-z]/.test(valor)) faltando.push('uma letra minúscula');
  if (!/[0-9]/.test(valor)) faltando.push('um número');
  if (!/[^A-Za-z0-9]/.test(valor)) faltando.push('um caractere especial');
  return faltando;
}

function mensagemSenhaFraca(faltando) {
  return `A senha precisa ter: ${faltando.join(', ')}.`;
}

function ehUuid(valor) {
  return UUID.test(String(valor || ''));
}

function lerIdPositivo(valor) {
  const id = Number(valor);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function ehPercentual(valor) {
  return Number.isFinite(valor) && valor >= 0 && valor <= 100;
}

function numeroOuNulo(valor) {
  return valor === null || valor === undefined ? null : Number(valor);
}

module.exports = {
  somenteDigitos,
  texto,
  normalizarEmail,
  emailValido,
  cpfValido,
  telefoneValido,
  ufValida,
  nomeValido,
  problemasDaSenha,
  mensagemSenhaFraca,
  ehUuid,
  lerIdPositivo,
  ehPercentual,
  numeroOuNulo,
};
