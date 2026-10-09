// Contagem em memória: vale para uma instância do backend, que é o caso do projeto.
const LIMPEZA_MS = 60 * 1000;

const janelas = new Map();

const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [chave, janela] of janelas) {
    if (janela.terminaEm <= agora) janelas.delete(chave);
  }
}, LIMPEZA_MS);
limpeza.unref();

function contar(chave, janelaMs) {
  const agora = Date.now();
  const janela = janelas.get(chave);
  if (!janela || janela.terminaEm <= agora) {
    const nova = { total: 1, terminaEm: agora + janelaMs };
    janelas.set(chave, nova);
    return nova;
  }
  janela.total += 1;
  return janela;
}

function emailDoCorpo(req) {
  return String((req.body && req.body.email) || '').trim().toLowerCase();
}

/**
 * @param {object} opcoes
 * @param {string} opcoes.nome      identifica o limite (ex.: "login")
 * @param {number} opcoes.maximo    requisições permitidas por janela
 * @param {number} opcoes.janelaMin tamanho da janela, em minutos
 * @param {boolean} [opcoes.porEmail] conta também por e-mail do corpo, além do IP
 */
function limitarTaxa({ nome, maximo, janelaMin, porEmail = false }) {
  const janelaMs = janelaMin * 60 * 1000;
  return function limitar(req, res, next) {
    const chaves = [`${nome}:ip:${req.ip}`];
    const email = porEmail && emailDoCorpo(req);
    if (email) chaves.push(`${nome}:email:${email}`);

    const janelaMaisCheia = chaves
      .map((chave) => contar(chave, janelaMs))
      .reduce((maior, janela) => (janela.total > maior.total ? janela : maior));

    if (janelaMaisCheia.total <= maximo) return next();

    const segundosRestantes = Math.ceil((janelaMaisCheia.terminaEm - Date.now()) / 1000);
    res.set('Retry-After', String(segundosRestantes));
    return res.status(429).json({
      erro: `Muitas tentativas. Tente de novo em ${Math.ceil(segundosRestantes / 60)} min.`,
      codigo: 'MUITAS_TENTATIVAS',
    });
  };
}

module.exports = { limitarTaxa };
