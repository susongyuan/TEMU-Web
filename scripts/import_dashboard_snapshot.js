const { closePool, redactedDbConfig } = require('../src/db');
const { loadInventoryData, loadPriceData } = require('../src/data-loader');
const { saveDashboardSnapshot } = require('../src/snapshot-store');

function parseModes(argv) {
  const modeArgIndex = argv.findIndex(arg => arg === '--mode' || arg === '-m');
  const value = modeArgIndex >= 0 ? argv[modeArgIndex + 1] : 'all';
  if (value === 'price') return ['price'];
  if (value === 'inventory') return ['inventory'];
  if (value === 'all') return ['price', 'inventory'];
  throw new Error(`Unsupported mode: ${value}`);
}

function loadDataForMode(mode) {
  return mode === 'inventory' ? loadInventoryData() : loadPriceData();
}

async function main() {
  const modes = parseModes(process.argv.slice(2));
  console.log('Import dashboard snapshots to MySQL:', redactedDbConfig());

  for (const mode of modes) {
    const data = loadDataForMode(mode);
    const result = await saveDashboardSnapshot(data);
    console.log(`[OK] ${mode}: snapshot=${result.snapshotId}, rows=${result.rowCount}, generated_at=${result.generatedAt}`);
  }
}

main()
  .catch(error => {
    console.error('[FAIL] Import dashboard snapshots failed:', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
