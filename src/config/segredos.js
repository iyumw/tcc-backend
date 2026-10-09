// Em produção, segredo ausente impede o backend de subir: com um valor
// aleatório, tokens e links passariam a falhar a cada reinício.
const crypto = require('crypto');

const EM_PRODUCAO = process.env.NODE_ENV === 'production';

function lerSegredo(nome, { obrigatorio = true } = {}) {
  const valor = process.env[nome];
  if (valor) return valor;
  if (EM_PRODUCAO && obrigatorio) {
    throw new Error(`${nome} não definido. Em produção ele é obrigatório (veja o .env.example).`);
  }
  if (obrigatorio) {
    console.warn(`[Config] ${nome} não definido: usando um valor aleatório (vale só até o backend reiniciar).`);
  }
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { EM_PRODUCAO, lerSegredo };
