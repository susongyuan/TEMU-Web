const fs = require('fs');
const path = require('path');

const MODULE_DIR = path.resolve(__dirname, '..');
let loaded = false;

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function ensureEnvLoaded() {
  if (loaded) return;
  loadEnvFile(path.join(MODULE_DIR, '.env'));
  loaded = true;
}

module.exports = {
  MODULE_DIR,
  ensureEnvLoaded,
  loadEnvFile
};
