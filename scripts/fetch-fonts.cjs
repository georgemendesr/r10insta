#!/usr/bin/env node
// Baixa Poppins TTF (Regular, SemiBold, ExtraBold) no diretório instagram-publisher/fonts
const https = require('https');
const fs = require('fs');
const path = require('path');

const fontsDir = path.join(__dirname, '..', 'fonts');
if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true });

const files = [
  { name: 'Poppins-Regular.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Regular.ttf' },
  { name: 'Poppins-SemiBold.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-SemiBold.ttf' },
  { name: 'Poppins-ExtraBold.ttf', url: 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-ExtraBold.ttf' }
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(dest, () => {}));
        return reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      file.close(() => fs.unlink(dest, () => {}));
      reject(err);
    });
  });
}

(async () => {
  for (const f of files) {
    const dest = path.join(fontsDir, f.name);
    if (fs.existsSync(dest)) {
      console.log(`✔ Fonte já existe: ${f.name}`);
      continue;
    }
    try {
      console.log(`⬇ Baixando ${f.name}...`);
      await download(f.url, dest);
      console.log(`✔ Baixado: ${f.name}`);
    } catch (e) {
      console.warn(`⚠ Não foi possível baixar ${f.name}: ${e.message}`);
    }
  }
})();
