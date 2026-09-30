const path = require('path');
const fs = require('fs');

const RAIZ_TMP = path.join(__dirname, '..', '..', 'tmp');
const FRAMES_DIR = path.join(RAIZ_TMP, 'frames');
const VIDEOS_DIR = path.join(RAIZ_TMP, 'videos');

function garantirPastas() {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

module.exports = {
  FRAMES_DIR,
  VIDEOS_DIR,
  garantirPastas,
};
