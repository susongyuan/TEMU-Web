const {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} = require('crypto');
const { getPool } = require('./db');
const { initDashboardSchema } = require('./schema');

const INSERT_BATCH_SIZE = 500;
const MYSQL_DATETIME_FORMAT = '%Y-%m-%d %H:%i:%s';
const OPERATOR_NAME_MAX_LENGTH = 32;
const PASSWORD_MIN_LENGTH = 4;
const TOKEN_VERSION = 1;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function text(value) {
  return String(value || '').trim();
}

function dateText(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeOperatorName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function validateOperatorName(value) {
  const name = normalizeOperatorName(value);
  if (!name) throw new Error('请先设置操作人名称');
  if (name.length > OPERATOR_NAME_MAX_LENGTH) throw new Error(`操作人名称不能超过${OPERATOR_NAME_MAX_LENGTH}个字`);
  return name;
}

function normalizePassword(value) {
  return String(value || '');
}

function validatePassword(value) {
  const password = normalizePassword(value);
  if (!password) throw new Error('密码不能为空');
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`密码至少${PASSWORD_MIN_LENGTH}位`);
  if (password.length > 72) throw new Error('密码不能超过72位');
  return password;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const passwordHash = scryptSync(password, salt, 64).toString('hex');
  return { passwordSalt: salt, passwordHash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = Buffer.from(hashPassword(password, salt).passwordHash, 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function authSecret() {
  return process.env.DASHBOARD_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.DB_PASSWORD ||
    process.env.MYSQL_PASSWORD ||
    'temu-dashboard-auth-secret';
}

function signAuthPayload(payloadPart) {
  return createHmac('sha256', authSecret()).update(payloadPart).digest('base64url');
}

function issueAuthToken(operator) {
  const payload = {
    v: TOKEN_VERSION,
    operatorKey: operator.operatorKey,
    operatorName: operator.operatorName,
    iat: Date.now()
  };
  const payloadPart = base64UrlJson(payload);
  return `${payloadPart}.${signAuthPayload(payloadPart)}`;
}

function verifyAuthToken(token) {
  const raw = text(token);
  const [payloadPart, signature] = raw.split('.');
  if (!payloadPart || !signature) throw new Error('请先登录');
  const expectedSignature = signAuthPayload(payloadPart);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('登录状态无效，请重新登录');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new Error('登录状态无效，请重新登录');
  }
  if (payload?.v !== TOKEN_VERSION || !payload.operatorKey) throw new Error('登录状态无效，请重新登录');
  return payload;
}

function operatorDto(row, { includeToken = false } = {}) {
  if (!row) return null;
  const operator = {
    operatorKey: row.operator_key,
    operatorName: row.operator_name,
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at)
  };
  if (includeToken) operator.authToken = issueAuthToken(operator);
  return operator;
}

async function registerOperator({ operatorName, name, password }) {
  const normalizedName = validateOperatorName(operatorName || name);
  const normalizedPassword = validatePassword(password);
  const { passwordSalt, passwordHash } = hashPassword(normalizedPassword);
  const pool = getPool();
  await initDashboardSchema(pool);
  const [existingRows] = await pool.execute(
    `SELECT operator_key, operator_name, password_hash
     FROM dashboard_operators
     WHERE operator_name = ?
     LIMIT 1`,
    [normalizedName]
  );
  if (existingRows.length && existingRows[0].password_hash) throw new Error('该用户名已注册，请直接登录');
  if (existingRows.length) {
    await pool.execute(
      `UPDATE dashboard_operators
       SET password_salt = ?, password_hash = ?, password_updated_at = CURRENT_TIMESTAMP(3),
         last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE operator_name = ?`,
      [passwordSalt, passwordHash, normalizedName]
    );
  } else {
    await pool.execute(
      `INSERT INTO dashboard_operators (operator_key, operator_name, password_salt, password_hash, password_updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [randomUUID(), normalizedName, passwordSalt, passwordHash]
    );
  }
  const [rows] = await pool.execute(
    `SELECT operator_key, operator_name,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_name = ?
     LIMIT 1`,
    [normalizedName]
  );
  return operatorDto(rows[0], { includeToken: true });
}

async function loginOperator({ operatorName, name, password }) {
  const normalizedName = validateOperatorName(operatorName || name);
  const normalizedPassword = validatePassword(password);
  const pool = getPool();
  await initDashboardSchema(pool);
  const [rows] = await pool.execute(
    `SELECT operator_key, operator_name, password_salt, password_hash,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_name = ?
     LIMIT 1`,
    [normalizedName]
  );
  if (!rows.length || !verifyPassword(normalizedPassword, rows[0].password_salt, rows[0].password_hash)) {
    throw new Error('用户名或密码错误');
  }
  await pool.execute(
    'UPDATE dashboard_operators SET last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE operator_key = ?',
    [rows[0].operator_key]
  );
  return operatorDto(rows[0], { includeToken: true });
}

async function resolveOperator(pool, operator = {}) {
  const tokenPayload = verifyAuthToken(operator.authToken || operator.token);
  const operatorKey = text(tokenPayload.operatorKey);
  if (!operatorKey) throw new Error('请先登录');

  const [rows] = await pool.execute(
    `SELECT operator_key, operator_name,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_key = ?
     LIMIT 1`,
    [operatorKey]
  );
  if (!rows.length) throw new Error('登录账号不存在，请重新登录');
  await pool.execute(
    'UPDATE dashboard_operators SET last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE operator_key = ?',
    [rows[0].operator_key]
  );
  return operatorDto(rows[0]);
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
  const noteMap = await loadRowActionNotes(pool, mode, parsedRows.flatMap(row => row.lookupKeys));
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
  const rows = parsedRows.map(({ row, lookupKeys }) => withManualActionStatus(
    mode,
    row,
    stableActions.get(row._rowKey),
    notesForLookupKeys(lookupKeys, noteMap)
  ));
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
      `SELECT row_key, status, note,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_actions
       WHERE mode = ? AND row_key IN (${placeholders})`,
      [mode, ...batch]
    );
    for (const row of rows) {
      actions.set(row.row_key, {
        status: row.status,
        note: row.note || '',
        updatedByOperatorKey: row.updated_by_operator_key || '',
        updatedByName: row.updated_by_operator_name || '',
        updatedAt: row.updated_at
      });
    }
  }
  return actions;
}

function noteDto(row) {
  return {
    id: String(row.id),
    rowKey: row.row_key,
    note: row.note || '',
    createdByOperatorKey: row.created_by_operator_key || '',
    createdByName: row.created_by_operator_name || '',
    updatedByOperatorKey: row.updated_by_operator_key || '',
    updatedByName: row.updated_by_operator_name || '',
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at)
  };
}

async function loadRowActionNotes(pool, mode, rowKeys) {
  const keys = [...new Set(rowKeys.filter(Boolean))];
  const notes = new Map();
  if (!keys.length) return notes;
  for (let start = 0; start < keys.length; start += INSERT_BATCH_SIZE) {
    const batch = keys.slice(start, start + INSERT_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT id, row_key, note,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_action_notes
       WHERE mode = ? AND row_key IN (${placeholders}) AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC`,
      [mode, ...batch]
    );
    for (const row of rows) {
      const key = row.row_key;
      if (!notes.has(key)) notes.set(key, []);
      notes.get(key).push(noteDto(row));
    }
  }
  return notes;
}

function noteTimeMs(note) {
  const value = new Date(note.createdAt || note.updatedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function sortNotes(notes) {
  return [...notes].sort((a, b) => noteTimeMs(b) - noteTimeMs(a) || Number(b.id) - Number(a.id));
}

function notesForLookupKeys(lookupKeys, noteMap) {
  const seen = new Set();
  const notes = [];
  for (const key of lookupKeys) {
    for (const note of noteMap.get(key) || []) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      notes.push(note);
    }
  }
  return sortNotes(notes);
}

function noteLine(note) {
  return [dateText(note.createdAt || note.updatedAt), text(note.note)].filter(Boolean).join(' ');
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

function withManualActionStatus(mode, row, savedAction, notes = []) {
  const actionable = isManualActionable(mode, row);
  const savedStatus = String(savedAction?.status || '').trim();
  const manualProcessStatus = actionable
    ? (savedStatus === '已完成' ? '已完成' : '未处理')
    : '无需处理';
  const sortedNotes = sortNotes(notes);
  const latestNote = sortedNotes[0];
  return {
    ...row,
    manualActionable: actionable ? '是' : '否',
    manualProcessStatus,
    manualActionUpdatedAt: latestNote?.createdAt || savedAction?.updatedAt || '',
    manualActionOperator: savedAction?.updatedByName || latestNote?.createdByName || '',
    manualRemarkAuthors: sortedNotes.map(note => note.createdByName).filter(Boolean).join('\n'),
    manualRemark: sortedNotes.map(noteLine).join('\n'),
    manualNoteCount: sortedNotes.length,
    manualNotes: sortedNotes
  };
}

async function setRowActionStatus({ mode, rowKey: key, status, operator }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedKey = String(key || '').trim();
  const normalizedStatus = String(status || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!normalizedKey) throw new Error('rowKey 不能为空');
  if (!['未处理', '已完成'].includes(normalizedStatus)) throw new Error('处理状态无效');

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  await pool.execute(
    `INSERT INTO dashboard_row_actions (mode, row_key, status, updated_by_operator_key, updated_by_operator_name)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       updated_by_operator_key = VALUES(updated_by_operator_key),
       updated_by_operator_name = VALUES(updated_by_operator_name),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [
      normalizedMode,
      normalizedKey,
      normalizedStatus,
      resolvedOperator.operatorKey,
      resolvedOperator.operatorName
    ]
  );
  return {
    mode: normalizedMode,
    rowKey: normalizedKey,
    status: normalizedStatus,
    operator: resolvedOperator,
    updatedAt: new Date().toISOString()
  };
}

async function setRowActionNote({ mode, rowKey: key, note, operator }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedKey = String(key || '').trim();
  const normalizedNote = String(note || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!normalizedKey) throw new Error('rowKey 不能为空');
  if (normalizedNote.length > 300) throw new Error('备注不能超过300字');
  if (!normalizedNote) throw new Error('备注不能为空');

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO dashboard_row_actions (mode, row_key, status, updated_by_operator_key, updated_by_operator_name)
       VALUES (?, ?, '未处理', ?, ?)
       ON DUPLICATE KEY UPDATE row_key = row_key`,
      [normalizedMode, normalizedKey, resolvedOperator.operatorKey, resolvedOperator.operatorName]
    );
    const [result] = await connection.execute(
      `INSERT INTO dashboard_row_action_notes (
        mode, row_key, note,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedMode,
        normalizedKey,
        normalizedNote,
        resolvedOperator.operatorKey,
        resolvedOperator.operatorName,
        resolvedOperator.operatorKey,
        resolvedOperator.operatorName
      ]
    );
    const [rows] = await connection.execute(
      `SELECT id, row_key, note,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_action_notes
       WHERE id = ?`,
      [result.insertId]
    );
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKey: normalizedKey,
      note: noteDto(rows[0]),
      operator: resolvedOperator,
      updatedAt: dateText(rows[0]?.updated_at)
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function updateRowActionNote({ mode, noteId, note, operator }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedNoteId = String(noteId || '').trim();
  const normalizedNote = String(note || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!/^\d+$/.test(normalizedNoteId)) throw new Error('备注ID无效');
  if (!normalizedNote) throw new Error('备注不能为空');
  if (normalizedNote.length > 300) throw new Error('备注不能超过300字');

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const [result] = await pool.execute(
    `UPDATE dashboard_row_action_notes
     SET note = ?,
       updated_by_operator_key = ?,
       updated_by_operator_name = ?,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND mode = ? AND deleted_at IS NULL`,
    [
      normalizedNote,
      resolvedOperator.operatorKey,
      resolvedOperator.operatorName,
      normalizedNoteId,
      normalizedMode
    ]
  );
  if (!result.affectedRows) throw new Error('备注不存在或已删除');
  const [rows] = await pool.execute(
      `SELECT id, row_key, note,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_row_action_notes
     WHERE id = ? AND mode = ?`,
    [normalizedNoteId, normalizedMode]
  );
  return {
    mode: normalizedMode,
    note: noteDto(rows[0]),
    operator: resolvedOperator,
    updatedAt: dateText(rows[0]?.updated_at)
  };
}

async function deleteRowActionNote({ mode, noteId, operator }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedNoteId = String(noteId || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!/^\d+$/.test(normalizedNoteId)) throw new Error('备注ID无效');

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const [result] = await pool.execute(
    `UPDATE dashboard_row_action_notes
     SET
       deleted_by_operator_key = ?,
       deleted_by_operator_name = ?,
       deleted_at = CURRENT_TIMESTAMP(3),
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND mode = ? AND deleted_at IS NULL`,
    [resolvedOperator.operatorKey, resolvedOperator.operatorName, normalizedNoteId, normalizedMode]
  );
  if (!result.affectedRows) throw new Error('备注不存在或已删除');
  return {
    mode: normalizedMode,
    noteId: normalizedNoteId,
    operator: resolvedOperator,
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
  deleteRowActionNote,
  listSnapshotStatus,
  loginOperator,
  loadDashboardSnapshot,
  registerOperator,
  rowKey,
  saveDashboardSnapshot,
  setRowActionNote,
  setRowActionStatus,
  updateRowActionNote
};
