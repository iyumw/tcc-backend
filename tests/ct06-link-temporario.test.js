// CT06 - Expiração do link do vídeo (RN04). Para não esperar 16 minutos, este
// arquivo sobe o backend com validade de 3 s (URL_VALIDADE_MINUTOS=0.05); o
// comportamento é o mesmo do valor de produção (15 min), conferido no último teste.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente, esperar } = require('./support/ambiente');
const { criarCliente, gerarCpf, ID_CAMERA } = require('./support/cliente');

const VALIDADE_DE_TESTE_MIN = 0.05; // 3 s

describe('CT06 - expiração do link temporário do vídeo', () => {
  let ambiente;
  let cliente;
  let token;
  let gravacao;

  before(async () => {
    ambiente = await iniciarAmbiente({ URL_VALIDADE_MINUTOS: String(VALIDADE_DE_TESTE_MIN) });
    cliente = criarCliente(ambiente);
    const chave = cliente.cadastrarCamera();
    token = await cliente.criarConta('ct06@teste.com', gerarCpf());
    await cliente.requisicao('POST', '/perfil/dispositivo', { token, corpo: { id_dispositivo: ID_CAMERA } });
    gravacao = await cliente.gravarEvidencia(token, chave);
  });
  after(() => ambiente?.encerrar());

  const gerarLink = async () => (await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}/url`, { token })).dados;

  it('dentro da validade o link devolve o vídeo (200)', async () => {
    const antes = Date.now();
    const { url, expira_em: expiraEm } = await gerarLink();

    const validadeS = (new Date(expiraEm).getTime() - antes) / 1000;
    assert.ok(Math.abs(validadeS - VALIDADE_DE_TESTE_MIN * 60) < 1, `validade de ${validadeS} s`);

    const { status, dados, headers } = await cliente.requisicao('GET', url);

    assert.equal(status, 200);
    assert.ok(Buffer.isBuffer(dados) && dados.length > 0);
    assert.match(headers.get('content-type'), /video\/mp4/);
  });

  it('depois da validade o mesmo link é recusado (403, expirado)', async () => {
    const { url } = await gerarLink();

    await esperar(VALIDADE_DE_TESTE_MIN * 60 * 1000 + 1000);
    const { status, dados } = await cliente.requisicao('GET', url);

    assert.equal(status, 403);
    assert.match(dados.erro, /expirad/i);
  });

  it('link com a data de validade alterada é recusado (403)', async () => {
    const { url } = await gerarLink();
    const urlAlterada = url.replace(/expira=(\d+)/, (_, expira) => `expira=${Number(expira) + 3600000}`);

    const { status } = await cliente.requisicao('GET', urlAlterada);

    assert.equal(status, 403);
  });

  it('outra conta não consegue gerar link para o vídeo (403)', async () => {
    const tokenOutra = await cliente.criarConta('ct06-outra@teste.com', gerarCpf());

    const { status } = await cliente.requisicao('GET', `/evidencias/${gravacao.id_gravacao}/url`, { token: tokenOutra });

    assert.equal(status, 403);
  });

  it('sem configuração, o link vale 15 minutos', async () => {
    delete process.env.URL_VALIDADE_MINUTOS;
    process.env.S3_BUCKET = '';
    process.env.URL_SIGNING_SECRET = 'segredo-de-teste';
    const storage = require('../src/services/storageService');
    const antes = Date.now();

    const { expira_em: expiraEm } = await storage.gerarUrlAssinada(1, '/videos/teste.mp4', 'http://localhost');

    const validadeMin = (new Date(expiraEm).getTime() - antes) / 60000;
    assert.ok(Math.abs(validadeMin - 15) < 0.1, `validade de ${validadeMin.toFixed(2)} min`);
  });
});
