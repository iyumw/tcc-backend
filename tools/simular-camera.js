// Simula uma gravação da ESP32-CAM: gera frames de teste com o ffmpeg, envia cada um
// para o backend com a chave do dispositivo e encerra a sessão. Serve para testar o
// backend (e a IA) sem a câmera.
//
// Uso, na pasta backend:
//   npm run simular-camera -- --chave <DEVICE_KEY> [--url http://localhost:8080] [--id esp32cam-01] [--segundos 10]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const FRAMES_POR_SEGUNDO = 2;

function lerArgumentos() {
  const argumentos = { url: 'http://localhost:8080', id: 'esp32cam-01', segundos: 10, chave: process.env.CHAVE_DISPOSITIVO };
  const lista = process.argv.slice(2);
  for (let i = 0; i < lista.length; i += 2) argumentos[lista[i].replace(/^--/, '')] = lista[i + 1];
  argumentos.url = argumentos.url.replace(/\/+$/, '');
  argumentos.segundos = Number(argumentos.segundos);
  return argumentos;
}

function gerarFrames(segundos) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
  execFileSync(ffmpegPath, [
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=640x480:rate=${FRAMES_POR_SEGUNDO}`,
    '-t', String(segundos), '-q:v', '5',
    path.join(pasta, 'frame_%04d.jpg'),
  ]);
  const arquivos = fs.readdirSync(pasta).sort().map((nome) => path.join(pasta, nome));
  return { pasta, arquivos };
}

async function enviarFrame({ url, id, chave }, sessionId, indice, arquivo) {
  const formulario = new FormData();
  formulario.append('device_id', id);
  formulario.append('session_id', sessionId);
  formulario.append('frame_index', String(indice));
  formulario.append('timestamp', String(Date.now()));
  formulario.append('t_captura_ms', String(Math.round((indice * 1000) / FRAMES_POR_SEGUNDO)));
  formulario.append('image', new Blob([fs.readFileSync(arquivo)], { type: 'image/jpeg' }), path.basename(arquivo));

  const resposta = await fetch(`${url}/api/captura/upload`, {
    method: 'POST',
    headers: { 'X-Dispositivo-Id': id, 'X-Dispositivo-Chave': chave },
    body: formulario,
  });
  if (!resposta.ok) throw new Error(`frame ${indice}: HTTP ${resposta.status} ${await resposta.text()}`);
}

async function main() {
  const argumentos = lerArgumentos();
  if (!argumentos.chave) {
    console.error('Informe a chave do dispositivo: --chave <DEVICE_KEY> (ou a variável CHAVE_DISPOSITIVO).');
    process.exitCode = 1;
    return;
  }

  const sessionId = `${argumentos.id}-${Date.now() % 1e9}`;
  const { pasta, arquivos } = gerarFrames(argumentos.segundos);
  console.log(`Sessão ${sessionId}: enviando ${arquivos.length} frames para ${argumentos.url}...`);

  try {
    for (const [indice, arquivo] of arquivos.entries()) {
      await enviarFrame(argumentos, sessionId, indice, arquivo);
    }
    const resposta = await fetch(`${argumentos.url}/api/captura/sessao/encerrar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dispositivo-Id': argumentos.id,
        'X-Dispositivo-Chave': argumentos.chave,
      },
      body: JSON.stringify({ session_id: sessionId }),
    });
    console.log(`Encerramento: HTTP ${resposta.status} ${await resposta.text()}`);
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

main().catch((erro) => {
  console.error('Erro:', erro.message);
  process.exitCode = 1;
});
