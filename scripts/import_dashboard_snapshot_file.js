const fs = require('fs');
const zlib = require('zlib');
process.env.DASHBOARD_IMPORT_TRACE = process.env.DASHBOARD_IMPORT_TRACE || '1';
const { closePool } = require('../src/db');
const { saveDashboardSnapshot } = require('../src/snapshot-store');

function readSnapshot(file) {
  const buffer = fs.readFileSync(file);
  const json = /\.gz$/i.test(file)
    ? zlib.gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');
  return JSON.parse(json);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node import_dashboard_snapshot_file.js <snapshot.json|snapshot.json.gz>');

  const data = readSnapshot(file);
  const result = await saveDashboardSnapshot(data);
  console.log(JSON.stringify(result));
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
