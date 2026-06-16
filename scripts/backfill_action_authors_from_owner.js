const { createHash } = require('crypto');
const { closePool, getPool } = require('../src/db');
const { initDashboardSchema } = require('../src/schema');

const LEGACY_KEY = 'legacy-shixiaofang';
const LEGACY_NAME = '石小芳';

function text(value) {
  return String(value || '').trim();
}

function ownerOperatorKey(ownerName) {
  const hash = createHash('sha1').update(ownerName).digest('hex').slice(0, 16);
  return `owner-backfill-${hash}`;
}

async function ensureOperator(connection, ownerName, cache) {
  const name = text(ownerName);
  if (!name) return '';
  if (cache.has(name)) return cache.get(name);

  const [existing] = await connection.execute(
    'SELECT operator_key FROM dashboard_operators WHERE operator_name = ? LIMIT 1',
    [name]
  );
  if (existing.length) {
    cache.set(name, existing[0].operator_key);
    return existing[0].operator_key;
  }

  const key = ownerOperatorKey(name);
  cache.set(name, key);
  return key;
}

function isLegacyOperator(key, name) {
  return text(key) === LEGACY_KEY || text(name) === LEGACY_NAME;
}

async function latestOwnerMap(connection) {
  const [rows] = await connection.execute(`
    SELECT r.mode, r.row_key,
      JSON_UNQUOTE(JSON_EXTRACT(r.row_json, '$.owner')) AS owner,
      JSON_UNQUOTE(JSON_EXTRACT(r.row_json, '$.ownerStatus')) AS owner_status,
      JSON_UNQUOTE(JSON_EXTRACT(r.row_json, '$.ownerMatchType')) AS owner_match_type
    FROM dashboard_rows r
    JOIN (
      SELECT mode, MAX(id) AS snapshot_id
      FROM dashboard_snapshots
      GROUP BY mode
    ) latest ON latest.mode = r.mode AND latest.snapshot_id = r.snapshot_id
    WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.row_json, '$.owner')), '') <> ''
  `);
  const owners = new Map();
  const reliableMatchTypes = new Set(['店铺SKU', '精确SKU']);
  for (const row of rows) {
    const key = `${row.mode}\u001f${row.row_key}`;
    const owner = text(row.owner);
    const ownerItems = owner.split(/[；;,，/\n\r]+/).map(item => item.trim()).filter(Boolean);
    const matchType = text(row.owner_match_type);
    if (ownerItems.length !== 1) continue;
    if (text(row.owner_status) !== '已匹配负责人') continue;
    if (!reliableMatchTypes.has(matchType)) continue;
    if (!owner) continue;
    if (!owners.has(key)) owners.set(key, ownerItems[0]);
  }
  return owners;
}

async function main() {
  const pool = getPool();
  await initDashboardSchema(pool);
  const connection = await pool.getConnection();
  const operatorCache = new Map();
  const summary = {
    ownerRows: 0,
    noteRowsUpdated: 0,
    actionRowsUpdated: 0,
    logRowsUpdated: 0,
    skippedWithoutOwner: 0
  };

  try {
    await connection.beginTransaction();
    const owners = await latestOwnerMap(connection);
    summary.ownerRows = owners.size;

    const [notes] = await connection.execute(`
      SELECT id, mode, row_key,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name,
        deleted_by_operator_key, deleted_by_operator_name
      FROM dashboard_row_action_notes
      WHERE created_by_operator_name = ?
        OR created_by_operator_key = ?
        OR updated_by_operator_name = ?
        OR updated_by_operator_key = ?
        OR deleted_by_operator_name = ?
        OR deleted_by_operator_key = ?
    `, [LEGACY_NAME, LEGACY_KEY, LEGACY_NAME, LEGACY_KEY, LEGACY_NAME, LEGACY_KEY]);

    for (const note of notes) {
      const owner = owners.get(`${note.mode}\u001f${note.row_key}`);
      if (!owner) {
        summary.skippedWithoutOwner += 1;
        continue;
      }
      const operatorKey = await ensureOperator(connection, owner, operatorCache);
      const next = {
        createdKey: note.created_by_operator_key,
        createdName: note.created_by_operator_name,
        updatedKey: note.updated_by_operator_key,
        updatedName: note.updated_by_operator_name,
        deletedKey: note.deleted_by_operator_key,
        deletedName: note.deleted_by_operator_name
      };
      if (isLegacyOperator(note.created_by_operator_key, note.created_by_operator_name)) {
        next.createdKey = operatorKey;
        next.createdName = owner;
      }
      if (isLegacyOperator(note.updated_by_operator_key, note.updated_by_operator_name)) {
        next.updatedKey = operatorKey;
        next.updatedName = owner;
      }
      if (isLegacyOperator(note.deleted_by_operator_key, note.deleted_by_operator_name)) {
        next.deletedKey = operatorKey;
        next.deletedName = owner;
      }
      await connection.execute(
        `UPDATE dashboard_row_action_notes
         SET created_by_operator_key = ?,
           created_by_operator_name = ?,
           updated_by_operator_key = ?,
           updated_by_operator_name = ?,
           deleted_by_operator_key = ?,
           deleted_by_operator_name = ?
         WHERE id = ?`,
        [
          next.createdKey,
          next.createdName,
          next.updatedKey,
          next.updatedName,
          next.deletedKey,
          next.deletedName,
          note.id
        ]
      );
      summary.noteRowsUpdated += 1;
    }

    const [actions] = await connection.execute(`
      SELECT id, mode, row_key, updated_by_operator_key, updated_by_operator_name
      FROM dashboard_row_actions
      WHERE updated_by_operator_name = ? OR updated_by_operator_key = ?
    `, [LEGACY_NAME, LEGACY_KEY]);

    for (const action of actions) {
      const owner = owners.get(`${action.mode}\u001f${action.row_key}`);
      if (!owner) continue;
      const operatorKey = await ensureOperator(connection, owner, operatorCache);
      await connection.execute(
        `UPDATE dashboard_row_actions
         SET updated_by_operator_key = ?, updated_by_operator_name = ?
         WHERE id = ?`,
        [operatorKey, owner, action.id]
      );
      summary.actionRowsUpdated += 1;
    }

    const [logs] = await connection.execute(`
      SELECT id, mode, row_key, operator_key, operator_name
      FROM dashboard_operation_logs
      WHERE operator_name = ? OR operator_key = ?
    `, [LEGACY_NAME, LEGACY_KEY]);

    for (const log of logs) {
      const owner = owners.get(`${log.mode}\u001f${log.row_key}`);
      if (!owner) continue;
      const operatorKey = await ensureOperator(connection, owner, operatorCache);
      await connection.execute(
        `UPDATE dashboard_operation_logs
         SET operator_key = ?, operator_name = ?
         WHERE id = ?`,
        [operatorKey, owner, log.id]
      );
      summary.logRowsUpdated += 1;
    }

    await connection.commit();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await closePool();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
