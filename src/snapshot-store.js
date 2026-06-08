const { getPool } = require('./db');
const { initDashboardSchema } = require('./schema');

const INSERT_BATCH_SIZE = 500;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function rowKey(row, index) {
  const parts = [
    row.platformSpu,
    row.spuId,
    row.skuId,
    row.skcId,
    row.skuCode,
    row.mallId,
    row.goodsId,
    row.id
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return (parts.join('|') || `row-${index}`).slice(0, 255);
}

async function insertRows(connection, snapshotId, mode, rows) {
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
    const values = batch.map((row, offset) => [
      snapshotId,
      mode,
      start + offset,
      rowKey(row, start + offset),
      JSON.stringify(row)
    ]);
    await connection.query(
      'INSERT INTO dashboard_rows (snapshot_id, mode, row_index, row_key, row_json) VALUES ?',
      [values]
    );
  }
}

async function saveDashboardSnapshot(data) {
  if (!data || !data.mode) throw new Error('Invalid dashboard data: missing mode');

  const pool = getPool();
  await initDashboardSchema(pool);
  const connection = await pool.getConnection();
  const mode = String(data.mode);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const generatedAt = data.generated_at || new Date().toISOString();

  try {
    await connection.beginTransaction();

    const [syncRunResult] = await connection.execute(
      'INSERT INTO sync_runs (source, status, row_count, message, summary_json) VALUES (?, ?, ?, ?, ?)',
      [`dashboard:${mode}`, 'running', rows.length, 'import started', JSON.stringify(data.summary || {})]
    );
    const syncRunId = syncRunResult.insertId;

    const [snapshotResult] = await connection.execute(
      `INSERT INTO dashboard_snapshots
       (mode, generated_at, summary_json, sources_json, row_count)
       VALUES (?, ?, ?, ?, ?)`,
      [
        mode,
        generatedAt,
        JSON.stringify(data.summary || {}),
        JSON.stringify(data.sources || {}),
        rows.length
      ]
    );
    const snapshotId = snapshotResult.insertId;

    if (rows.length) await insertRows(connection, snapshotId, mode, rows);

    await connection.execute('DELETE FROM dashboard_snapshots WHERE mode = ? AND id <> ?', [mode, snapshotId]);
    await connection.execute(
      `UPDATE sync_runs
       SET status = ?, finished_at = CURRENT_TIMESTAMP(3), row_count = ?, message = ?, summary_json = ?
       WHERE id = ?`,
      ['success', rows.length, `snapshot ${snapshotId} imported`, JSON.stringify(data.summary || {}), syncRunId]
    );
    await connection.execute(
      `DELETE FROM sync_runs
       WHERE source = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 50
         ) recent_runs
       )`,
      [`dashboard:${mode}`, `dashboard:${mode}`]
    );

    await connection.commit();
    return { snapshotId, mode, rowCount: rows.length, generatedAt };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function loadDashboardSnapshot(mode) {
  const pool = getPool();

  const [snapshots] = await pool.execute(
    `SELECT id, mode, generated_at, row_count,
      CAST(summary_json AS CHAR) AS summary_json,
      CAST(sources_json AS CHAR) AS sources_json,
      created_at
     FROM dashboard_snapshots
     WHERE mode = ?
     ORDER BY id DESC
     LIMIT 1`,
    [mode]
  );

  if (!snapshots.length) {
    const error = new Error(`数据库暂无 ${mode} 看板数据，请先在本机运行领星采集入库`);
    error.code = 'NO_DASHBOARD_SNAPSHOT';
    throw error;
  }

  const snapshot = snapshots[0];
  const [dbRows] = await pool.execute(
    `SELECT CAST(row_json AS CHAR) AS row_json
     FROM dashboard_rows
     WHERE snapshot_id = ?
     ORDER BY row_index ASC`,
    [snapshot.id]
  );

  return {
    generated_at: snapshot.generated_at,
    mode: snapshot.mode,
    sources: parseJson(snapshot.sources_json, {}),
    summary: parseJson(snapshot.summary_json, {}),
    rows: dbRows.map(row => parseJson(row.row_json, {}))
  };
}

async function listSnapshotStatus() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT mode, generated_at, row_count, created_at
     FROM dashboard_snapshots
     ORDER BY mode ASC, id DESC`
  );
  return rows;
}

module.exports = {
  listSnapshotStatus,
  loadDashboardSnapshot,
  saveDashboardSnapshot
};
