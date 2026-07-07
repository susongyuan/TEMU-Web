const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadInventoryData, loadPriceDataAsync } = require('../src/data-loader');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function normalizeMode(value) {
  const mode = String(value || '').trim();
  if (mode === 'price' || mode === 'inventory') return mode;
  throw new Error(`Unsupported mode: ${mode || '(empty)'}`);
}

async function loadData(mode) {
  return mode === 'inventory' ? loadInventoryData() : loadPriceDataAsync();
}

function writeSnapshot(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(data);
  if (/\.gz$/i.test(file)) {
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));
  } else {
    fs.writeFileSync(file, json, 'utf8');
  }
}

async function main() {
  const mode = normalizeMode(argValue('--mode', ''));
  const out = argValue('--out', '');
  if (!out) throw new Error('Missing --out');

  const data = await loadData(mode);
  writeSnapshot(path.resolve(out), data);
  const stat = fs.statSync(path.resolve(out));
  console.log(JSON.stringify({
    mode,
    out: path.resolve(out),
    bytes: stat.size,
    rows: Array.isArray(data.rows) ? data.rows.length : 0,
    generated_at: data.generated_at
  }));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
