// CT08 - Atualização do status em tempo real (RE08), parte do backend: o
// portal recebe a mudança de status por uma conexão aberta (SSE), sem
// precisar ficar perguntando (polling). A atualização da tela é conferida no front.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const ATRASO_MAXIMO_MS = 5000;

// Lê eventos "status_analise" do SSE até chegar o "Concluido".
async function lerEventosAteConcluir(resposta) {
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const eventos = [];
  let pendente = '';
  for (;;) {
    const { value, done } = await leitor.read();
    if (done) return eventos;
    pendente += decodificador.decode(value, { stream: true });
    const blocos = pendente.split('\n\n');
    pendente = blocos.pop();
    for (const bloco of blocos) {
      if (!bloco.startsWith('event: status_analise')) continue;
      const dados = JSON.parse(bloco.split('data: ')[1]);
      eventos.push(dados);
      if (dados.status_analise === 'Concluido') return eventos;
    }
  }
}

describe('CT08 - status da análise em tempo real (backend)', () => {
  let ambiente;
  let cliente;
  let token;
  let chave;

  before(async () => {
    ambiente = await iniciarAmbiente();
    cliente = criarCliente(ambiente);
    chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('ct08@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
  });
  after(() => ambiente?.encerrar());

  it('envia Processando e Concluido pela conexão aberta, até 5 s depois de concluir', async (contexto) => {
    const conexao = new AbortController();
    const fluxo = await fetch(`${ambiente.api}/evidencias/eventos?token=${token}`, { signal: conexao.signal });
    assert.equal(fluxo.status, 200);
    assert.match(fluxo.headers.get('content-type'), /text\/event-stream/);
    const eventosPromessa = lerEventosAteConcluir(fluxo);

    const sessionId = `${ID_CAMERA}-8001`;
    for (let indice = 0; indice < 4; indice++) await cliente.enviarFrame(chave, sessionId, indice);
    await cliente.encerrarSessao(chave, sessionId);
    const eventos = await eventosPromessa;
    // Calculado pelo relógio do banco, que é o mesmo que gravou a conclusão.
    const { rows } = await ambiente.banco.query(
      'SELECT EXTRACT(EPOCH FROM (NOW() - concluida_em)) * 1000 AS atraso_ms FROM analise_ia'
    );
    conexao.abort();

    const status = eventos.map((evento) => evento.status_analise);
    assert.ok(status.includes('Processando'), `eventos recebidos: ${status.join(', ')}`);
    assert.equal(status.at(-1), 'Concluido');

    const atrasoMs = Number(rows[0].atraso_ms);
    assert.ok(atrasoMs <= ATRASO_MAXIMO_MS, `evento chegou ${atrasoMs} ms depois da conclusão`);
    contexto.diagnostic(`eventos: ${status.join(' -> ')}; Concluido chegou ${atrasoMs.toFixed(0)} ms depois da conclusão`);
  });

  it('a conexão de eventos exige login', async () => {
    const { status } = await cliente.requisicao('GET', '/evidencias/eventos');

    assert.equal(status, 401);
  });
});
