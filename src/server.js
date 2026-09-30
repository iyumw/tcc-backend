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
const errorHandler = require('./middleware/errorHandler');
const { garantirPastas } = require('./config/paths');

garantirPastas();

const app = express();

// Atrás do Caddy: usa o IP e o protocolo que ele repassa.
app.set('trust proxy', 1);

app.use(helmet());

const origensPermitidas = (process.env.FRONT_URL || 'http://localhost:4200')
  .split(',')
  .map((origem) => origem.trim())
  .filter(Boolean);
app.use(cors({ origin: origensPermitidas, exposedHeaders: ['Content-Disposition', 'X-Laudo-SHA256'] }));
app.use(express.json());

app.use(morgan('dev'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/captura', capturaRoutes);
app.use('/api/evidencia', capturaRoutes); // endereço antigo da captura
app.use('/api/ia', iaRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/perfil', perfilRoutes);
app.use('/api/evidencias', evidenciaRoutes);

app.use(errorHandler);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[Safe Evidence] Backend rodando na porta ${PORT}`);
  pipelineIA.iniciarVerificacaoPeriodica();
});
