const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const storage = require('../services/storageService');
const pipelineIA = require('../services/pipelineIAService');
const eventos = require('../services/eventosService');
const auditoria = require('../services/auditoriaService');
const authService = require('../services/authService');
const evidencias = require('../services/evidenciaService');
const { calcularHashDeStream } = require('../services/custodiaService');
const { lerIdPositivo, numeroOuNulo } = require('../utils/validacao');

const INTERVALO_BATIMENTO_SSE_MS = 25000;

async function gravacaoDaUsuaria(req, res, acao) {
  const id = lerIdPositivo(req.params.id);
  if (id === null) {
    res.status(400).json({ erro: 'id inválido.' });
    return null;
  }
  const { gravacao, status } = await evidencias.buscarDaUsuaria(id, req.usuario.idVitima);
  if (status === 404) {
    res.status(404).json({ erro: 'Evidência não encontrada.' });
    return null;
  }
  if (status === 403) {
    await auditoria.registrar('acesso_negado', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: id, acao },
      req,
    });
    res.status(403).json({ erro: 'Você não tem acesso a esta evidência.' });
    return null;
  }
  return gravacao;
}

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

async function listar(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT g.id_gravacao, a.data_hora AS gravada_em, a.id_device AS dispositivo,
              g.duracao_segundos, g.status_analise, g.processo_judicial,
              ia.veredicto, ia.score
         FROM gravacao g
         JOIN acionamento a ON a.id_acionamento = g.id_acionamento
         LEFT JOIN analise_ia ia ON ia.id_gravacao = g.id_gravacao
        WHERE a.id_vitima = $1
        ORDER BY a.data_hora DESC`,
      [req.usuario.idVitima]
    );
    return res.json(
      rows.map((linha) => ({
        id_gravacao: linha.id_gravacao,
        gravada_em: linha.gravada_em,
        dispositivo: linha.dispositivo,
        duracao_segundos: numeroOuNulo(linha.duracao_segundos),
        status_analise: linha.status_analise,
        veredicto: linha.veredicto,
        score: numeroOuNulo(linha.score),
        vinculada_a_processo: Boolean(linha.processo_judicial),
      }))
    );
  } catch (erro) {
    next(erro);
  }
}

async function detalhar(req, res, next) {
  try {
    const gravacao = await gravacaoDaUsuaria(req, res, 'detalhe');
    if (!gravacao) return;
    const analise = await pipelineIA.consultarAnalise(gravacao.id_gravacao);
    return res.json({
      id_gravacao: gravacao.id_gravacao,
      gravada_em: gravacao.data_hora,
      dispositivo: gravacao.id_device,
      duracao_segundos: numeroOuNulo(gravacao.duracao_segundos),
      hash_sha256: gravacao.hash_seguranca.trim(),
      processo_judicial: gravacao.processo_judicial,
      status_analise: analise.status_analise,
      tentativas_analise: analise.tentativas,
      ultimo_erro_analise: analise.ultimo_erro,
      laudo: analise.laudo,
    });
  } catch (erro) {
    next(erro);
  }
}

async function gerarUrl(req, res, next) {
  try {
    const gravacao = await gravacaoDaUsuaria(req, res, 'url_video');
    if (!gravacao) return;
    const acesso = await storage.gerarUrlAssinada(gravacao.id_gravacao, gravacao.url_storage, baseUrl(req));
    await auditoria.registrar('acesso_video', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: gravacao.id_gravacao },
      req,
    });
    return res.json({ id_gravacao: gravacao.id_gravacao, ...acesso, validade_minutos: storage.VALIDADE_URL_MIN });
  } catch (erro) {
    next(erro);
  }
}

async function verificarIntegridade(req, res, next) {
  try {
    const gravacao = await gravacaoDaUsuaria(req, res, 'integridade');
    if (!gravacao) return;

    if (!(await storage.existe(gravacao.url_storage))) {
      return res.status(404).json({ integro: false, erro: 'Arquivo da gravação não encontrado no armazenamento.' });
    }

    const inicio = process.hrtime.bigint();
    const hashCalculado = await calcularHashDeStream(storage.abrirLeitura(gravacao.url_storage));
    const tempoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
    const hashEsperado = gravacao.hash_seguranca.trim();
    const integro = hashCalculado === hashEsperado;

    await auditoria.registrar('verificacao_integridade', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: gravacao.id_gravacao, integro },
      req,
    });

    const resultado = {
      id_gravacao: gravacao.id_gravacao,
      integro,
      hash_esperado: hashEsperado,
      hash_calculado: hashCalculado,
      verificado_em: new Date().toISOString(),
      tempo_verificacao_ms: Math.round(tempoMs * 100) / 100,
    };
    if (integro) return res.json(resultado);

    console.warn(
      `[Custodia] FALHA DE INTEGRIDADE na gravacao ${gravacao.id_gravacao}: ` +
        `esperado ${hashEsperado}, calculado ${hashCalculado}`
    );
    return res.status(409).json({ ...resultado, erro: 'O hash do arquivo não confere com o registrado: o arquivo foi alterado.' });
  } catch (erro) {
    next(erro);
  }
}

// O X-Laudo-SHA256 permite provar depois que o arquivo do laudo não foi editado.
async function baixarLaudo(req, res, next) {
  try {
    const gravacao = await gravacaoDaUsuaria(req, res, 'download_laudo');
    if (!gravacao) return;
    const { laudo, status_analise: statusAnalise } = await pipelineIA.consultarAnalise(gravacao.id_gravacao);
    if (!laudo) return res.status(409).json({ erro: `O laudo ainda não está pronto (status: ${statusAnalise}).` });

    const conteudo = JSON.stringify(
      {
        laudo,
        integridade: {
          algoritmo: 'SHA-256',
          hash_video_original: gravacao.hash_seguranca.trim(),
          gerado_em: new Date().toISOString(),
        },
      },
      null,
      2
    );

    await auditoria.registrar('download_laudo', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: gravacao.id_gravacao },
      req,
    });
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${laudo.id_laudo}.json"`);
    res.set('X-Laudo-SHA256', crypto.createHash('sha256').update(conteudo).digest('hex'));
    return res.send(conteudo);
  } catch (erro) {
    next(erro);
  }
}

async function reprocessar(req, res, next) {
  try {
    const gravacao = await gravacaoDaUsuaria(req, res, 'reprocessar');
    if (!gravacao) return;
    if (!pipelineIA.iaConfigurada()) return res.status(503).json({ erro: 'Serviço de IA não configurado.' });

    const { enviado, motivo } = await pipelineIA.solicitarAnalise(gravacao.id_gravacao);
    if (!enviado) return res.status(409).json({ erro: motivo });
    return res.status(202).json({ id_gravacao: gravacao.id_gravacao, status_analise: 'Processando' });
  } catch (erro) {
    next(erro);
  }
}

async function excluir(req, res, next) {
  try {
    const gravacao = await gravacaoDaUsuaria(req, res, 'exclusao');
    if (!gravacao) return;
    if (!req.body || req.body.confirmacao !== true) {
      return res.status(400).json({
        erro: 'Confirme a exclusão enviando { "confirmacao": true }.',
        codigo: 'CONFIRMACAO_OBRIGATORIA',
      });
    }
    if (gravacao.processo_judicial) {
      return res.status(409).json({
        erro: 'Esta evidência está vinculada a um processo judicial ativo e não pode ser excluída.',
        codigo: 'VINCULO_JUDICIAL',
      });
    }

    await db.query('DELETE FROM acionamento WHERE id_acionamento = $1', [gravacao.id_acionamento]);
    const falhas = await evidencias.apagarArquivos([gravacao.url_storage]);
    await auditoria.registrar('exclusao_evidencia', {
      idVitima: req.usuario.idVitima,
      detalhes: {
        id_gravacao: gravacao.id_gravacao,
        hash: gravacao.hash_seguranca.trim(),
        arquivo_nao_apagado: falhas[0] || null,
      },
      req,
    });
    return res.status(204).end();
  } catch (erro) {
    next(erro);
  }
}

function eventosSse(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const cancelarAssinatura = eventos.assinar(req.usuario.idVitima, (evento) => {
    res.write(`event: status_analise\ndata: ${JSON.stringify(evento)}\n\n`);
  });

  // O batimento mantém a conexão viva e derruba o SSE quando a sessão acaba (logout, inatividade).
  const batimento = setInterval(async () => {
    try {
      if (!(await authService.sessaoAindaValida(req.usuario.idSessao))) {
        res.write('event: sessao_encerrada\ndata: {}\n\n');
        res.end();
        return;
      }
      res.write(': ping\n\n');
    } catch {
      // Banco indisponível: tenta de novo no próximo batimento.
    }
  }, INTERVALO_BATIMENTO_SSE_MS);

  req.on('close', () => {
    clearInterval(batimento);
    cancelarAssinatura();
  });
}

// Só no modo local (sem S3). Não pede login: o <video> do navegador não manda token,
// então quem tem o link assinado por /:id/url pode abrir, como numa URL pré-assinada do S3.
async function servirArquivoLocal(req, res, next) {
  try {
    if (storage.MODO_S3) return res.status(404).json({ erro: 'Rota disponível apenas no modo local.' });

    const motivoLinkInvalido = storage.validarAssinaturaLocal(Number(req.params.id), req.query.expira, req.query.assinatura);
    if (motivoLinkInvalido) return res.status(403).json({ erro: motivoLinkInvalido });

    const id = lerIdPositivo(req.params.id);
    if (id === null) return res.status(400).json({ erro: 'id_gravacao inválido.' });

    const { rows } = await db.query('SELECT url_storage FROM gravacao WHERE id_gravacao = $1', [id]);
    if (!rows.length) return res.status(404).json({ erro: `Gravação ${id} não encontrada.` });
    if (!fs.existsSync(rows[0].url_storage)) {
      return res.status(404).json({ erro: 'Arquivo do vídeo não encontrado no armazenamento.' });
    }

    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.sendFile(path.resolve(rows[0].url_storage), { headers: { 'Content-Type': 'video/mp4' } });
  } catch (erro) {
    next(erro);
  }
}

module.exports = {
  servirArquivoLocal,
  listar,
  detalhar,
  gerarUrl,
  verificarIntegridade,
  baixarLaudo,
  reprocessar,
  excluir,
  eventosSse,
};
