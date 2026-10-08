// Ações de alto nível usadas pelos testes: chamar a API, criar conta e entrar
// com MFA, cadastrar a câmera e simular uma gravação completa.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const { esperar, RAIZ } = require('./ambiente');

const SENHA_PADRAO = 'Senha@123';
const ID_CAMERA = 'esp32cam-01';
const TEMPO_MAXIMO_CODIGO_MS = 30000;
// A IA real em CPU pode demorar; ajuste com TESTE_IA_TEMPO_MAXIMO_S se precisar.
const TEMPO_MAXIMO_ANALISE_MS = (Number(process.env.TESTE_IA_TEMPO_MAXIMO_S) || 600) * 1000;
const FPS_BARRAS_DE_TESTE = 2;
const FPS_VIDEO_DE_REFERENCIA = 4; // próximo do que a ESP32-CAM grava

function criarCliente(ambiente) {
  async function requisicao(metodo, rota, { corpo, token, cabecalhos = {}, formulario } = {}) {
    const headers = { ...cabecalhos };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body = formulario;
    if (corpo !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(corpo);
    }
    const url = rota.startsWith('http') ? rota : `${ambiente.api}${rota}`;
    const inicio = performance.now();
    const resposta = await fetch(url, { method: metodo, headers, body });
    const tempoMs = performance.now() - inicio;
    const tipo = resposta.headers.get('content-type') || '';
    const dados = tipo.includes('json') ? await resposta.json() : Buffer.from(await resposta.arrayBuffer());
    return { status: resposta.status, dados, headers: resposta.headers, tempoMs };
  }

  function quantosCodigos(email, finalidade) {
    return ambiente.textoDoLog().split(`[MFA] Código ${finalidade} para ${email}:`).length - 1;
  }

  // Espera aparecer no log um código MFA novo (posterior aos `jaExistentes`).
  async function lerCodigoNovo(email, finalidade, jaExistentes) {
    const marcador = `[MFA] Código ${finalidade} para ${email}: `;
    const limite = Date.now() + TEMPO_MAXIMO_CODIGO_MS;
    while (Date.now() < limite) {
      const partes = ambiente.textoDoLog().split(marcador);
      if (partes.length - 1 > jaExistentes) return partes[partes.length - 1].slice(0, 6);
      await esperar(50);
    }
    throw new Error(`Código ${finalidade} para ${email} não apareceu no log.`);
  }

  async function pedirCodigo(email, finalidade, acao) {
    const antes = quantosCodigos(email, finalidade);
    const resposta = await acao();
    const codigo = await lerCodigoNovo(email, finalidade, antes);
    return { resposta, codigo };
  }

  async function entrar(email, senha = SENHA_PADRAO) {
    const { resposta, codigo } = await pedirCodigo(email, 'login', () =>
      requisicao('POST', '/auth/login', { corpo: { email, senha } })
    );
    const mfa = await requisicao('POST', '/auth/mfa', { corpo: { mfa_token: resposta.dados.mfa_token, codigo } });
    if (mfa.status !== 200) throw new Error(`MFA falhou: ${JSON.stringify(mfa.dados)}`);
    return mfa.dados.token;
  }

  async function criarConta(email, cpf) {
    const resposta = await requisicao('POST', '/auth/cadastro', { corpo: dadosDeCadastro(email, cpf) });
    if (resposta.status !== 201) throw new Error(`Cadastro falhou: ${JSON.stringify(resposta.dados)}`);
    return entrar(email);
  }

  // Cadastra a câmera no banco (como o npm run chave-dispositivo) e devolve a chave.
  function cadastrarCamera(idCamera = ID_CAMERA) {
    const saida = execFileSync(process.execPath, ['tools/chave-dispositivo.js', idCamera], {
      cwd: RAIZ,
      env: ambiente.env,
    }).toString();
    return /DEVICE_KEY "([0-9a-f]+)"/.exec(saida)[1];
  }

  function cabecalhosDaCamera(chave, idCamera = ID_CAMERA) {
    return { 'X-Dispositivo-Id': idCamera, 'X-Dispositivo-Chave': chave };
  }

  let barrasDeTeste;
  function framesPadrao() {
    barrasDeTeste ??= extrairFrames(path.join(ambiente.pastaTmp, 'barras-de-teste'), FPS_BARRAS_DE_TESTE, [
      '-f', 'lavfi', '-i', `testsrc=size=640x480:rate=${FPS_BARRAS_DE_TESTE}`, '-frames:v', '10',
    ]);
    return barrasDeTeste;
  }

  // Quadros de um vídeo de verdade (ex.: encenação de agressão), na taxa da câmera.
  function framesDoVideo(caminhoDoVideo) {
    return extrairFrames(path.join(ambiente.pastaTmp, 'video-de-referencia'), FPS_VIDEO_DE_REFERENCIA, [
      '-i', caminhoDoVideo, '-vf', `fps=${FPS_VIDEO_DE_REFERENCIA},scale=640:-2`,
    ]);
  }

  function formularioDeFrame(sessionId, indice, { idCamera = ID_CAMERA, tCapturaMs, frames = framesPadrao() } = {}) {
    const formulario = new FormData();
    formulario.append('device_id', idCamera);
    formulario.append('session_id', sessionId);
    formulario.append('frame_index', String(indice));
    formulario.append('timestamp', String(Date.now()));
    formulario.append('t_captura_ms', String(tCapturaMs ?? indice * frames.intervaloMs));
    const imagem = fs.readFileSync(frames.arquivos[indice % frames.arquivos.length]);
    formulario.append('image', new Blob([imagem], { type: 'image/jpeg' }), 'frame.jpg');
    return formulario;
  }

  async function enviarFrame(chave, sessionId, indice, opcoes) {
    return requisicao('POST', '/captura/upload', {
      formulario: formularioDeFrame(sessionId, indice, opcoes),
      cabecalhos: cabecalhosDaCamera(chave),
    });
  }

  async function encerrarSessao(chave, sessionId) {
    return requisicao('POST', '/captura/sessao/encerrar', {
      corpo: { session_id: sessionId },
      cabecalhos: cabecalhosDaCamera(chave),
    });
  }

  async function aguardarGravacao(token, condicao) {
    const limite = Date.now() + TEMPO_MAXIMO_ANALISE_MS;
    while (Date.now() < limite) {
      const { dados } = await requisicao('GET', '/evidencias', { token });
      const encontrada = Array.isArray(dados) && dados.find(condicao);
      if (encontrada) return encontrada;
      await esperar(200);
    }
    throw new Error('A gravação não chegou ao estado esperado a tempo.');
  }

  // Simula a câmera: manda os frames, encerra e espera a análise da IA terminar.
  async function gravarEvidencia(token, chave, { sessionId, quantidadeFrames = 6, frames } = {}) {
    const sessao = sessionId || `${ID_CAMERA}-${Date.now() % 1e9}`;
    const totalDeFrames = frames ? frames.arquivos.length : quantidadeFrames;
    for (let indice = 0; indice < totalDeFrames; indice++) {
      const resposta = await enviarFrame(chave, sessao, indice, { frames });
      if (resposta.status !== 201) throw new Error(`Frame ${indice} recusado: ${JSON.stringify(resposta.dados)}`);
    }
    const { dados: antes } = await requisicao('GET', '/evidencias', { token });
    const idsAnteriores = new Set(antes.map((gravacao) => gravacao.id_gravacao));
    await encerrarSessao(chave, sessao);
    return aguardarGravacao(
      token,
      (gravacao) => !idsAnteriores.has(gravacao.id_gravacao) && gravacao.status_analise === 'Concluido'
    );
  }

  return {
    requisicao,
    pedirCodigo,
    entrar,
    criarConta,
    cadastrarCamera,
    cabecalhosDaCamera,
    formularioDeFrame,
    enviarFrame,
    encerrarSessao,
    aguardarGravacao,
    gravarEvidencia,
    framesDoVideo,
  };
}

function dadosDeCadastro(email, cpf) {
  return {
    nome: 'Maria da Silva',
    cpf,
    email,
    telefone: '(11) 98888-7777',
    senha: SENHA_PADRAO,
    endereco: {
      cep: '01310-100',
      logradouro: 'Av. Paulista',
      numero: '1000',
      complemento: 'ap 12',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      uf: 'SP',
    },
    consentimento: true,
  };
}

// CPF válido (dígitos verificadores corretos) e diferente a cada chamada.
let sequenciaDeCpf = 100000000;
function gerarCpf() {
  const base = String(sequenciaDeCpf++).slice(0, 9).split('').map(Number);
  const digito = (numeros) => {
    const soma = numeros.reduce((total, numero, i) => total + numero * (numeros.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const primeiro = digito(base);
  const segundo = digito([...base, primeiro]);
  return [...base, primeiro, segundo].join('');
}

// Gera JPEGs com o ffmpeg (`entrada` são os argumentos de entrada/filtro) e
// devolve os arquivos na ordem, com o intervalo entre eles.
function extrairFrames(pasta, framesPorSegundo, entrada) {
  if (!fs.existsSync(pasta)) {
    fs.mkdirSync(pasta);
    const resultado = spawnSync(ffmpegPath, ['-loglevel', 'error', ...entrada, '-q:v', '5', path.join(pasta, 'frame_%05d.jpg')]);
    if (resultado.status !== 0) throw new Error(`ffmpeg falhou: ${resultado.stderr}`);
  }
  const arquivos = fs.readdirSync(pasta).sort().map((nome) => path.join(pasta, nome));
  return { arquivos, intervaloMs: 1000 / framesPorSegundo };
}

module.exports = { criarCliente, dadosDeCadastro, gerarCpf, SENHA_PADRAO, ID_CAMERA };
