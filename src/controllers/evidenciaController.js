const db = require('../config/db');
const storage = require('../services/storageService');
const pipelineIA = require('../services/pipelineIAService');
const eventos = require('../services/eventosService');
const auditoria = require('../services/auditoriaService');
const authService = require('../services/authService');
const evidencias = require('../services/evidenciaService');
const { calcularHashDeStream } = require('../services/custodiaService');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function lerId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ erro: 'id inválido.' });
    return null;
  }
  return id;
}

async function gravacaoDaUsuaria(req, res, acao) {
  const id = lerId(req, res);
  if (id === null) return null;
  const r = await evidencias.buscarDaUsuaria(id, req.usuario.idVitima);
  if (r.status === 404) {
    res.status(404).json({ erro: 'Evidência não encontrada.' });
    return null;
  }
  if (r.status === 403) {
    await auditoria.registrar('acesso_negado', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: id, acao },
      req,
    });
    res.status(403).json({ erro: 'Você não tem acesso a esta evidência.' });
    return null;
  }
  return r.gravacao;
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
      rows.map((r) => ({
        id_gravacao: r.id_gravacao,
        gravada_em: r.gravada_em,
        dispositivo: r.dispositivo,
        duracao_segundos: r.duracao_segundos !== null ? Number(r.duracao_segundos) : null,
        status_analise: r.status_analise,
        veredicto: r.veredicto,
        score: r.score !== null ? Number(r.score) : null,
        vinculada_a_processo: Boolean(r.processo_judicial),
      }))
    );
  } catch (erro) {
    next(erro);
  }
}

async function detalhar(req, res, next) {
  try {
    const g = await gravacaoDaUsuaria(req, res, 'detalhe');
    if (!g) return;
    const analise = await pipelineIA.consultarAnalise(g.id_gravacao);
    return res.json({
      id_gravacao: g.id_gravacao,
      gravada_em: g.data_hora,
      dispositivo: g.id_device,
      duracao_segundos: g.duracao_segundos !== null ? Number(g.duracao_segundos) : null,
      hash_sha256: g.hash_seguranca.trim(),
      processo_judicial: g.processo_judicial,
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
    const g = await gravacaoDaUsuaria(req, res, 'url_video');
    if (!g) return;
    const acesso = await storage.gerarUrlAssinada(g.id_gravacao, g.url_storage, baseUrl(req));
    await auditoria.registrar('acesso_video', { idVitima: req.usuario.idVitima, detalhes: { id_gravacao: g.id_gravacao }, req });
    return res.json({ id_gravacao: g.id_gravacao, ...acesso, validade_minutos: storage.VALIDADE_URL_MIN });
  } catch (erro) {
    next(erro);
  }
}

async function verificarIntegridade(req, res, next) {
  try {
    const g = await gravacaoDaUsuaria(req, res, 'integridade');
    if (!g) return;

    if (!(await storage.existe(g.url_storage))) {
      return res.status(404).json({ integro: false, erro: 'Arquivo da gravação não encontrado no armazenamento.' });
    }

    const inicio = process.hrtime.bigint();
    const hashCalculado = await calcularHashDeStream(storage.abrirLeitura(g.url_storage));
    const tempoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
    const hashEsperado = g.hash_seguranca.trim();
    const integro = hashCalculado === hashEsperado;

    const corpo = {
      id_gravacao: g.id_gravacao,
      integro,
      hash_esperado: hashEsperado,
      hash_calculado: hashCalculado,
      verificado_em: new Date().toISOString(),
      tempo_verificacao_ms: Math.round(tempoMs * 100) / 100,
    };
    await auditoria.registrar('verificacao_integridade', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: g.id_gravacao, integro },
      req,
    });

    if (!integro) {
      console.warn(`[Custodia] FALHA DE INTEGRIDADE na gravacao ${g.id_gravacao}: esperado ${hashEsperado}, calculado ${hashCalculado}`);
      return res.status(409).json({ ...corpo, erro: 'O hash do arquivo não confere com o registrado: o arquivo foi alterado.' });
    }
    return res.json(corpo);
  } catch (erro) {
    next(erro);
  }
}

async function baixarLaudo(req, res, next) {
  try {
    const g = await gravacaoDaUsuaria(req, res, 'download_laudo');
    if (!g) return;
    const analise = await pipelineIA.consultarAnalise(g.id_gravacao);
    if (!analise.laudo) {
      return res.status(409).json({ erro: `O laudo ainda não está pronto (status: ${analise.status_analise}).` });
    }

    const conteudo = {
      laudo: analise.laudo,
      integridade: {
        algoritmo: 'SHA-256',
        hash_video_original: g.hash_seguranca.trim(),
        gerado_em: new Date().toISOString(),
      },
    };
    const json = JSON.stringify(conteudo, null, 2);
    const hashLaudo = crypto.createHash('sha256').update(json).digest('hex');

    await auditoria.registrar('download_laudo', { idVitima: req.usuario.idVitima, detalhes: { id_gravacao: g.id_gravacao }, req });
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${analise.laudo.id_laudo}.json"`);
    res.set('X-Laudo-SHA256', hashLaudo);
    return res.send(json);
  } catch (erro) {
    next(erro);
  }
}

async function reprocessar(req, res, next) {
  try {
    const g = await gravacaoDaUsuaria(req, res, 'reprocessar');
    if (!g) return;
    if (!pipelineIA.iaConfigurada()) {
      return res.status(503).json({ erro: 'Serviço de IA não configurado.' });
    }
    const r = await pipelineIA.solicitarAnalise(g.id_gravacao);
    if (!r.enviado) return res.status(409).json({ erro: r.motivo });
    return res.status(202).json({ id_gravacao: g.id_gravacao, status_analise: 'Processando' });
  } catch (erro) {
    next(erro);
  }
}

async function excluir(req, res, next) {
  try {
    const g = await gravacaoDaUsuaria(req, res, 'exclusao');
    if (!g) return;
    if (!req.body || req.body.confirmacao !== true) {
      return res.status(400).json({ erro: 'Confirme a exclusão enviando { "confirmacao": true }.', codigo: 'CONFIRMACAO_OBRIGATORIA' });
    }
    if (g.processo_judicial) {
      return res.status(409).json({
        erro: 'Esta evidência está vinculada a um processo judicial ativo e não pode ser excluída.',
        codigo: 'VINCULO_JUDICIAL',
      });
    }

    await db.query('DELETE FROM acionamento WHERE id_acionamento = $1', [g.id_acionamento]);
    const falhas = await evidencias.apagarArquivos([g.url_storage]);
    await auditoria.registrar('exclusao_evidencia', {
      idVitima: req.usuario.idVitima,
      detalhes: { id_gravacao: g.id_gravacao, hash: g.hash_seguranca.trim(), arquivo_nao_apagado: falhas[0] || null },
      req,
    });
    return res.status(204).end();
  } catch (erro) {
    next(erro);
  }
}

async function eventosSse(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const cancelar = eventos.assinar(req.usuario.idVitima, (evento) => {
    res.write(`event: status_analise\ndata: ${JSON.stringify(evento)}\n\n`);
  });

  const batimento = setInterval(async () => {
    try {
      if (!(await authService.sessaoAindaValida(req.usuario.idSessao))) {
        res.write('event: sessao_encerrada\ndata: {}\n\n');
        return res.end();
      }
      res.write(': ping\n\n');
    } catch {

    }
  }, 25000);

  req.on('close', () => {
    clearInterval(batimento);
    cancelar();
  });
}

async function buscarGravacao(idTexto) {
  const id = Number(idTexto);
  if (!Number.isInteger(id) || id <= 0) {
    return { erro: 400, mensagem: 'id_gravacao inválido.' };
  }
  const { rows } = await db.query(
    'SELECT id_gravacao, url_storage, hash_seguranca FROM gravacao WHERE id_gravacao = $1',
    [id]
  );
  if (rows.length === 0) {
    return { erro: 404, mensagem: `Gravação ${id} não encontrada.` };
  }
  return { gravacao: rows[0] };
}

async function servirArquivoLocal(req, res, next) {
  try {
    if (storage.MODO_S3) {
      return res.status(404).json({ erro: 'Rota disponível apenas no modo local.' });
    }

    const problema = storage.validarAssinaturaLocal(
      Number(req.params.id),
      req.query.expira,
      req.query.assinatura
    );
    if (problema) {
      return res.status(403).json({ erro: problema });
    }

    const { gravacao, erro, mensagem } = await buscarGravacao(req.params.id);
    if (erro) return res.status(erro).json({ erro: mensagem });

    if (!fs.existsSync(gravacao.url_storage)) {
      return res.status(404).json({ erro: 'Arquivo do vídeo não encontrado no armazenamento.' });
    }

    res.set('Cross-Origin-Resource-Policy', 'cross-origin');

    return res.sendFile(path.resolve(gravacao.url_storage), {
      headers: { 'Content-Type': 'video/mp4' },
    });
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
