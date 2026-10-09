// Contrato com o serviço de IA: docs/contrato-ia.md
const IA_SERVICE_URL = (process.env.IA_SERVICE_URL || '').replace(/\/+$/, '');
const IA_TOKEN = process.env.IA_TOKEN || '';

function iaConfigurada() {
  return Boolean(IA_SERVICE_URL);
}

function cabecalhosDaIa() {
  return {
    'Content-Type': 'application/json',
    ...(IA_TOKEN ? { Authorization: `Bearer ${IA_TOKEN}` } : {}),
  };
}

function postarParaIa(caminho, corpo, timeoutMs) {
  return fetch(`${IA_SERVICE_URL}${caminho}`, {
    method: 'POST',
    headers: cabecalhosDaIa(),
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function descreverFalhaDeEnvio(erro, timeoutMs) {
  if (erro.name === 'TimeoutError') return `serviço de IA não respondeu em ${timeoutMs / 1000} s`;
  const codigo = erro.cause && erro.cause.code;
  if (codigo) return `serviço de IA inacessível em ${IA_SERVICE_URL} (${codigo})`;
  return erro.message;
}

module.exports = { IA_SERVICE_URL, iaConfigurada, postarParaIa, descreverFalhaDeEnvio };
