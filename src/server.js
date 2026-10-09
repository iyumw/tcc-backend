require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const capturaRoutes = require('./routes/capturaRoutes');
const iaRoutes = require('./routes/iaRoutes');
const authRoutes = require('./routes/authRoutes');
const perfilRoutes = require('./routes/perfilRoutes');
const evidenciaRoutes = require('./routes/evidenciaRoutes');
const pipelineIA = require('./services/pipelineIAService');
const carimbo = require('./services/carimboTempoService');
const { retomarFinalizacoesInterrompidas } = require('./controllers/capturaController');
const { encerrarConexoesSse } = require('./controllers/evidenciaController');
const { tratarErros, rotaNaoEncontrada } = require('./middleware/tratadorDeErros');
const { EM_PRODUCAO } = require('./config/segredos');
const { garantirPastas } = require('./config/paths');
const db = require('./config/db');

// O callback da IA traz uma entrada por segundo do vídeo; 2 MB cobre horas de gravação.
const LIMITE_CORPO_JSON = '2mb';
const PRAZO_DESLIGAMENTO_MS = 10000;
// Parâmetros que dão acesso (token do SSE, assinatura dos links) não vão para o log.
const PARAMETROS_SIGILOSOS = /([?&](?:token|assinatura)=)[^&]*/gi;

garantirPastas();

const app = express();

// Atrás do Caddy: usa o IP e o protocolo que ele repassa.
app.set('trust proxy', 1);

app.use(helmet());

const origensPermitidas = (process.env.FRONT_URL || 'http://localhost:4200')
  .split(',')
  .map((origem) => origem.trim())
  .filter(Boolean);
app.use(cors({ origin: origensPermitidas, exposedHeaders: ['Content-Disposition', 'X-Laudo-SHA256', 'X-Codigo-Verificacao', 'X-Total-Count'] }));
app.use(express.json({ limit: LIMITE_CORPO_JSON }));

morgan.token('url-segura', (req) => req.originalUrl.replace(PARAMETROS_SIGILOSOS, '$1***'));
const FORMATO_LOG = EM_PRODUCAO
  ? ':remote-addr [:date[iso]] ":method :url-segura" :status :res[content-length] - :response-time ms'
  : ':method :url-segura :status :response-time ms - :res[content-length]';
app.use(morgan(FORMATO_LOG));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/captura', capturaRoutes);
app.use('/api/ia', iaRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/perfil', perfilRoutes);
app.use('/api/evidencias', evidenciaRoutes);

app.use(rotaNaoEncontrada);
app.use(tratarErros);

const PORT = process.env.PORT || 8080;
const servidor = app.listen(PORT, () => {
  console.log(`[Safe Evidence] Backend rodando na porta ${PORT}`);
  pipelineIA.iniciarVerificacaoPeriodica();
  carimbo.iniciarCarimboPeriodico();
  retomarFinalizacoesInterrompidas().catch((erro) =>
    console.error('[Captura] Erro ao retomar montagens interrompidas:', erro)
  );
});

// systemd (SIGTERM) e Ctrl+C (SIGINT): para de aceitar conexões, fecha o SSE e o banco.
function desligar(sinal) {
  console.log(`[Safe Evidence] ${sinal} recebido: desligando.`);
  pipelineIA.pararVerificacaoPeriodica();
  carimbo.pararCarimboPeriodico();
  encerrarConexoesSse();
  servidor.close(async () => {
    await db.pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), PRAZO_DESLIGAMENTO_MS).unref();
}

process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
