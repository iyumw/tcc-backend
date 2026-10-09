const db = require('../config/db');
const authService = require('../services/authService');
const auditoria = require('../services/auditoriaService');
const evidencias = require('../services/evidenciaService');
const validacao = require('../utils/validacao');
const { envolverControladores } = require('../utils/comTratamentoDeErros');

const CAMPOS_PERFIL = `id_vitima, nome, cpf, email, telefone, cep, logradouro, numero, complemento,
                       bairro, cidade, uf, consentimento_em, criada_em`;
const FINALIDADES_DE_CODIGO = ['alterar_dados', 'excluir_conta'];
const CAMPOS_ENDERECO_TEXTO = [['logradouro', 150], ['numero', 20], ['bairro', 100], ['cidade', 100]];

function formatarPerfil(vitima, dispositivo) {
  return {
    id_vitima: vitima.id_vitima,
    nome: vitima.nome,
    cpf_mascarado: `***.${vitima.cpf.slice(3, 6)}.${vitima.cpf.slice(6, 9)}-**`,
    email: vitima.email,
    telefone: vitima.telefone,
    endereco: {
      cep: vitima.cep,
      logradouro: vitima.logradouro,
      numero: vitima.numero,
      complemento: vitima.complemento,
      bairro: vitima.bairro,
      cidade: vitima.cidade,
      uf: vitima.uf,
    },
    consentimento_em: vitima.consentimento_em,
    criada_em: vitima.criada_em,
    dispositivo: dispositivo || null,
  };
}

async function carregarPerfil(idVitima) {
  const { rows } = await db.query(`SELECT ${CAMPOS_PERFIL} FROM vitima WHERE id_vitima = $1`, [idVitima]);
  if (!rows.length) return null;
  const dispositivo = await db.query(
    'SELECT id_dispositivo, status_bateria FROM dispositivo WHERE id_vitima = $1',
    [idVitima]
  );
  return formatarPerfil(rows[0], dispositivo.rows[0]);
}

async function obter(req, res) {
  const perfil = await carregarPerfil(req.usuario.idVitima);
  if (!perfil) return res.status(404).json({ erro: 'Conta não encontrada.' });
  return res.json(perfil);
}

async function enviarCodigo(req, res) {
  const finalidade = req.body && req.body.finalidade;
  if (!FINALIDADES_DE_CODIGO.includes(finalidade)) {
    return res.status(400).json({ erro: '"finalidade" deve ser "alterar_dados" ou "excluir_conta".' });
  }
  const { rows } = await db.query('SELECT email FROM vitima WHERE id_vitima = $1', [req.usuario.idVitima]);
  const { validadeMinutos } = await authService.enviarCodigo(req.usuario.idVitima, rows[0].email, finalidade);
  return res.json({ mensagem: 'Enviamos um código para o seu e-mail.', validade_minutos: validadeMinutos });
}

function alteracoesDeEndereco(endereco, alterar, invalidos) {
  if (endereco.cep !== undefined) {
    const cep = validacao.somenteDigitos(endereco.cep);
    if (cep.length !== 8) invalidos['endereco.cep'] = 'CEP inválido.';
    else alterar('cep', cep);
  }
  for (const [campo, tamanhoMax] of CAMPOS_ENDERECO_TEXTO) {
    if (endereco[campo] === undefined) continue;
    const valor = validacao.texto(endereco[campo]);
    if (!valor) invalidos[`endereco.${campo}`] = 'Campo obrigatório.';
    else alterar(campo, valor.slice(0, tamanhoMax));
  }
  if (endereco.complemento !== undefined) {
    alterar('complemento', validacao.texto(endereco.complemento).slice(0, 100) || null);
  }
  if (endereco.uf !== undefined) {
    if (!validacao.ufValida(endereco.uf)) invalidos['endereco.uf'] = 'UF inválida.';
    else alterar('uf', String(endereco.uf).toUpperCase());
  }
}

async function lerAlteracoes(corpo) {
  const colunas = {};
  const invalidos = {};
  const alterar = (coluna, valor) => { colunas[coluna] = valor; };

  if (corpo.nome !== undefined) {
    if (!validacao.nomeValido(corpo.nome)) invalidos.nome = 'Informe o nome completo.';
    else alterar('nome', validacao.texto(corpo.nome).slice(0, 100));
  }
  if (corpo.endereco !== undefined) alteracoesDeEndereco(corpo.endereco || {}, alterar, invalidos);
  if (corpo.email !== undefined) {
    const email = validacao.normalizarEmail(corpo.email);
    if (!validacao.emailValido(email)) invalidos.email = 'E-mail inválido.';
    else alterar('email', email);
  }
  if (corpo.telefone !== undefined) {
    const telefone = validacao.somenteDigitos(corpo.telefone);
    if (!validacao.telefoneValido(telefone)) invalidos.telefone = 'Telefone inválido (DDD + número).';
    else alterar('telefone', telefone);
  }
  if (corpo.nova_senha !== undefined) {
    const faltaNaSenha = validacao.problemasDaSenha(corpo.nova_senha);
    if (faltaNaSenha.length) invalidos.nova_senha = validacao.mensagemSenhaFraca(faltaNaSenha);
    else alterar('senha_hash', await authService.gerarHashSenha(corpo.nova_senha));
  }
  return { colunas, invalidos };
}

async function emailEmUsoPorOutraConta(email, idVitima) {
  const { rows } = await db.query('SELECT 1 FROM vitima WHERE email = $1 AND id_vitima <> $2', [email, idVitima]);
  return rows.length > 0;
}

function exigeCodigo(corpo) {
  return corpo.email !== undefined || corpo.telefone !== undefined || corpo.nova_senha !== undefined;
}

function camposAlteradosParaAuditoria(corpo) {
  const campos = Object.keys(corpo).filter((campo) => campo !== 'codigo' && campo !== 'nova_senha');
  return corpo.nova_senha !== undefined ? [...campos, 'senha'] : campos;
}

async function atualizar(req, res) {
  const corpo = req.body || {};
  const idVitima = req.usuario.idVitima;

  const { colunas, invalidos } = await lerAlteracoes(corpo);
  if (Object.keys(invalidos).length) return res.status(400).json({ erro: 'Verifique os campos.', campos: invalidos });
  if (!Object.keys(colunas).length) return res.status(400).json({ erro: 'Nada para alterar.' });

  // A duplicidade é conferida antes do código, para um 409 não gastar o código da usuária.
  if (colunas.email && (await emailEmUsoPorOutraConta(colunas.email, idVitima))) {
    return res.status(409).json({ erro: 'E-mail já cadastrado.', campos: { email: 'E-mail já cadastrado.' } });
  }

  if (exigeCodigo(corpo)) {
    const resultado = await authService.conferirCodigo({ idVitima, finalidade: 'alterar_dados', codigo: corpo.codigo });
    if (!resultado.ok) {
      return res.status(401).json({
        erro: `Alterar e-mail, telefone ou senha exige o código enviado por e-mail. ${resultado.erro}`,
        codigo: 'MFA_OBRIGATORIO',
      });
    }
  }

  const nomes = Object.keys(colunas);
  const atribuicoes = nomes.map((coluna, i) => `${coluna} = $${i + 2}`).join(', ');
  await db.query(`UPDATE vitima SET ${atribuicoes} WHERE id_vitima = $1`, [idVitima, ...Object.values(colunas)]);

  // Trocar a senha ou o e-mail de login derruba as outras sessões abertas.
  if (colunas.senha_hash || colunas.email) await authService.encerrarTodasSessoes(idVitima, req.usuario.idSessao);

  await auditoria.registrar('perfil_alterado', {
    idVitima,
    detalhes: { campos: camposAlteradosParaAuditoria(corpo) },
    req,
  });

  return res.json(await carregarPerfil(idVitima));
}

async function vincularDispositivo(req, res) {
  const idVitima = req.usuario.idVitima;
  const idDispositivo = validacao.texto(req.body && req.body.id_dispositivo);
  if (!idDispositivo) return res.status(400).json({ erro: '"id_dispositivo" é obrigatório.' });

  const vinculoAtual = await db.query('SELECT id_dispositivo FROM dispositivo WHERE id_vitima = $1', [idVitima]);
  if (vinculoAtual.rows.length) {
    return res.status(409).json({ erro: `Sua conta já está vinculada ao dispositivo ${vinculoAtual.rows[0].id_dispositivo}.` });
  }

  const { rowCount } = await db.query(
    'UPDATE dispositivo SET id_vitima = $2 WHERE id_dispositivo = $1 AND id_vitima IS NULL',
    [idDispositivo, idVitima]
  );
  if (!rowCount) return res.status(404).json({ erro: 'Dispositivo não encontrado ou já vinculado a outra conta.' });

  await auditoria.registrar('dispositivo_vinculado', { idVitima, detalhes: { id_dispositivo: idDispositivo }, req });
  return res.json(await carregarPerfil(idVitima));
}

async function excluirConta(req, res) {
  const idVitima = req.usuario.idVitima;
  const resultado = await authService.conferirCodigo({
    idVitima,
    finalidade: 'excluir_conta',
    codigo: req.body && req.body.codigo,
  });
  if (!resultado.ok) return res.status(401).json({ erro: resultado.erro, codigo: 'MFA_OBRIGATORIO' });

  const { rows: gravacoes } = await db.query(
    `SELECT g.id_gravacao, g.url_storage, g.processo_judicial
       FROM gravacao g JOIN acionamento a ON a.id_acionamento = g.id_acionamento
      WHERE a.id_vitima = $1`,
    [idVitima]
  );
  const vinculadas = gravacoes.filter((gravacao) => gravacao.processo_judicial);
  if (vinculadas.length) {
    return res.status(409).json({
      erro: 'A conta tem evidências vinculadas a processo judicial ativo e não pode ser excluída agora.',
      gravacoes_vinculadas: vinculadas.map((gravacao) => gravacao.id_gravacao),
    });
  }

  // O log e a exclusão entram juntos: ou os dois acontecem, ou nenhum.
  await db.emTransacao(async (cliente) => {
    await auditoria.registrarObrigatorio('conta_excluida', {
      idVitima,
      detalhes: { gravacoes_excluidas: gravacoes.map((gravacao) => gravacao.id_gravacao) },
      req,
      cliente,
    });
    await cliente.query('DELETE FROM vitima WHERE id_vitima = $1', [idVitima]);
  });

  await evidencias.apagarArquivosERegistrarFalhas(gravacoes.map((gravacao) => gravacao.url_storage), { idVitima, req });

  return res.status(204).end();
}

module.exports = envolverControladores({
  obter,
  enviarCodigo,
  atualizar,
  vincularDispositivo,
  excluirConta,
});
