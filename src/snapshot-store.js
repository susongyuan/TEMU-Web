const { getPool } = require('./db');
const { initDashboardSchema } = require('./schema');

const INSERT_BATCH_SIZE = 500;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function text(value) {
  return String(value || '').trim();
}

function isVoidLingxingStatus(row = {}) {
  const values = [
    row.statusCode,
    row.lingxingStatusCode,
    row.status,
    row.lingxingStatus,
    row['领星状态码'],
    row['领星状态']
  ].map(text);
  return values.some(value => value === '9' || value === '核价未通过');
}

function filterRowsBeforeInsert(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const filteredRows = sourceRows.filter(row => !isVoidLingxingStatus(row));
  return {
    rows: filteredRows,
    excludedVoidStatusRows: sourceRows.length - filteredRows.length
  };
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
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (stableParts.length) return stableParts.join('|').slice(0, 255);
  return (String(row.id || '').trim() || `row-${index}`).slice(0, 255);
}

function rowKey(row, index) {
  return stableRowKey(row, index);
}

function rowActionLookupKeys(row, index, storedKey) {
  return [
    rowKey(row, index),
    storedKey,
    legacyRowKey(row, index)
  ]
    .map(text)
    .filter(Boolean)
    .filter((key, keyIndex, keys) => keys.indexOf(key) === keyIndex);
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
  const rowInput = filterRowsBeforeInsert(data.rows);
  const rows = rowInput.rows;
  const generatedAt = data.generated_at || new Date().toISOString();
  const summary = {
    ...(data.summary || {}),
    db_import_raw_rows: Array.isArray(data.rows) ? data.rows.length : 0,
    db_import_excluded_void_status_rows: rowInput.excludedVoidStatusRows
  };

  try {
    await connection.beginTransaction();

    const [syncRunResult] = await connection.execute(
      'INSERT INTO sync_runs (source, status, row_count, message, summary_json) VALUES (?, ?, ?, ?, ?)',
      [`dashboard:${mode}`, 'running', rows.length, 'import started', JSON.stringify(summary)]
    );
    const syncRunId = syncRunResult.insertId;

    const [snapshotResult] = await connection.execute(
      `INSERT INTO dashboard_snapshots
       (mode, generated_at, summary_json, sources_json, row_count)
       VALUES (?, ?, ?, ?, ?)`,
      [
        mode,
        generatedAt,
        JSON.stringify(summary),
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
      ['success', rows.length, `snapshot ${snapshotId} imported`, JSON.stringify(summary), syncRunId]
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
  await initDashboardSchema(pool);

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
       , row_key
     FROM dashboard_rows
     WHERE snapshot_id = ?
     ORDER BY row_index ASC`,
    [snapshot.id]
  );
  const parsedRows = dbRows.map((row, index) => {
    const parsed = parseJson(row.row_json, {});
    return {
      row: {
        ...parsed,
        _rowKey: rowKey(parsed, index)
      },
      lookupKeys: rowActionLookupKeys(parsed, index, row.row_key)
    };
  });
  const actionMap = await loadRowActions(pool, mode, parsedRows.flatMap(row => row.lookupKeys));
  const stableActions = new Map();
  const backfills = [];
  for (const { row, lookupKeys } of parsedRows) {
    const primaryKey = row._rowKey;
    const primaryAction = actionMap.get(primaryKey);
    if (primaryAction) {
      stableActions.set(primaryKey, primaryAction);
      continue;
    }
    const savedAction = preferCompletedAction(lookupKeys.slice(1).map(key => actionMap.get(key)));
    if (!savedAction) continue;
    const existing = stableActions.get(primaryKey);
    if (!existing || (existing.status !== '已完成' && savedAction.status === '已完成')) {
      stableActions.set(primaryKey, savedAction);
    }
    backfills.push({ rowKey: primaryKey, status: savedAction.status, note: savedAction.note || '' });
  }
  if (backfills.length) await backfillStableRowActions(pool, mode, backfills);
  const rows = parsedRows.map(({ row }) => withManualActionStatus(mode, row, stableActions.get(row._rowKey)));
  const summary = {
    ...parseJson(snapshot.summary_json, {}),
    manual_actionable_rows: rows.filter(row => row.manualActionable === '是').length,
    manual_pending_rows: rows.filter(row => row.manualProcessStatus === '未处理').length,
    manual_done_rows: rows.filter(row => row.manualProcessStatus === '已完成').length
  };

  return {
    generated_at: snapshot.generated_at,
    mode: snapshot.mode,
    sources: parseJson(snapshot.sources_json, {}),
    summary,
    rows
  };
}

async function loadRowActions(pool, mode, rowKeys) {
  const keys = [...new Set(rowKeys.filter(Boolean))];
  const actions = new Map();
  if (!keys.length) return actions;
  for (let start = 0; start < keys.length; start += INSERT_BATCH_SIZE) {
    const batch = keys.slice(start, start + INSERT_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT row_key, status, note, updated_at
       FROM dashboard_row_actions
       WHERE mode = ? AND row_key IN (${placeholders})`,
      [mode, ...batch]
    );
    for (const row of rows) {
      actions.set(row.row_key, {
        status: row.status,
        note: row.note || '',
        updatedAt: row.updated_at
      });
    }
  }
  return actions;
}

function preferCompletedAction(actions) {
  const valid = actions.filter(Boolean);
  return valid.find(action => action.status === '已完成' && text(action.note)) ||
    valid.find(action => action.status === '已完成') ||
    valid.find(action => text(action.note)) ||
    valid[0] ||
    null;
}

async function backfillStableRowActions(pool, mode, actions) {
  const bestByKey = new Map();
  for (const action of actions) {
    const key = text(action?.rowKey);
    const status = text(action?.status);
    if (!key || !status) continue;
    const existing = bestByKey.get(key);
    if (!existing || (existing.status !== '已完成' && status === '已完成')) {
      bestByKey.set(key, { rowKey: key, status });
    }
  }
  const rows = [...bestByKey.values()];
  if (!rows.length) return;
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
    const values = batch.map(action => [mode, action.rowKey, action.status, text(action.note)]);
    await pool.query(
      `INSERT INTO dashboard_row_actions (mode, row_key, status, note)
       VALUES ?
       ON DUPLICATE KEY UPDATE row_key = row_key`,
      [values]
    );
  }
}

function isManualActionable(mode, row) {
  if (mode === 'inventory') {
    const action = String(row.stockAction || '').trim();
    return Boolean(action && action !== '正常');
  }
  if (mode === 'price') {
    const alert = String(row.priceAlert || '').trim();
    return Boolean(alert && alert !== '价格一致');
  }
  return false;
}

function withManualActionStatus(mode, row, savedAction) {
  const actionable = isManualActionable(mode, row);
  const savedStatus = String(savedAction?.status || '').trim();
  const manualProcessStatus = actionable
    ? (savedStatus === '已完成' ? '已完成' : '未处理')
    : '无需处理';
  return {
    ...row,
    manualActionable: actionable ? '是' : '否',
    manualProcessStatus,
    manualActionUpdatedAt: savedAction?.updatedAt || '',
    manualRemark: savedAction?.note || ''
  };
}

async function setRowActionStatus({ mode, rowKey: key, status }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedKey = String(key || '').trim();
  const normalizedStatus = String(status || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!normalizedKey) throw new Error('rowKey 不能为空');
  if (!['未处理', '已完成'].includes(normalizedStatus)) throw new Error('处理状态无效');

  const pool = getPool();
  await initDashboardSchema(pool);
  await pool.execute(
    `INSERT INTO dashboard_row_actions (mode, row_key, status)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = CURRENT_TIMESTAMP(3)`,
    [normalizedMode, normalizedKey, normalizedStatus]
  );
  return {
    mode: normalizedMode,
    rowKey: normalizedKey,
    status: normalizedStatus,
    updatedAt: new Date().toISOString()
  };
}

async function setRowActionNote({ mode, rowKey: key, note }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedKey = String(key || '').trim();
  const normalizedNote = String(note || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!normalizedKey) throw new Error('rowKey 不能为空');
  if (normalizedNote.length > 300) throw new Error('备注不能超过300字');

  const pool = getPool();
  await initDashboardSchema(pool);
  await pool.execute(
    `INSERT INTO dashboard_row_actions (mode, row_key, status, note)
     VALUES (?, ?, '未处理', ?)
     ON DUPLICATE KEY UPDATE note = VALUES(note), updated_at = CURRENT_TIMESTAMP(3)`,
    [normalizedMode, normalizedKey, normalizedNote]
  );
  return {
    mode: normalizedMode,
    rowKey: normalizedKey,
    note: normalizedNote,
    updatedAt: new Date().toISOString()
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
  rowKey,
  saveDashboardSnapshot,
  setRowActionNote,
  setRowActionStatus
};
