// Sobe um backend isolado para cada arquivo de teste: banco de dados próprio
// (criado e apagado no fim), pasta temporária própria e e-mail desligado (os
// códigos MFA aparecem no log, de onde os testes leem). A análise é feita pelo
// serviço de IA real (YOLOv9), que precisa estar rodando no mesmo computador.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { iniciarTsaFalsa } = require('./tsaFalsa');

const RAIZ = path.join(__dirname, '..', '..');
const SCRIPTS_DO_BANCO = [
  'schema.sql',
  'migrations/002_pipeline_ia.sql',
  'migrations/003_autenticacao.sql',
  'migrations/004_renomear_codigo_mfa.sql',
  'migrations/005_chave_dispositivo.sql',
  'migrations/006_laudo_ia.sql',
  'migrations/007_finalizacao_idempotente.sql',
  'migrations/008_carimbo_tempo.sql',
];
const TEMPO_MAXIMO_SUBIDA_MS = 15000;

// Postgres usado só para criar e apagar os bancos de teste (padrão: o do docker-compose).
const CONEXAO_ADMIN = {
  host: process.env.TESTE_DB_HOST || 'localhost',
  port: Number(process.env.TESTE_DB_PORT) || 5432,
  user: process.env.TESTE_DB_USER || 'postgres',
  password: process.env.TESTE_DB_PASSWORD || 'postgres',
  database: 'postgres',
  ssl: process.env.TESTE_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
};

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Endereço e tokens da IA real: os mesmos do .env do backend (com que a IA foi
// iniciada), a menos que TESTE_IA_URL, TESTE_IA_TOKEN e TESTE_IA_CALLBACK_TOKEN sejam definidos.
function configuracaoDaIa() {
  const arquivoEnv = path.join(RAIZ, '.env');
  const doEnv = fs.existsSync(arquivoEnv) ? dotenv.parse(fs.readFileSync(arquivoEnv)) : {};
  return {
    url: (process.env.TESTE_IA_URL || doEnv.IA_SERVICE_URL || 'http://127.0.0.1:8090').replace(/\/+$/, ''),
    token: process.env.TESTE_IA_TOKEN ?? doEnv.IA_TOKEN ?? '',
    tokenCallback: process.env.TESTE_IA_CALLBACK_TOKEN ?? doEnv.IA_CALLBACK_TOKEN ?? '',
  };
}

async function exigirIaNoAr(ia) {
  const instrucao =
    'Suba a IA real antes dos testes (pasta Projeto_YOLO_violencia):\n' +
    '  uvicorn servico.app:app --host 127.0.0.1 --port 8090\n' +
    'com IA_TOKEN e IA_CALLBACK_TOKEN iguais aos do .env do backend.';
  if (!ia.tokenCallback) throw new Error(`IA_CALLBACK_TOKEN não definido.\n${instrucao}`);
  try {
    const resposta = await fetch(`${ia.url}/saude`, { headers: { Authorization: `Bearer ${ia.token}` } });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const saude = await resposta.json();
    if (!saude.modelo_carregado) throw new Error('modelo não carregado; use CARREGAR_NA_SUBIDA=1');
    return saude.versao_modelo;
  } catch (erro) {
    throw new Error(`A IA não respondeu em ${ia.url}/saude (${erro.message}).\n${instrucao}`);
  }
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      servidor.close(() => resolve(port));
    });
  });
}

async function comAdmin(acao) {
  const cliente = new Client(CONEXAO_ADMIN);
  await cliente.connect();
  try {
    return await acao(cliente);
  } finally {
    await cliente.end();
  }
}

async function criarBanco(nomeBanco) {
  await comAdmin((cliente) => cliente.query(`CREATE DATABASE ${nomeBanco}`));
  const cliente = new Client({ ...CONEXAO_ADMIN, database: nomeBanco });
  await cliente.connect();
  for (const script of SCRIPTS_DO_BANCO) {
    await cliente.query(fs.readFileSync(path.join(RAIZ, 'src', 'db', script), 'utf8'));
  }
  return cliente;
}

// Junta stdout e stderr de um processo num texto só, para os testes lerem o log.
function iniciarProcesso(script, env, log) {
  const processo = spawn(process.execPath, [script], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const acumular = (dados) => log.push(dados.toString());
  processo.stdout.on('data', acumular);
  processo.stderr.on('data', acumular);
  return processo;
}

// Espera o processo aceitar conexões (qualquer resposta HTTP serve).
async function aguardarNoAr(url) {
  const limite = Date.now() + TEMPO_MAXIMO_SUBIDA_MS;
  while (Date.now() < limite) {
    try {
      await fetch(url);
      return;
    } catch {
      // ainda subindo
    }
    await esperar(100);
  }
  throw new Error(`O processo não respondeu em ${url} a tempo.`);
}

/**
 * Confere a IA real e sobe banco e backend. `variaveisExtras` sobrescreve o .env de teste
 * (ex.: { URL_VALIDADE_MINUTOS: '0.05' } para testar a expiração do link).
 */
async function iniciarAmbiente(variaveisExtras = {}) {
  const sufixo = crypto.randomBytes(4).toString('hex');
  const nomeBanco = `teste_safe_evidence_${sufixo}`;
  const pastaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-evidence-teste-'));
  const ia = configuracaoDaIa();
  const versaoDoModelo = await exigirIaNoAr(ia);
  const portaBackend = await portaLivre();
  const urlBase = `http://127.0.0.1:${portaBackend}`;

  const banco = await criarBanco(nomeBanco);
  const tsa = await iniciarTsaFalsa();

  // Todas as variáveis lidas pelo backend são definidas aqui: assim o dotenv
  // não completa nada com o .env de verdade (RDS, S3, Gmail).
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(portaBackend),
    PUBLIC_BASE_URL: urlBase,
    FRONT_URL: 'http://localhost:4200',
    PASTA_TMP: pastaTmp,
    DB_HOST: CONEXAO_ADMIN.host,
    DB_PORT: String(CONEXAO_ADMIN.port),
    DB_NAME: nomeBanco,
    DB_USER: CONEXAO_ADMIN.user,
    DB_PASSWORD: CONEXAO_ADMIN.password,
    DB_SSL: CONEXAO_ADMIN.ssl ? 'true' : 'false',
    DB_SSL_CA: '',
    S3_BUCKET: '',
    AWS_REGION: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    URL_VALIDADE_MINUTOS: '15',
    URL_SIGNING_SECRET: 'segredo-de-teste-urls',
    JWT_SECRET: 'segredo-de-teste-jwt',
    SESSAO_INATIVIDADE_MINUTOS: '15',
    SESSAO_MAX_HORAS: '8',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: '',
    IA_SERVICE_URL: ia.url,
    IA_TOKEN: ia.token,
    IA_CALLBACK_TOKEN: ia.tokenCallback,
    IA_MAX_TENTATIVAS: '5',
    IA_TIMEOUT_MINUTOS: '30',
    TSA_URL: tsa.url,
    ...variaveisExtras,
  };

  const log = [];
  const backend = iniciarProcesso('src/server.js', env, log);
  await aguardarNoAr(`${urlBase}/health`);

  async function encerrar() {
    backend.kill();
    await tsa.encerrar();
    await banco.end();
    await esperar(300);
    await comAdmin((cliente) => cliente.query(`DROP DATABASE IF EXISTS ${nomeBanco} WITH (FORCE)`));
    fs.rmSync(pastaTmp, { recursive: true, force: true });
  }

  return {
    api: `${urlBase}/api`,
    urlBase,
    env,
    banco,
    tsa,
    pastaTmp,
    versaoDoModelo,
    textoDoLog: () => log.join(''),
    encerrar,
  };
}

module.exports = { iniciarAmbiente, esperar, RAIZ };
