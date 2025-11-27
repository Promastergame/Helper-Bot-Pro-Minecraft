const {  promises as fs  } = require('fs');
const {  dirname  } = require('path');
const {  fileURLToPath  } = require('url');

async function ensureDir(path) {
  try { await fs.mkdir(path, { recursive: true }); } catch {}
}

async function loadJson(file, fallback) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data ?? fallback;
  } catch { return fallback; }
}

async function saveJson(file, data) {
  await ensureDir(file.split('/').slice(0, -1).join('/'));
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

module.exports = { ensureDir, loadJson, saveJson };