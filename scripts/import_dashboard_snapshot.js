const { closePool, redactedDbConfig } = require('../src/db');
const { loadInventoryData, loadPriceDataAsync } = require('../src/data-loader');
const { saveDashboardSnapshot } = require('../src/snapshot-store');

process.env.DASHBOARD_IMPORT_TRACE = process.env.DASHBOARD_IMPORT_TRACE || '1';

function parseModes(argv) {
  const modeArgIndex = argv.findIndex(arg => arg === '--mode' || arg === '-m');
  const positionalMode = argv.find(arg => !String(arg || '').startsWith('-'));
  const value = modeArgIndex >= 0 ? argv[modeArgIndex + 1] : positionalMode || 'all';
  if (value === 'price') return ['price'];
  if (value === 'inventory') return ['inventory'];
  if (value === 'all') return ['price', 'inventory'];
  throw new Error(`Unsupported mode: ${value}`);
}

async function loadDataForMode(mode) {
  return mode === 'inventory' ? loadInventoryData() : loadPriceDataAsync();
}

async function main() {
  const modes = parseModes(process.argv.slice(2));
  console.log('Import dashboard snapshots to MySQL:', redactedDbConfig());

  for (const mode of modes) {
    const data = await loadDataForMode(mode);
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
