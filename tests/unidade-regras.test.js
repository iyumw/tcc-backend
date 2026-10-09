// Testes unitários das regras puras (sem banco, sem servidor).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const validacao = require('../src/utils/validacao');
const { calcularDuracoes } = require('../src/services/videoAssemblyService');
const { validarResultadoConcluido, hashConfere } = require('../src/services/validacaoResultadoIA');
const { limitarTaxa } = require('../src/middleware/limitarTaxa');
const der = require('../src/utils/der');
const { montarPedido, lerCarimbo, carimboConfere } = require('../src/services/carimboTempoService');
const { montarResposta } = require('./support/tsaFalsa');

const HASH = 'a'.repeat(64);

describe('validação de cadastro', () => {
  it('aceita CPF com dígitos verificadores certos, com ou sem máscara', () => {
    assert.equal(validacao.cpfValido('529.982.247-25'), true);
    assert.equal(validacao.cpfValido('52998224725'), true);
  });

  it('recusa CPF com dígito errado, repetido ou incompleto', () => {
    assert.equal(validacao.cpfValido('529.982.247-24'), false);
    assert.equal(validacao.cpfValido('000.000.000-00'), false);
    assert.equal(validacao.cpfValido('5299822472'), false);
  });

  it('lista o que falta numa senha fraca', () => {
    assert.deepEqual(validacao.problemasDaSenha('abc'), [
      'pelo menos 8 caracteres',
      'uma letra maiúscula',
      'um número',
      'um caractere especial',
    ]);
    assert.deepEqual(validacao.problemasDaSenha('Senha@123'), []);
  });

  it('só aceita ids inteiros positivos', () => {
    assert.equal(validacao.lerIdPositivo('12'), 12);
    for (const invalido of ['0', '-1', '1.5', 'abc', undefined]) {
      assert.equal(validacao.lerIdPositivo(invalido), null);
    }
  });
});

describe('duração dos frames no vídeo', () => {
  const frame = (tempoCapturaMs) => ({ tempoCapturaMs });

  it('cada frame dura até a captura do próximo; o último usa a mediana', () => {
    assert.deepEqual(calcularDuracoes([frame(0), frame(250), frame(500), frame(1000)]), [0.25, 0.25, 0.5, 0.25]);
  });

  it('sem tempo de captura, usa a mediana dos intervalos conhecidos', () => {
    assert.deepEqual(calcularDuracoes([frame(0), frame(200), frame(null), frame(800)]), [0.2, 0.2, 0.2, 0.2]);
  });

  it('limita intervalos absurdos (ex.: queda de rede de minutos) a 5 s', () => {
    assert.deepEqual(calcularDuracoes([frame(0), frame(600000)]), [5, 5]);
  });
});

describe('resultado enviado pela IA', () => {
  const resultadoValido = {
    score: 87.5,
    veredicto: 'Anomalia',
    versao_modelo: 'yolov9c-cls',
    segmentos_criticos: [{ inicio_s: 2, fim_s: 5, score: 90 }],
    tempo_processamento_ms: 1234.4,
  };

  it('aceita um resultado completo e normaliza os números', () => {
    const resultado = validarResultadoConcluido(resultadoValido);

    assert.equal(resultado.score, 87.5);
    assert.equal(resultado.tempoMs, 1234);
    assert.deepEqual(resultado.segmentos, [{ inicio_s: 2, fim_s: 5, score: 90 }]);
  });

  it('recusa score fora de 0-100, veredicto desconhecido e segmento invertido', () => {
    assert.throws(() => validarResultadoConcluido({ ...resultadoValido, score: 120 }), /score/);
    assert.throws(() => validarResultadoConcluido({ ...resultadoValido, veredicto: 'Talvez' }), /veredicto/);
    assert.throws(
      () => validarResultadoConcluido({ ...resultadoValido, segmentos_criticos: [{ inicio_s: 5, fim_s: 2 }] }),
      /inicio_s/
    );
  });

  it('exige o hash do vídeo analisado igual ao registrado (cadeia de custódia)', () => {
    assert.equal(hashConfere({ hash_sha256_verificado: HASH.toUpperCase() }, HASH), true);
    assert.equal(hashConfere({ hash_sha256_verificado: 'b'.repeat(64) }, HASH), false);
    assert.equal(hashConfere({}, HASH), false);
  });
});

describe('limite de tentativas por origem', () => {
  function requisicaoFalsa(ip, email) {
    return { ip, body: { email } };
  }

  function respostaFalsa() {
    return {
      statusCode: 200,
      cabecalhos: {},
      set(nome, valor) { this.cabecalhos[nome] = valor; },
      status(codigo) { this.statusCode = codigo; return this; },
      json(corpo) { this.corpo = corpo; return this; },
    };
  }

  function tentar(limitar, requisicao) {
    const resposta = respostaFalsa();
    let liberada = false;
    limitar(requisicao, resposta, () => { liberada = true; });
    return { liberada, resposta };
  }

  it('libera até o máximo e responde 429 com Retry-After depois', () => {
    const limitar = limitarTaxa({ nome: 'teste-ip', maximo: 2, janelaMin: 1 });
    assert.equal(tentar(limitar, requisicaoFalsa('1.1.1.1')).liberada, true);
    assert.equal(tentar(limitar, requisicaoFalsa('1.1.1.1')).liberada, true);

    const { liberada, resposta } = tentar(limitar, requisicaoFalsa('1.1.1.1'));

    assert.equal(liberada, false);
    assert.equal(resposta.statusCode, 429);
    assert.equal(resposta.corpo.codigo, 'MUITAS_TENTATIVAS');
    assert.ok(Number(resposta.cabecalhos['Retry-After']) > 0);
  });

  it('com porEmail, trocar de IP não escapa do limite do mesmo e-mail', () => {
    const limitar = limitarTaxa({ nome: 'teste-email', maximo: 2, janelaMin: 1, porEmail: true });
    tentar(limitar, requisicaoFalsa('1.1.1.1', 'vitima@teste.com'));
    tentar(limitar, requisicaoFalsa('2.2.2.2', 'Vitima@Teste.com'));

    assert.equal(tentar(limitar, requisicaoFalsa('3.3.3.3', 'vitima@teste.com')).liberada, false);
    assert.equal(tentar(limitar, requisicaoFalsa('3.3.3.3', 'outra@teste.com')).liberada, true);
  });
});

describe('carimbo de tempo RFC 3161', () => {
  const nonce = Buffer.from([0x81, 2, 3, 4, 5, 6, 7, 8]);

  it('o pedido leva o SHA-256 do vídeo, o nonce como inteiro positivo e pede o certificado', () => {
    const [versao, impressao, nonceLido, pedeCertificado] = der.ler(montarPedido(HASH, nonce)).filhos;

    assert.deepEqual([...versao.valor], [1]);
    assert.equal(der.lerOid(impressao.filhos[0].filhos[0]), '2.16.840.1.101.3.4.2.1');
    assert.equal(impressao.filhos[1].valor.toString('hex'), HASH);
    assert.deepEqual([...nonceLido.valor], [0, ...nonce]);
    assert.deepEqual([...pedeCertificado.valor], [0xff]);
  });

  it('lê a data da resposta e recusa resposta de outro hash ou de outro nonce', () => {
    const momento = new Date('2026-10-09T14:30:05Z');
    const resposta = montarResposta(montarPedido(HASH, nonce), 7, momento);

    assert.deepEqual(lerCarimbo(resposta, HASH, nonce), { emitidoEm: momento, numeroSerie: '07' });
    assert.equal(carimboConfere(resposta, 'b'.repeat(64)), false);
    assert.throws(() => lerCarimbo(resposta, HASH, Buffer.from([1, 2, 3])), /nonce/);
  });
});
