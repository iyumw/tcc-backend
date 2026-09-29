const db = require('../config/db');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const auditoria = require('../services/auditoriaService');
const evidencias = require('../services/evidenciaService');

const CAMPOS_PERFIL = `id_vitima, nome, cpf, email, telefone, cep, logradouro, numero, complemento,
                       bairro, cidade, uf, consentimento_em, criada_em`;

function formatarPerfil(v, dispositivo) {
  return {
    id_vitima: v.id_vitima,
    nome: v.nome,
    cpf_mascarado: `***.${v.cpf.slice(3, 6)}.${v.cpf.slice(6, 9)}-**`,
    email: v.email,
    telefone: v.telefone,
    endereco: {
      cep: v.cep, logradouro: v.logradouro, numero: v.numero, complemento: v.complemento,
      bairro: v.bairro, cidade: v.cidade, uf: v.uf,
    },
    consentimento_em: v.consentimento_em,
    criada_em: v.criada_em,
    dispositivo: dispositivo || null,
  };
}

async function carregarPerfil(idVitima) {
  const { rows } = await db.query(`SELECT ${CAMPOS_PERFIL} FROM vitima WHERE id_vitima = $1`, [idVitima]);
  if (!rows.length) return null;
  const disp = await db.query(
    'SELECT id_dispositivo, status_bateria FROM dispositivo WHERE id_vitima = $1',
    [idVitima]
  );
  return formatarPerfil(rows[0], disp.rows[0]);
}


async function obter(req, res, next) {
  try {
    const perfil = await carregarPerfil(req.usuario.idVitima);
    if (!perfil) return res.status(404).json({ erro: 'Conta não encontrada.' });
    return res.json(perfil);
  } catch (erro) {
    next(erro);
  }
}

async function enviarCodigo(req, res, next) {
  try {
    const finalidade = req.body && req.body.finalidade;
    if (!['alterar_dados', 'excluir_conta'].includes(finalidade)) {
      return res.status(400).json({ erro: '"finalidade" deve ser "alterar_dados" ou "excluir_conta".' });
    }
    const { rows } = await db.query('SELECT email FROM vitima WHERE id_vitima = $1', [req.usuario.idVitima]);
    const codigoMfa = await authService.criarCodigo(req.usuario.idVitima, finalidade);
    await emailService.enviarCodigo(rows[0].email, codigoMfa.codigo, finalidade, codigoMfa.validadeMinutos);
    return res.json({ mensagem: 'Enviamos um código para o seu e-mail.', validade_minutos: codigoMfa.validadeMinutos });
  } catch (erro) {
    next(erro);
  }
}

async function atualizar(req, res, next) {
  try {
    const b = req.body || {};
    const idVitima = req.usuario.idVitima;
    const sets = [];
    const valores = [];
    const campos = {};
    const add = (coluna, valor) => {
      valores.push(valor);
      sets.push(`${coluna} = $${valores.length + 1}`);
    };

    if (b.nome !== undefined) {
      if (String(b.nome).trim().length < 3) campos.nome = 'Informe o nome completo.';
      else add('nome', String(b.nome).trim().slice(0, 100));
    }
    if (b.endereco !== undefined) {
      const e = b.endereco || {};
      if (e.cep !== undefined) {
        const cep = authService.somenteDigitos(e.cep);
        if (cep.length !== 8) campos['endereco.cep'] = 'CEP inválido.';
        else add('cep', cep);
      }
      for (const [c, max] of [['logradouro', 150], ['numero', 20], ['bairro', 100], ['cidade', 100]]) {
        if (e[c] !== undefined) {
          if (!String(e[c]).trim()) campos[`endereco.${c}`] = 'Campo obrigatório.';
          else add(c, String(e[c]).trim().slice(0, max));
        }
      }
      if (e.complemento !== undefined) add('complemento', e.complemento ? String(e.complemento).trim().slice(0, 100) : null);
      if (e.uf !== undefined) {
        if (!/^[A-Za-z]{2}$/.test(String(e.uf))) campos['endereco.uf'] = 'UF inválida.';
        else add('uf', String(e.uf).toUpperCase());
      }
    }

    const sensivel = b.email !== undefined || b.telefone !== undefined || b.nova_senha !== undefined;
    let novoEmail = null;
    if (b.email !== undefined) {
      novoEmail = String(b.email).trim().toLowerCase();
      if (!authService.emailValido(novoEmail)) campos.email = 'E-mail inválido.';
      else add('email', novoEmail);
    }
    if (b.telefone !== undefined) {
      const tel = authService.somenteDigitos(b.telefone);
      if (tel.length < 10 || tel.length > 11) campos.telefone = 'Telefone inválido (DDD + número).';
      else add('telefone', tel);
    }
    if (b.nova_senha !== undefined) {
      const falta = authService.problemasDaSenha(b.nova_senha);
      if (falta.length) campos.nova_senha = `A senha precisa ter: ${falta.join(', ')}.`;
      else add('senha_hash', await authService.gerarHashSenha(b.nova_senha));
    }

    if (Object.keys(campos).length) return res.status(400).json({ erro: 'Verifique os campos.', campos });
    if (!sets.length) return res.status(400).json({ erro: 'Nada para alterar.' });

    if (sensivel) {
      const r = await authService.conferirCodigo({ idVitima, finalidade: 'alterar_dados', codigo: b.codigo });
      if (!r.ok) {
        return res.status(401).json({
          erro: `Alterar e-mail, telefone ou senha exige o código enviado por e-mail. ${r.erro}`,
          codigo: 'MFA_OBRIGATORIO',
        });
      }
    }

    if (novoEmail) {
      const dup = await db.query('SELECT 1 FROM vitima WHERE email = $1 AND id_vitima <> $2', [novoEmail, idVitima]);
      if (dup.rows.length) return res.status(409).json({ erro: 'E-mail já cadastrado.', campos: { email: 'E-mail já cadastrado.' } });
    }

    await db.query(`UPDATE vitima SET ${sets.join(', ')} WHERE id_vitima = $1`, [idVitima, ...valores]);
    if (b.nova_senha !== undefined) {

      await authService.encerrarTodasSessoes(idVitima, req.usuario.idSessao);
    }
    await auditoria.registrar('perfil_alterado', {
      idVitima,
      detalhes: { campos: Object.keys(b).filter((k) => k !== 'codigo' && k !== 'nova_senha').concat(b.nova_senha !== undefined ? ['senha'] : []) },
      req,
    });

    return res.json(await carregarPerfil(idVitima));
  } catch (erro) {
    next(erro);
  }
}

async function vincularDispositivo(req, res, next) {
  try {
    const id = String((req.body && req.body.id_dispositivo) || '').trim();
    if (!id) return res.status(400).json({ erro: '"id_dispositivo" é obrigatório.' });

    const atual = await db.query('SELECT id_dispositivo FROM dispositivo WHERE id_vitima = $1', [req.usuario.idVitima]);
    if (atual.rows.length) {
      return res.status(409).json({ erro: `Sua conta já está vinculada ao dispositivo ${atual.rows[0].id_dispositivo}.` });
    }

    const { rowCount } = await db.query(
      'UPDATE dispositivo SET id_vitima = $2 WHERE id_dispositivo = $1 AND id_vitima IS NULL',
      [id, req.usuario.idVitima]
    );
    if (!rowCount) {
      return res.status(404).json({ erro: 'Dispositivo não encontrado ou já vinculado a outra conta.' });
    }
    await auditoria.registrar('dispositivo_vinculado', { idVitima: req.usuario.idVitima, detalhes: { id_dispositivo: id }, req });
    return res.json(await carregarPerfil(req.usuario.idVitima));
  } catch (erro) {
    next(erro);
  }
}

async function excluirConta(req, res, next) {
  try {
    const idVitima = req.usuario.idVitima;
    const r = await authService.conferirCodigo({ idVitima, finalidade: 'excluir_conta', codigo: req.body && req.body.codigo });
    if (!r.ok) return res.status(401).json({ erro: r.erro, codigo: 'MFA_OBRIGATORIO' });

    const { rows: gravacoes } = await db.query(
      `SELECT g.id_gravacao, g.url_storage, g.processo_judicial
         FROM gravacao g JOIN acionamento a ON a.id_acionamento = g.id_acionamento
        WHERE a.id_vitima = $1`,
      [idVitima]
    );
    const vinculadas = gravacoes.filter((g) => g.processo_judicial);
    if (vinculadas.length) {
      return res.status(409).json({
        erro: 'A conta tem evidências vinculadas a processo judicial ativo e não pode ser excluída agora.',
        gravacoes_vinculadas: vinculadas.map((g) => g.id_gravacao),
      });
    }

    await db.query('DELETE FROM vitima WHERE id_vitima = $1', [idVitima]);
    const falhas = await evidencias.apagarArquivos(gravacoes.map((g) => g.url_storage));

    await auditoria.registrar('conta_excluida', {
      idVitima,
      detalhes: { gravacoes_excluidas: gravacoes.length, arquivos_nao_apagados: falhas },
      req,
    });
    if (falhas.length) console.warn(`[Perfil] Conta ${idVitima} excluída, mas ${falhas.length} arquivo(s) não foram apagados:`, falhas);

    return res.status(204).end();
  } catch (erro) {
    next(erro);
  }
}

module.exports = {
  obter,
  enviarCodigo,
  atualizar,
  vincularDispositivo,
  excluirConta,
};
