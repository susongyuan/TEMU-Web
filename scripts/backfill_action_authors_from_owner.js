const { createHash } = require('crypto');
const { closePool, getPool } = require('../src/db');
const { initDashboardSchema } = require('../src/schema');

const LEGACY_KEY = 'legacy-shixiaofang';
const LEGACY_NAME = '石小芳';
const OWNER_BACKFILL_PREFIX = 'owner-backfill-';

function text(value) {
  return String(value || '').trim();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function ownerOperatorKey(ownerName) {
  const hash = createHash('sha1').update(ownerName).digest('hex').slice(0, 16);
  return `${OWNER_BACKFILL_PREFIX}${hash}`;
}

function ownerItems(value) {
  return text(value)
    .split(/[；;,，/\n\r]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function stableRowKey(row, index) {
  const candidates = [
    ['spu', row.platformSpu || row.spuId],
    ['skc', row.skcId],
    ['sku-id', row.skuId],
    ['sku', row.skuCode],
    ['mall-goods', row.mallId && row.goodsId ? `${row.mallId}|${row.goodsId}` : ''],
    ['goods', row.goodsId],
    ['id', row.id]
  ];
  for (const [label, value] of candidates) {
    const normalized = text(value);
    if (normalized) return `${label}:${normalized}`.slice(0, 255);
  }
  return `row-${index}`.slice(0, 255);
}

function legacyRowKey(row, index) {
  const stableParts = [
    row.platformSpu,
    row.spuId,
    row.storeRegion,
    row.storeName,
    row.area,
    row.regionGroup,
    row.skcId,
    row.skuId,
    row.listingSkuCodes,
    row.skuCode,
    row.mallId,
    row.goodsId,
    row.stockAction,
    row.priceAlert
  ]
    .map(value => text(value))
    .filter(Boolean);
  if (stableParts.length) return stableParts.join('|').slice(0, 255);
  return (text(row.id) || `row-${index}`).slice(0, 255);
}

function historicalKey(key) {
  const value = text(key);
  return value === LEGACY_KEY || value.startsWith(OWNER_BACKFILL_PREFIX);
}

function isHistoricalAuthor(key, name, historicalOperatorKeys) {
  const authorKey = text(key);
  if (historicalKey(authorKey)) return true;
  if (authorKey && historicalOperatorKeys.has(authorKey)) return true;
  return !authorKey && text(name) === LEGACY_NAME;
}

function readArgs() {
  const args = new Set(process.argv.slice(2));
  return { apply: args.has('--apply') };
}

function addOwner(ownerMap, key, owner, summary) {
  const normalizedKey = text(key);
  const normalizedOwner = text(owner);
  if (!normalizedKey || !normalizedOwner) return;
  const existing = ownerMap.get(normalizedKey);
  if (existing && existing !== normalizedOwner) {
    ownerMap.set(normalizedKey, '');
    summary.ownerKeyConflicts += 1;
    return;
  }
  if (!existing) ownerMap.set(normalizedKey, normalizedOwner);
}

async function latestOwnerMap(connection, summary) {
  const [rows] = await connection.execute(`
    SELECT r.mode, r.row_key, r.row_index, CAST(r.row_json AS CHAR) AS row_json
    FROM dashboard_rows r
    JOIN (
      SELECT mode, MAX(id) AS snapshot_id
      FROM dashboard_snapshots
      GROUP BY mode
    ) latest ON latest.mode = r.mode AND latest.snapshot_id = r.snapshot_id
  `);

  const owners = new Map();
  for (const row of rows) {
    const parsed = parseJson(row.row_json, {});
    const owner = ownerItems(parsed.owner);
    if (owner.length !== 1) continue;
    if (text(parsed.ownerStatus) !== '已匹配负责人') continue;

    const mapKeyPrefix = `${row.mode}\u001f`;
    addOwner(owners, `${mapKeyPrefix}${row.row_key}`, owner[0], summary);
    addOwner(owners, `${mapKeyPrefix}${stableRowKey(parsed, row.row_index)}`, owner[0], summary);
    addOwner(owners, `${mapKeyPrefix}${legacyRowKey(parsed, row.row_index)}`, owner[0], summary);
  }
  for (const [key, owner] of [...owners.entries()]) {
    if (!owner) owners.delete(key);
  }
  summary.ownerRows = owners.size;
  return owners;
}

async function historicalOperatorKeys(connection) {
  const [rows] = await connection.execute(`
    SELECT operator_key
    FROM dashboard_operators
    WHERE password_hash IS NULL
       OR operator_key = ?
       OR operator_key LIKE ?
  `, [LEGACY_KEY, `${OWNER_BACKFILL_PREFIX}%`]);
  return new Set(rows.map(row => text(row.operator_key)).filter(Boolean));
}

async function ownerOperator(connection, ownerName, cache) {
  const name = text(ownerName);
  if (!name) return { key: '', name: '' };
  if (cache.has(name)) return cache.get(name);

  const [rows] = await connection.execute(
    `SELECT operator_key, password_hash, disabled_at
     FROM dashboard_operators
     WHERE operator_name = ?
     ORDER BY (password_hash IS NOT NULL) DESC, (disabled_at IS NULL) DESC, id DESC
     LIMIT 1`,
    [name]
  );
  const active = rows.find(row => row.password_hash && !row.disabled_at);
  const operator = {
    key: active?.operator_key || rows[0]?.operator_key || ownerOperatorKey(name),
    name
  };
  cache.set(name, operator);
  return operator;
}

function ownerForRow(ownerMap, mode, rowKey) {
  return ownerMap.get(`${mode}\u001f${rowKey}`) || '';
}

async function syncNotes(connection, ownerMap, historicalOperatorKeys, operatorCache, summary) {
  const [notes] = await connection.execute(`
    SELECT id, mode, row_key,
      created_by_operator_key, created_by_operator_name,
      updated_by_operator_key, updated_by_operator_name,
      deleted_by_operator_key, deleted_by_operator_name
    FROM dashboard_row_action_notes
  `);
  summary.notesScanned = notes.length;

  for (const note of notes) {
    const owner = ownerForRow(ownerMap, note.mode, note.row_key);
    if (!owner) {
      summary.notesSkippedWithoutOwner += 1;
      continue;
    }
    const operator = await ownerOperator(connection, owner, operatorCache);
    const next = {
      createdKey: note.created_by_operator_key,
      createdName: note.created_by_operator_name,
      updatedKey: note.updated_by_operator_key,
      updatedName: note.updated_by_operator_name,
      deletedKey: note.deleted_by_operator_key,
      deletedName: note.deleted_by_operator_name
    };

    if (isHistoricalAuthor(note.created_by_operator_key, note.created_by_operator_name, historicalOperatorKeys)) {
      next.createdKey = operator.key;
      next.createdName = operator.name;
    }
    if (isHistoricalAuthor(note.updated_by_operator_key, note.updated_by_operator_name, historicalOperatorKeys)) {
      next.updatedKey = operator.key;
      next.updatedName = operator.name;
    }
    if (isHistoricalAuthor(note.deleted_by_operator_key, note.deleted_by_operator_name, historicalOperatorKeys)) {
      next.deletedKey = operator.key;
      next.deletedName = operator.name;
    }

    const changed =
      text(next.createdKey) !== text(note.created_by_operator_key) ||
      text(next.createdName) !== text(note.created_by_operator_name) ||
      text(next.updatedKey) !== text(note.updated_by_operator_key) ||
      text(next.updatedName) !== text(note.updated_by_operator_name) ||
      text(next.deletedKey) !== text(note.deleted_by_operator_key) ||
      text(next.deletedName) !== text(note.deleted_by_operator_name);
    if (!changed) continue;

    await connection.execute(
      `UPDATE dashboard_row_action_notes
       SET created_by_operator_key = ?,
         created_by_operator_name = ?,
         updated_by_operator_key = ?,
         updated_by_operator_name = ?,
         deleted_by_operator_key = ?,
         deleted_by_operator_name = ?,
         updated_at = updated_at
       WHERE id = ?`,
      [
        next.createdKey || null,
        next.createdName || null,
        next.updatedKey || null,
        next.updatedName || null,
        next.deletedKey || null,
        next.deletedName || null,
        note.id
      ]
    );
    summary.noteRowsUpdated += 1;
  }
}

async function syncRowActions(connection, ownerMap, historicalOperatorKeys, operatorCache, summary) {
  const [actions] = await connection.execute(`
    SELECT id, mode, row_key,
      updated_by_operator_key, updated_by_operator_name,
      manual_owner_name,
      claimed_by_operator_key, claimed_by_operator_name
    FROM dashboard_row_actions
  `);
  summary.rowActionsScanned = actions.length;

  for (const action of actions) {
    const owner = ownerForRow(ownerMap, action.mode, action.row_key);
    if (!owner) {
      summary.rowActionsSkippedWithoutOwner += 1;
      continue;
    }
    const operator = await ownerOperator(connection, owner, operatorCache);
    const syncUpdated = isHistoricalAuthor(
      action.updated_by_operator_key,
      action.updated_by_operator_name,
      historicalOperatorKeys
    );
    const syncClaimed = isHistoricalAuthor(
      action.claimed_by_operator_key,
      action.claimed_by_operator_name,
      historicalOperatorKeys
    );
    if (!syncUpdated && !syncClaimed) continue;

    const nextUpdatedKey = syncUpdated ? operator.key : action.updated_by_operator_key;
    const nextUpdatedName = syncUpdated ? operator.name : action.updated_by_operator_name;
    const nextClaimedKey = syncClaimed ? operator.key : action.claimed_by_operator_key;
    const nextClaimedName = syncClaimed ? operator.name : action.claimed_by_operator_name;
    const nextManualOwner = syncClaimed && text(action.manual_owner_name) ? operator.name : action.manual_owner_name;

    await connection.execute(
      `UPDATE dashboard_row_actions
       SET updated_by_operator_key = ?,
         updated_by_operator_name = ?,
         manual_owner_name = ?,
         claimed_by_operator_key = ?,
         claimed_by_operator_name = ?,
         updated_at = updated_at
       WHERE id = ?`,
      [
        nextUpdatedKey || null,
        nextUpdatedName || null,
        nextManualOwner || null,
        nextClaimedKey || null,
        nextClaimedName || null,
        action.id
      ]
    );
    summary.rowActionRowsUpdated += 1;
  }
}

function isHistoricalLog(log, historicalOperatorKeys) {
  const detail = parseJson(log.detail_json, {});
  return Boolean(detail?.historicalBackfill) ||
    isHistoricalAuthor(log.operator_key, log.operator_name, historicalOperatorKeys);
}

async function syncOperationLogs(connection, ownerMap, historicalOperatorKeys, operatorCache, summary) {
  const [logs] = await connection.execute(`
    SELECT id, mode, row_key, action_type,
      operator_key, operator_name,
      CAST(after_json AS CHAR) AS after_json,
      CAST(detail_json AS CHAR) AS detail_json
    FROM dashboard_operation_logs
    WHERE row_key IS NOT NULL
      AND row_key <> ''
  `);
  summary.logsScanned = logs.length;

  for (const log of logs) {
    if (!isHistoricalLog(log, historicalOperatorKeys)) continue;
    const owner = ownerForRow(ownerMap, log.mode, log.row_key);
    if (!owner) {
      summary.logsSkippedWithoutOwner += 1;
      continue;
    }
    const operator = await ownerOperator(connection, owner, operatorCache);
    const after = parseJson(log.after_json, null);
    const detail = parseJson(log.detail_json, null);
    let nextAfter = after;
    let nextDetail = detail;

    if (log.action_type === 'owner_claim') {
      nextAfter = { ...(after || {}), owner: operator.name };
      nextDetail = { ...(detail || {}), owner: operator.name };
    }

    const changed =
      text(log.operator_key) !== operator.key ||
      text(log.operator_name) !== operator.name ||
      JSON.stringify(after) !== JSON.stringify(nextAfter) ||
      JSON.stringify(detail) !== JSON.stringify(nextDetail);
    if (!changed) continue;

    await connection.execute(
      `UPDATE dashboard_operation_logs
       SET operator_key = ?,
         operator_name = ?,
         after_json = ?,
         detail_json = ?
       WHERE id = ?`,
      [
        operator.key,
        operator.name,
        nextAfter === null ? null : JSON.stringify(nextAfter),
        nextDetail === null ? null : JSON.stringify(nextDetail),
        log.id
      ]
    );
    summary.logRowsUpdated += 1;
  }
}

async function main() {
  const options = readArgs();
  const pool = getPool();
  await initDashboardSchema(pool);
  const connection = await pool.getConnection();
  const operatorCache = new Map();
  const summary = {
    apply: options.apply,
    ownerRows: 0,
    ownerKeyConflicts: 0,
    notesScanned: 0,
    noteRowsUpdated: 0,
    notesSkippedWithoutOwner: 0,
    rowActionsScanned: 0,
    rowActionRowsUpdated: 0,
    rowActionsSkippedWithoutOwner: 0,
    logsScanned: 0,
    logRowsUpdated: 0,
    logsSkippedWithoutOwner: 0
  };

  try {
    await connection.beginTransaction();
    const owners = await latestOwnerMap(connection, summary);
    const historicalKeys = await historicalOperatorKeys(connection);
    await syncNotes(connection, owners, historicalKeys, operatorCache, summary);
    await syncRowActions(connection, owners, historicalKeys, operatorCache, summary);
    await syncOperationLogs(connection, owners, historicalKeys, operatorCache, summary);

    if (options.apply) {
      await connection.commit();
    } else {
      await connection.rollback();
      summary.dryRun = true;
      summary.message = 'Dry run only. Re-run with --apply to write changes.';
    }
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
