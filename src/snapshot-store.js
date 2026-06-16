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
const OPERATION_LOG_LIMIT_DEFAULT = 200;
const OPERATION_LOG_LIMIT_MAX = 500;
const BULK_ACTION_LIMIT = 1000;
const OPERATION_ACTION_LABELS = {
  operator_register: '注册账号',
  operator_login: '登录账号',
  owner_claim: '认领负责人',
  status_update: '处理状态变更',
  note_create: '新增备注',
  note_update: '编辑备注',
  note_delete: '删除备注'
};
const ROW_ACTION_STATUSES = ['未处理', '已完成', '弃用'];

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

async function dbDateTime(db) {
  const [rows] = await db.execute(`SELECT DATE_FORMAT(CURRENT_TIMESTAMP(3), '${MYSQL_DATETIME_FORMAT}') AS now_at`);
  return rows[0]?.now_at || '';
}

function tokenStamp(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isFinite(time)) return String(time);
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
    passwordUpdatedAt: tokenStamp(operator.passwordUpdatedAt || operator.password_updated_at),
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
    passwordUpdatedAt: dateText(row.password_updated_at),
    createdAt: dateText(row.created_at),
    updatedAt: dateText(row.updated_at)
  };
  if (includeToken) operator.authToken = issueAuthToken(operator);
  return operator;
}

function jsonOrNull(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function operationLabel(actionType, fallback = '') {
  return OPERATION_ACTION_LABELS[actionType] || fallback || actionType;
}

function operationLogDto(row) {
  return {
    id: String(row.id),
    mode: row.mode || '',
    rowKey: row.row_key || '',
    actionType: row.action_type || '',
    actionLabel: row.action_label || operationLabel(row.action_type || ''),
    operatorKey: row.operator_key || '',
    operatorName: row.operator_name || '',
    targetType: row.target_type || '',
    targetId: row.target_id || '',
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    detail: parseJson(row.detail_json, null),
    createdAt: dateText(row.created_at)
  };
}

async function logOperation(db, entry = {}) {
  const actionType = text(entry.actionType);
  if (!actionType) throw new Error('操作日志类型不能为空');
  const operatorName = text(entry.operator?.operatorName || entry.operatorName || '系统');
  await db.execute(
    `INSERT INTO dashboard_operation_logs (
      mode, row_key, action_type, action_label,
      operator_key, operator_name, target_type, target_id,
      before_json, after_json, detail_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      text(entry.mode) || null,
      text(entry.rowKey) || null,
      actionType,
      operationLabel(actionType, entry.actionLabel),
      text(entry.operator?.operatorKey || entry.operatorKey) || null,
      operatorName,
      text(entry.targetType) || null,
      text(entry.targetId).slice(0, 128) || null,
      jsonOrNull(entry.before),
      jsonOrNull(entry.after),
      jsonOrNull(entry.detail)
    ]
  );
}

function normalizeOperationLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return OPERATION_LOG_LIMIT_DEFAULT;
  return Math.min(OPERATION_LOG_LIMIT_MAX, Math.floor(parsed));
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
    `SELECT operator_key, operator_name, password_updated_at,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_name = ?
     LIMIT 1`,
    [normalizedName]
  );
  const operator = operatorDto(rows[0], { includeToken: true });
  await logOperation(pool, {
    actionType: 'operator_register',
    operator,
    targetType: 'operator',
    targetId: operator.operatorKey,
    after: { operatorName: operator.operatorName },
    detail: { operatorName: operator.operatorName }
  });
  return operator;
}

async function provisionOperator({ operatorName, name, password, resetKey = true }) {
  const normalizedName = validateOperatorName(operatorName || name);
  const normalizedPassword = validatePassword(password);
  const { passwordSalt, passwordHash } = hashPassword(normalizedPassword);
  const operatorKey = randomUUID();
  const pool = getPool();
  await initDashboardSchema(pool);
  await pool.execute(
    `INSERT INTO dashboard_operators (
       operator_key, operator_name, password_salt, password_hash,
       password_updated_at, disabled_at, last_seen_at
     )
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), NULL, NULL)
     ON DUPLICATE KEY UPDATE
       operator_key = IF(? = 1, VALUES(operator_key), operator_key),
       password_salt = VALUES(password_salt),
       password_hash = VALUES(password_hash),
       password_updated_at = CURRENT_TIMESTAMP(3),
       disabled_at = NULL,
       updated_at = CURRENT_TIMESTAMP(3)`,
    [
      operatorKey,
      normalizedName,
      passwordSalt,
      passwordHash,
      resetKey ? 1 : 0
    ]
  );
  const [rows] = await pool.execute(
    `SELECT operator_key, operator_name, password_updated_at,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_name = ?
     LIMIT 1`,
    [normalizedName]
  );
  return operatorDto(rows[0]);
}

async function disableOperatorsExcept(operatorNames = []) {
  const names = [...new Set(operatorNames.map(normalizeOperatorName).filter(Boolean))];
  const pool = getPool();
  await initDashboardSchema(pool);
  if (!names.length) {
    const [result] = await pool.execute(
      `UPDATE dashboard_operators
       SET disabled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE disabled_at IS NULL`
    );
    return result.affectedRows || 0;
  }
  const placeholders = names.map(() => '?').join(',');
  const [result] = await pool.execute(
    `UPDATE dashboard_operators
     SET disabled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE disabled_at IS NULL
       AND operator_name NOT IN (${placeholders})`,
    names
  );
  return result.affectedRows || 0;
}

async function loginOperator({ operatorName, name, password }) {
  const normalizedName = validateOperatorName(operatorName || name);
  const normalizedPassword = validatePassword(password);
  const pool = getPool();
  await initDashboardSchema(pool);
  const [rows] = await pool.execute(
    `SELECT operator_key, operator_name, password_salt, password_hash, password_updated_at, disabled_at,
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
  if (rows[0].disabled_at) throw new Error('账号已停用，请联系管理员');
  await pool.execute(
    'UPDATE dashboard_operators SET last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE operator_key = ?',
    [rows[0].operator_key]
  );
  const operator = operatorDto(rows[0], { includeToken: true });
  await logOperation(pool, {
    actionType: 'operator_login',
    operator,
    targetType: 'operator',
    targetId: operator.operatorKey,
    detail: { operatorName: operator.operatorName }
  });
  return operator;
}

async function resolveOperator(pool, operator = {}) {
  await initDashboardSchema(pool);
  const tokenPayload = verifyAuthToken(operator.authToken || operator.token);
  const operatorKey = text(tokenPayload.operatorKey);
  if (!operatorKey) throw new Error('请先登录');

  const [rows] = await pool.execute(
    `SELECT operator_key, operator_name, password_updated_at, disabled_at,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
      DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
     FROM dashboard_operators
     WHERE operator_key = ?
     LIMIT 1`,
    [operatorKey]
  );
  if (!rows.length) throw new Error('登录账号不存在，请重新登录');
  if (rows[0].disabled_at) throw new Error('账号已停用，请联系管理员');
  if (tokenStamp(rows[0].password_updated_at) !== text(tokenPayload.passwordUpdatedAt)) {
    throw new Error('登录状态已失效，请重新登录');
  }
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
    manual_done_rows: rows.filter(row => row.manualProcessStatus === '已完成').length,
    manual_abandoned_rows: rows.filter(row => row.manualProcessStatus === '弃用').length
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
        manual_owner_name,
        claimed_by_operator_key, claimed_by_operator_name,
        DATE_FORMAT(claimed_at, '${MYSQL_DATETIME_FORMAT}') AS claimed_at,
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
        updatedAt: row.updated_at,
        manualOwnerName: row.manual_owner_name || '',
        claimedByOperatorKey: row.claimed_by_operator_key || '',
        claimedByName: row.claimed_by_operator_name || '',
        claimedAt: row.claimed_at || ''
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
  return valid.find(action => action.status === '弃用' && text(action.note)) ||
    valid.find(action => action.status === '弃用') ||
    valid.find(action => action.status === '已完成' && text(action.note)) ||
    valid.find(action => action.status === '已完成') ||
    valid.find(action => text(action.manualOwnerName)) ||
    valid.find(action => text(action.note)) ||
    valid[0] ||
    null;
}

async function backfillStableRowActions(pool, mode, actions) {
  const bestByKey = new Map();
  for (const action of actions) {
    const key = text(action?.rowKey);
    const status = text(action?.status);
    const manualOwnerName = text(action?.manualOwnerName);
    if (!key || (!status && !manualOwnerName)) continue;
    const existing = bestByKey.get(key);
    if (!existing ||
      (existing.status !== '弃用' && status === '弃用') ||
      (!['弃用', '已完成'].includes(existing.status) && status === '已完成') ||
      (!text(existing.manualOwnerName) && manualOwnerName)
    ) {
      bestByKey.set(key, {
        rowKey: key,
        status: status || '未处理',
        manualOwnerName,
        claimedByOperatorKey: text(action?.claimedByOperatorKey),
        claimedByName: text(action?.claimedByName),
        claimedAt: text(action?.claimedAt)
      });
    }
  }
  const rows = [...bestByKey.values()];
  if (!rows.length) return;
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
    const values = batch.map(action => [
      mode,
      action.rowKey,
      action.status,
      text(action.note),
      action.manualOwnerName || null,
      action.claimedByOperatorKey || null,
      action.claimedByName || null,
      action.claimedAt || null
    ]);
    await pool.query(
      `INSERT INTO dashboard_row_actions (
         mode, row_key, status, note,
         manual_owner_name, claimed_by_operator_key, claimed_by_operator_name, claimed_at
       )
       VALUES ?
       ON DUPLICATE KEY UPDATE
         status = IF(status IN ('已完成', '弃用'), status, VALUES(status)),
         manual_owner_name = COALESCE(manual_owner_name, VALUES(manual_owner_name)),
         claimed_by_operator_key = COALESCE(claimed_by_operator_key, VALUES(claimed_by_operator_key)),
         claimed_by_operator_name = COALESCE(claimed_by_operator_name, VALUES(claimed_by_operator_name)),
         claimed_at = COALESCE(claimed_at, VALUES(claimed_at))`,
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
  const manualProcessStatus = ROW_ACTION_STATUSES.includes(savedStatus) && (actionable || savedStatus !== '未处理')
    ? savedStatus
    : actionable ? '未处理' : '无需处理';
  const sortedNotes = sortNotes(notes);
  const latestNote = sortedNotes[0];
  const manualOwnerName = text(savedAction?.manualOwnerName);
  const claimedByName = text(savedAction?.claimedByName);
  const owner = manualOwnerName || row.owner;
  return {
    ...row,
    owner,
    ownerStatus: manualOwnerName ? '已匹配负责人' : row.ownerStatus,
    ownerMatchType: manualOwnerName ? '手动认领' : row.ownerMatchType,
    ownerMatchText: manualOwnerName ? `手动认领：${manualOwnerName}` : row.ownerMatchText,
    manualOwnerName,
    manualOwnerClaimedBy: claimedByName,
    manualOwnerClaimedAt: savedAction?.claimedAt || '',
    manualActionable: (actionable || ['已完成', '弃用'].includes(manualProcessStatus)) ? '是' : '否',
    manualProcessStatus,
    manualActionUpdatedAt: latestNote?.createdAt || savedAction?.updatedAt || savedAction?.claimedAt || '',
    manualActionOperator: savedAction?.updatedByName || latestNote?.createdByName || '',
    manualRemarkAuthors: sortedNotes.map(note => note.createdByName).filter(Boolean).join('\n'),
    manualRemark: sortedNotes.map(noteLine).join('\n'),
    manualNoteCount: sortedNotes.length,
    manualNotes: sortedNotes
  };
}

function normalizeMode(value) {
  const normalizedMode = String(value || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  return normalizedMode;
}

function normalizeRowKey(value) {
  const normalizedKey = String(value || '').trim();
  if (!normalizedKey) throw new Error('rowKey 不能为空');
  return normalizedKey;
}

function normalizeRowKeys(rowKeys) {
  const keys = [...new Set((Array.isArray(rowKeys) ? rowKeys : [rowKeys])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
  if (!keys.length) throw new Error('请先勾选需要处理的行');
  if (keys.length > BULK_ACTION_LIMIT) throw new Error(`一次最多处理${BULK_ACTION_LIMIT}条`);
  return keys;
}

function normalizeRowActionStatus(status) {
  const normalizedStatus = String(status || '').trim();
  if (!ROW_ACTION_STATUSES.includes(normalizedStatus)) throw new Error('处理状态无效');
  return normalizedStatus;
}

async function setRowActionStatus({ mode, rowKey: key, status, operator }) {
  const normalizedMode = normalizeMode(mode);
  const normalizedKey = normalizeRowKey(key);
  const normalizedStatus = normalizeRowActionStatus(status);

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [beforeRows] = await connection.execute(
      `SELECT status,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_actions
       WHERE mode = ? AND row_key = ?
       LIMIT 1`,
      [normalizedMode, normalizedKey]
    );
    const before = beforeRows[0] ? {
      status: beforeRows[0].status,
      updatedByOperatorKey: beforeRows[0].updated_by_operator_key || '',
      updatedByOperatorName: beforeRows[0].updated_by_operator_name || '',
      updatedAt: beforeRows[0].updated_at || ''
    } : null;
    await connection.execute(
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
    await logOperation(connection, {
      mode: normalizedMode,
      rowKey: normalizedKey,
      actionType: 'status_update',
      operator: resolvedOperator,
      targetType: 'row_status',
      targetId: normalizedKey,
      before,
      after: { status: normalizedStatus },
      detail: { status: normalizedStatus }
    });
    const updatedAt = await dbDateTime(connection);
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKey: normalizedKey,
      status: normalizedStatus,
      operator: resolvedOperator,
      updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function normalizeOwnerName(value, fallback = '') {
  const ownerName = text(value || fallback);
  if (!ownerName) throw new Error('负责人不能为空');
  if (ownerName.length > 64) throw new Error('负责人不能超过64个字');
  return ownerName;
}

async function setRowActionOwner({ mode, rowKey: key, ownerName, operator }) {
  const normalizedMode = normalizeMode(mode);
  const normalizedKey = normalizeRowKey(key);
  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const normalizedOwner = normalizeOwnerName(ownerName, resolvedOperator.operatorName);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [beforeRows] = await connection.execute(
      `SELECT manual_owner_name,
        claimed_by_operator_key, claimed_by_operator_name,
        DATE_FORMAT(claimed_at, '${MYSQL_DATETIME_FORMAT}') AS claimed_at
       FROM dashboard_row_actions
       WHERE mode = ? AND row_key = ?
       LIMIT 1`,
      [normalizedMode, normalizedKey]
    );
    const before = beforeRows[0] ? {
      owner: beforeRows[0].manual_owner_name || '',
      claimedByOperatorKey: beforeRows[0].claimed_by_operator_key || '',
      claimedByOperatorName: beforeRows[0].claimed_by_operator_name || '',
      claimedAt: beforeRows[0].claimed_at || ''
    } : null;
    await connection.execute(
      `INSERT INTO dashboard_row_actions (
        mode, row_key, status,
        manual_owner_name, claimed_by_operator_key, claimed_by_operator_name, claimed_at
       )
       VALUES (?, ?, '未处理', ?, ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         manual_owner_name = VALUES(manual_owner_name),
         claimed_by_operator_key = VALUES(claimed_by_operator_key),
         claimed_by_operator_name = VALUES(claimed_by_operator_name),
         claimed_at = CURRENT_TIMESTAMP(3),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        normalizedMode,
        normalizedKey,
        normalizedOwner,
        resolvedOperator.operatorKey,
        resolvedOperator.operatorName
      ]
    );
    await logOperation(connection, {
      mode: normalizedMode,
      rowKey: normalizedKey,
      actionType: 'owner_claim',
      operator: resolvedOperator,
      targetType: 'row_owner',
      targetId: normalizedKey,
      before,
      after: { owner: normalizedOwner },
      detail: { owner: normalizedOwner }
    });
    const updatedAt = await dbDateTime(connection);
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKey: normalizedKey,
      ownerName: normalizedOwner,
      operator: resolvedOperator,
      updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function setBulkRowActionStatus({ mode, rowKeys, status, operator }) {
  const normalizedMode = normalizeMode(mode);
  const keys = normalizeRowKeys(rowKeys);
  const normalizedStatus = normalizeRowActionStatus(status);
  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const normalizedKey of keys) {
      const [beforeRows] = await connection.execute(
        `SELECT status,
          updated_by_operator_key, updated_by_operator_name,
          DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
         FROM dashboard_row_actions
         WHERE mode = ? AND row_key = ?
         LIMIT 1`,
        [normalizedMode, normalizedKey]
      );
      const before = beforeRows[0] ? {
        status: beforeRows[0].status,
        updatedByOperatorKey: beforeRows[0].updated_by_operator_key || '',
        updatedByOperatorName: beforeRows[0].updated_by_operator_name || '',
        updatedAt: beforeRows[0].updated_at || ''
      } : null;
      await connection.execute(
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
      await logOperation(connection, {
        mode: normalizedMode,
        rowKey: normalizedKey,
        actionType: 'status_update',
        operator: resolvedOperator,
        targetType: 'row_status',
        targetId: normalizedKey,
        before,
        after: { status: normalizedStatus },
        detail: { status: normalizedStatus, bulk: true, bulkCount: keys.length }
      });
    }
    const updatedAt = await dbDateTime(connection);
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKeys: keys,
      status: normalizedStatus,
      count: keys.length,
      operator: resolvedOperator,
      updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function setBulkRowActionOwner({ mode, rowKeys, ownerName, operator }) {
  const normalizedMode = normalizeMode(mode);
  const keys = normalizeRowKeys(rowKeys);
  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const normalizedOwner = normalizeOwnerName(ownerName, resolvedOperator.operatorName);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const normalizedKey of keys) {
      const [beforeRows] = await connection.execute(
        `SELECT manual_owner_name,
          claimed_by_operator_key, claimed_by_operator_name,
          DATE_FORMAT(claimed_at, '${MYSQL_DATETIME_FORMAT}') AS claimed_at
         FROM dashboard_row_actions
         WHERE mode = ? AND row_key = ?
         LIMIT 1`,
        [normalizedMode, normalizedKey]
      );
      const before = beforeRows[0] ? {
        owner: beforeRows[0].manual_owner_name || '',
        claimedByOperatorKey: beforeRows[0].claimed_by_operator_key || '',
        claimedByOperatorName: beforeRows[0].claimed_by_operator_name || '',
        claimedAt: beforeRows[0].claimed_at || ''
      } : null;
      await connection.execute(
        `INSERT INTO dashboard_row_actions (
          mode, row_key, status,
          manual_owner_name, claimed_by_operator_key, claimed_by_operator_name, claimed_at
         )
         VALUES (?, ?, '未处理', ?, ?, ?, CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
           manual_owner_name = VALUES(manual_owner_name),
           claimed_by_operator_key = VALUES(claimed_by_operator_key),
           claimed_by_operator_name = VALUES(claimed_by_operator_name),
           claimed_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)`,
        [
          normalizedMode,
          normalizedKey,
          normalizedOwner,
          resolvedOperator.operatorKey,
          resolvedOperator.operatorName
        ]
      );
      await logOperation(connection, {
        mode: normalizedMode,
        rowKey: normalizedKey,
        actionType: 'owner_claim',
        operator: resolvedOperator,
        targetType: 'row_owner',
        targetId: normalizedKey,
        before,
        after: { owner: normalizedOwner },
        detail: { owner: normalizedOwner, bulk: true, bulkCount: keys.length }
      });
    }
    const updatedAt = await dbDateTime(connection);
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKeys: keys,
      ownerName: normalizedOwner,
      count: keys.length,
      operator: resolvedOperator,
      updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function setBulkRowActionNote({ mode, rowKeys, note, operator }) {
  const normalizedMode = normalizeMode(mode);
  const keys = normalizeRowKeys(rowKeys);
  const normalizedNote = String(note || '').trim();
  if (normalizedNote.length > 300) throw new Error('备注不能超过300字');
  if (!normalizedNote) throw new Error('备注不能为空');

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const notes = [];
    for (const normalizedKey of keys) {
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
      const savedNote = noteDto(rows[0]);
      notes.push(savedNote);
      await logOperation(connection, {
        mode: normalizedMode,
        rowKey: normalizedKey,
        actionType: 'note_create',
        operator: resolvedOperator,
        targetType: 'note',
        targetId: savedNote.id,
        after: { note: savedNote.note },
        detail: {
          note: savedNote.note,
          noteId: savedNote.id,
          bulk: true,
          bulkCount: keys.length
        }
      });
    }
    const updatedAt = notes[0]?.createdAt || await dbDateTime(connection);
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKeys: keys,
      notes,
      count: keys.length,
      operator: resolvedOperator,
      updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
    const savedNote = noteDto(rows[0]);
    await logOperation(connection, {
      mode: normalizedMode,
      rowKey: normalizedKey,
      actionType: 'note_create',
      operator: resolvedOperator,
      targetType: 'note',
      targetId: savedNote.id,
      after: { note: savedNote.note },
      detail: {
        note: savedNote.note,
        noteId: savedNote.id
      }
    });
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKey: normalizedKey,
      note: savedNote,
      operator: resolvedOperator,
      updatedAt: savedNote.updatedAt
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
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [beforeRows] = await connection.execute(
      `SELECT id, row_key, note,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_action_notes
       WHERE id = ? AND mode = ? AND deleted_at IS NULL
       LIMIT 1`,
      [normalizedNoteId, normalizedMode]
    );
    if (!beforeRows.length) throw new Error('备注不存在或已删除');
    const beforeNote = noteDto(beforeRows[0]);
    const [result] = await connection.execute(
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
    const [rows] = await connection.execute(
        `SELECT id, row_key, note,
          created_by_operator_key, created_by_operator_name,
          updated_by_operator_key, updated_by_operator_name,
          DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
          DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_action_notes
       WHERE id = ? AND mode = ?`,
      [normalizedNoteId, normalizedMode]
    );
    const savedNote = noteDto(rows[0]);
    await logOperation(connection, {
      mode: normalizedMode,
      rowKey: savedNote.rowKey,
      actionType: 'note_update',
      operator: resolvedOperator,
      targetType: 'note',
      targetId: savedNote.id,
      before: { note: beforeNote.note },
      after: { note: savedNote.note },
      detail: {
        noteId: savedNote.id,
        beforeNote: beforeNote.note,
        afterNote: savedNote.note
      }
    });
    await connection.commit();
    return {
      mode: normalizedMode,
      note: savedNote,
      operator: resolvedOperator,
      updatedAt: savedNote.updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function deleteRowActionNote({ mode, noteId, operator }) {
  const normalizedMode = String(mode || '').trim();
  const normalizedNoteId = String(noteId || '').trim();
  if (!['price', 'inventory'].includes(normalizedMode)) throw new Error('mode 无效');
  if (!/^\d+$/.test(normalizedNoteId)) throw new Error('备注ID无效');

  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [beforeRows] = await connection.execute(
      `SELECT id, row_key, note,
        created_by_operator_key, created_by_operator_name,
        updated_by_operator_key, updated_by_operator_name,
        DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at,
        DATE_FORMAT(updated_at, '${MYSQL_DATETIME_FORMAT}') AS updated_at
       FROM dashboard_row_action_notes
       WHERE id = ? AND mode = ? AND deleted_at IS NULL
       LIMIT 1`,
      [normalizedNoteId, normalizedMode]
    );
    if (!beforeRows.length) throw new Error('备注不存在或已删除');
    const beforeNote = noteDto(beforeRows[0]);
    const [result] = await connection.execute(
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
    await logOperation(connection, {
      mode: normalizedMode,
      rowKey: beforeNote.rowKey,
      actionType: 'note_delete',
      operator: resolvedOperator,
      targetType: 'note',
      targetId: normalizedNoteId,
      before: { note: beforeNote.note },
      detail: {
        noteId: normalizedNoteId,
        note: beforeNote.note
      }
    });
    const updatedAt = await dbDateTime(connection);
    await connection.commit();
    return {
      mode: normalizedMode,
      rowKey: beforeNote.rowKey,
      noteId: normalizedNoteId,
      operator: resolvedOperator,
      updatedAt
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function listOperationLogs(options = {}) {
  const pool = getPool();
  await initDashboardSchema(pool);
  const limit = normalizeOperationLimit(options.limit);
  const where = [];
  const params = [];
  const mode = text(options.mode);
  const actionType = text(options.actionType);
  const operatorName = text(options.operatorName);
  const keyword = text(options.keyword);

  if (mode && ['price', 'inventory'].includes(mode)) {
    where.push('mode = ?');
    params.push(mode);
  }
  if (actionType) {
    where.push('action_type = ?');
    params.push(actionType);
  }
  if (operatorName) {
    where.push('operator_name LIKE ?');
    params.push(`%${operatorName}%`);
  }
  if (keyword) {
    where.push(`(
      operator_name LIKE ?
      OR action_label LIKE ?
      OR action_type LIKE ?
      OR COALESCE(mode, '') LIKE ?
      OR COALESCE(row_key, '') LIKE ?
      OR COALESCE(target_id, '') LIKE ?
      OR COALESCE(CAST(detail_json AS CHAR), '') LIKE ?
    )`);
    const likeKeyword = `%${keyword}%`;
    params.push(likeKeyword, likeKeyword, likeKeyword, likeKeyword, likeKeyword, likeKeyword, likeKeyword);
  }

  const [rows] = await pool.execute(
    `SELECT id, mode, row_key, action_type, action_label,
      operator_key, operator_name, target_type, target_id,
      CAST(before_json AS CHAR) AS before_json,
      CAST(after_json AS CHAR) AS after_json,
      CAST(detail_json AS CHAR) AS detail_json,
      DATE_FORMAT(created_at, '${MYSQL_DATETIME_FORMAT}') AS created_at
     FROM dashboard_operation_logs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`,
    params
  );
  return rows.map(operationLogDto);
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
  listOperationLogs,
  listSnapshotStatus,
  loginOperator,
  loadDashboardSnapshot,
  disableOperatorsExcept,
  provisionOperator,
  registerOperator,
  resolveOperator,
  rowKey,
  saveDashboardSnapshot,
  setBulkRowActionNote,
  setBulkRowActionOwner,
  setBulkRowActionStatus,
  setRowActionOwner,
  setRowActionNote,
  setRowActionStatus,
  updateRowActionNote
};
