const { closePool, getPool, redactedDbConfig } = require('../src/db');
const { initDashboardSchema } = require('../src/schema');

async function main() {
  const pool = getPool();
  await initDashboardSchema(pool);
  console.log('Dashboard database schema is ready:', redactedDbConfig());
}

main()
  .catch(error => {
    console.error('Failed to initialize dashboard database:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
