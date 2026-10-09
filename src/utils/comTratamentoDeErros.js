// Repassa ao tratadorDeErros qualquer erro de um controller assíncrono.
function comTratamentoDeErros(controlador) {
  return (req, res, next) => Promise.resolve(controlador(req, res, next)).catch(next);
}

function envolverControladores(controladores) {
  return Object.fromEntries(
    Object.entries(controladores).map(([nome, controlador]) => [nome, comTratamentoDeErros(controlador)])
  );
}

module.exports = { comTratamentoDeErros, envolverControladores };
