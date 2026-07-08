const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} = require('crypto');
const { getPool } = require('./db');
const { initDashboardSchema } = require('./schema');
const {
  buildPriceDataFromBackendAndOfficialRowsAsync,
  normalizeBackendExport,
  normalizeOfficial
} = require('./data-loader');

const INSERT_BATCH_SIZE = Number(process.env.DASHBOARD_INSERT_BATCH_SIZE || 1000);
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
  note_delete: '删除备注',
  sku_owner_mapping_upload: '上传SKU-运营表',
  temu_backend_products_upload: '上传TEMU后台数据',
  temu_official_products_upload: '上传TEMU前端价格'
};
const ROW_ACTION_STATUSES = ['未完成', '已完成', '已下架'];
const LEGACY_ROW_ACTION_STATUS_MAP = {
  '未处理': '未完成',
  '弃用': '已下架'
};
const FINAL_ROW_ACTION_STATUSES = new Set(['已完成', '已下架']);

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function text(value) {
  return String(value || '').trim();
}

function normalizeSavedRowActionStatus(value) {
  const status = text(value);
  return LEGACY_ROW_ACTION_STATUS_MAP[status] || status;
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

function importTrace(message) {
  if (process.env.DASHBOARD_IMPORT_TRACE === '1') {
    console.log(`[IMPORT] ${message}`);
  }
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
    const inserted = Math.min(start + batch.length, rows.length);
    if (inserted === rows.length || inserted % 1000 === 0) {
      console.log(`[IMPORT] ${mode}: inserted ${inserted}/${rows.length} rows`);
    }
  }
}

function hasTemuOfficialRows(data = {}) {
  const summaryCount = Number(data.summary?.temu_official_rows || 0);
  const officialSource = data.sources?.temu_official || null;
  const sourceCount = Number(officialSource?.row_count || 0);
  if (summaryCount > 0 || sourceCount > 0) return true;
  if (officialSource?.type && !['empty', 'pending_upload_db_merge'].includes(String(officialSource.type))) return true;
  return (Array.isArray(data.rows) ? data.rows : []).some(row =>
    row?.sourceSide === 'TEMU官方' ||
    text(row?.officialTitle) ||
    text(row?.officialPrice)
  );
}

async function loadTemuOfficialProducts(connectionOrPool = getPool()) {
  const [rows] = await connectionOrPool.execute(
    `SELECT row_index, CAST(row_json AS CHAR) AS row_json, uploaded_at
     FROM temu_official_products
     ORDER BY row_index ASC`
  );
  return rows.map(row => ({
    row: parseJson(row.row_json, {}),
    uploadedAt: dateText(row.uploaded_at)
  }));
}

async function replaceTemuOfficialProducts(rows) {
  const pool = getPool();
  await initDashboardSchema(pool);
  const connection = await pool.getConnection();
  const cleanRows = (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === 'object');

  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM temu_official_products');
    for (let start = 0; start < cleanRows.length; start += INSERT_BATCH_SIZE) {
      const batch = cleanRows.slice(start, start + INSERT_BATCH_SIZE);
      const values = batch.map((row, offset) => [
        start + offset,
        JSON.stringify(row)
      ]);
      await connection.query(
        'INSERT INTO temu_official_products (row_index, row_json) VALUES ?',
        [values]
      );
    }
    await connection.commit();
    return { rowCount: cleanRows.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function loadTemuBackendProducts(connectionOrPool = getPool()) {
  const [rows] = await connectionOrPool.execute(
    `SELECT row_index, CAST(row_json AS CHAR) AS row_json, uploaded_at
     FROM temu_backend_products
     ORDER BY row_index ASC`
  );
  return rows.map(row => ({
    row: parseJson(row.row_json, {}),
    uploadedAt: dateText(row.uploaded_at)
  }));
}

function cleanBackendProductRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === 'object');
}

function backendUploadIdentityParts(row) {
  const backend = normalizeBackendExport([row], 'TEMU后台上传数据')[0] || {};
  const store = identityToken(backend.mallId) || identityToken(backend.storeName);
  const site = identityToken(backend.site || backend.backendPriceSite || backend.area);
  const spu = identityToken(backend.platformSpu);
  const skuId = identityToken(backend.skuId);
  const skuCode = identityToken(backend.skuCode);
  const skcId = identityToken(backend.skcId);
  const title = identityTitle(backend.title);
  return { store, site, spu, skuId, skuCode, skcId, title };
}

function backendUploadScope(row) {
  const { store, site } = backendUploadIdentityParts(row);
  if (!store) return '';
  return `${store}:${site || '*'}`;
}

function backendScopeMatches(uploadScope, rowScope) {
  if (!uploadScope || !rowScope) return false;
  const [uploadStore, uploadSite] = uploadScope.split(':');
  const [rowStore, rowSite] = rowScope.split(':');
  if (!uploadStore || uploadStore !== rowStore) return false;
  return uploadSite === '*' || uploadSite === rowSite;
}

function backendUploadIdentityKey(row) {
  const { store, site, spu, skuId, skuCode, skcId, title } = backendUploadIdentityParts(row);
  const item = skuId || skuCode || skcId || title;
  if (store && site && spu && item) return `store-site-spu-item:${store}:${site}:${spu}:${item}`;
  if (store && spu && item) return `store-spu-item:${store}:${spu}:${item}`;
  if (store && site && title) return `store-site-title:${store}:${site}:${title}`;
  if (store && title) return `store-title:${store}:${title}`;
  if (spu && item) return `spu-item:${spu}:${item}`;
  if (spu && site) return `spu-site:${spu}:${site}`;
  if (title && site) return `title-site:${title}:${site}`;
  if (title) return `title:${title}`;
  return officialRowHash(row);
}

function mergeTemuBackendProductRows(existingRows, rows) {
  const currentRows = cleanBackendProductRows(existingRows);
  const uploadRows = cleanBackendProductRows(rows);
  const uploadScopes = new Set(uploadRows.map(backendUploadScope).filter(Boolean));
  const scopedExistingRows = uploadScopes.size
    ? currentRows.filter(row => {
      const rowScope = backendUploadScope(row);
      return ![...uploadScopes].some(scope => backendScopeMatches(scope, rowScope));
    })
    : currentRows;
  const removedByScope = currentRows.length - scopedExistingRows.length;
  const mergedRows = [];
  const indexByKey = new Map();
  let updatedRows = 0;
  let insertedRows = 0;

  const upsert = (row, countAsUpload = false) => {
    const key = backendUploadIdentityKey(row);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      mergedRows[existingIndex] = row;
      if (countAsUpload) updatedRows += 1;
      return;
    }
    indexByKey.set(key, mergedRows.length);
    mergedRows.push(row);
    if (countAsUpload) insertedRows += 1;
  };

  for (const row of scopedExistingRows) upsert(row, false);
  for (const row of uploadRows) upsert(row, true);

  return {
    rowCount: mergedRows.length,
    uploadedRows: uploadRows.length,
    insertedRows,
    updatedRows,
    removedByScope,
    scopes: [...uploadScopes],
    rows: mergedRows
  };
}

async function writeTemuBackendProducts(connection, rows) {
  await connection.execute('DELETE FROM temu_backend_products');
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
    const values = batch.map((row, offset) => [
      start + offset,
      JSON.stringify(row)
    ]);
    await connection.query(
      'INSERT INTO temu_backend_products (row_index, row_json) VALUES ?',
      [values]
    );
  }
}

async function mergeTemuBackendProducts(rows) {
  const pool = getPool();
  await initDashboardSchema(pool);
  const connection = await pool.getConnection();
  const uploadRows = cleanBackendProductRows(rows);

  try {
    await connection.beginTransaction();
    const existingRows = (await loadTemuBackendProducts(connection)).map(item => item.row);
    const merged = mergeTemuBackendProductRows(existingRows, uploadRows);

    await writeTemuBackendProducts(connection, merged.rows);
    await connection.commit();
    return merged;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function officialUploadIdentityParts(row) {
  const official = normalizeOfficial([row])[0] || {};
  const mallId = identityToken(official.mallId);
  const goodsId = identityToken(official.goodsId);
  const site = identityToken(official.officialSite || official.site);
  const store = mallId || identityToken(official.storeName);
  const title = identityTitle(official.title);
  const skuCode = identityToken(official.skuCode);
  const imageKey = identityToken(official.imageHash || official.image);
  return { mallId, goodsId, site, store, title, skuCode, imageKey };
}

function identityToken(value) {
  return text(value).toLowerCase().replace(/[^\p{Letter}\p{Number}\u4e00-\u9fa5]+/gu, '').trim();
}

function identityTitle(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function officialRowHash(row) {
  return `row-hash:${createHash('sha1').update(JSON.stringify(row || {})).digest('hex')}`;
}

function officialUploadPreciseIdentityKeys(row) {
  const { mallId, goodsId, site, store, title, skuCode, imageKey } = officialUploadIdentityParts(row);
  const keys = [];
  const add = key => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  if (mallId && goodsId && site) add(`mall-goods-site:${mallId}:${goodsId}:${site}`);
  if (store && title && site) add(`store-site-title:${store}:${site}:${title}`);
  if (store && imageKey && site) add(`store-site-image:${store}:${site}:${imageKey}`);
  if (store && skuCode && site) add(`store-site-sku:${store}:${site}:${skuCode}`);
  if (goodsId && site) add(`goods-site:${goodsId}:${site}`);
  if (title && imageKey && site) add(`title-image-site:${site}:${title}:${imageKey}`);
  if (title && site) add(`title-site:${site}:${title}`);
  if (imageKey && site) add(`image:${site}:${imageKey}`);
  if (skuCode && site) add(`sku:${site}:${skuCode}`);
  if (!keys.length && !site) add(officialRowHash(row));
  return keys;
}

function officialUploadBroadIdentityKeys(row) {
  const { mallId, goodsId, site, store, title, skuCode, imageKey } = officialUploadIdentityParts(row);
  const sitePart = site || 'unknown';
  const keys = [];
  const add = key => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  if (mallId && goodsId) add(`mall-goods:${mallId}:${goodsId}`);
  if (store && title) add(`store-title:${store}:${title}`);
  if (store && imageKey) add(`store-image:${store}:${imageKey}`);
  if (store && skuCode) add(`store-sku:${store}:${skuCode}`);
  if (goodsId) add(`goods:${goodsId}`);
  if (title && imageKey) add(`title-image:${title}:${imageKey}`);
  if (title) add(`title:${title}`);
  if (imageKey) add(`image:${sitePart}:${imageKey}`);
  if (skuCode) add(`sku:${sitePart}:${skuCode}`);
  if (!keys.length) add(`row-hash:${stableHash(JSON.stringify(row || {}))}`);
  return keys;
}

function hasOfficialUploadSite(row) {
  return Boolean(officialUploadIdentityParts(row).site);
}

function firstMappedIndex(keys, map) {
  for (const key of keys) {
    const index = map.get(key);
    if (index !== undefined) return index;
  }
  return undefined;
}

function cleanOfficialProductRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === 'object');
}

function mergeTemuOfficialProductRows(existingRows, rows) {
  const currentRows = cleanOfficialProductRows(existingRows);
  const uploadRows = cleanOfficialProductRows(rows);
  const mergedRows = [];
  const preciseIndexByKey = new Map();
  const broadIndexByKey = new Map();
  let updatedRows = 0;
  let insertedRows = 0;
  const addRowIndex = (row, rowIndex) => {
    for (const key of officialUploadPreciseIdentityKeys(row)) preciseIndexByKey.set(key, rowIndex);
    if (!hasOfficialUploadSite(row)) {
      for (const key of officialUploadBroadIdentityKeys(row)) broadIndexByKey.set(key, rowIndex);
    }
  };
  const deleteBroadRowIndex = (row, rowIndex) => {
    for (const key of officialUploadBroadIdentityKeys(row)) {
      if (broadIndexByKey.get(key) === rowIndex) broadIndexByKey.delete(key);
    }
  };

  for (const row of currentRows) {
    const preciseKeys = officialUploadPreciseIdentityKeys(row);
    const broadKeys = officialUploadBroadIdentityKeys(row);
    const existingIndex = firstMappedIndex(preciseKeys, preciseIndexByKey) ??
      (!hasOfficialUploadSite(row) ? firstMappedIndex(broadKeys, broadIndexByKey) : undefined);
    if (existingIndex !== undefined) {
      mergedRows[existingIndex] = row;
      addRowIndex(row, existingIndex);
      continue;
    }
    const rowIndex = mergedRows.length;
    mergedRows.push(row);
    addRowIndex(row, rowIndex);
  }

  for (const row of uploadRows) {
    const preciseKeys = officialUploadPreciseIdentityKeys(row);
    const broadKeys = officialUploadBroadIdentityKeys(row);
    const existingIndex = firstMappedIndex(preciseKeys, preciseIndexByKey) ??
      firstMappedIndex(broadKeys, broadIndexByKey);
    if (existingIndex !== undefined) {
      const previousRow = mergedRows[existingIndex];
      deleteBroadRowIndex(previousRow, existingIndex);
      mergedRows[existingIndex] = row;
      addRowIndex(row, existingIndex);
      updatedRows += 1;
    } else {
      const rowIndex = mergedRows.length;
      mergedRows.push(row);
      addRowIndex(row, rowIndex);
      insertedRows += 1;
    }
  }

  return {
    rowCount: mergedRows.length,
    uploadedRows: uploadRows.length,
    insertedRows,
    updatedRows,
    rows: mergedRows
  };
}

async function writeTemuOfficialProducts(connection, rows) {
  await connection.execute('DELETE FROM temu_official_products');
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
    const values = batch.map((row, offset) => [
      start + offset,
      JSON.stringify(row)
    ]);
    await connection.query(
      'INSERT INTO temu_official_products (row_index, row_json) VALUES ?',
      [values]
    );
  }
}

async function mergeTemuOfficialProducts(rows) {
  const pool = getPool();
  await initDashboardSchema(pool);
  const connection = await pool.getConnection();
  const uploadRows = cleanOfficialProductRows(rows);

  try {
    await connection.beginTransaction();
    const existingRows = (await loadTemuOfficialProducts(connection)).map(item => item.row);
    const merged = mergeTemuOfficialProductRows(existingRows, uploadRows);

    await writeTemuOfficialProducts(connection, merged.rows);
    await connection.commit();
    return merged;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function mergePersistedTemuOfficialProducts(data, connection) {
  if (String(data.mode) !== 'price' || hasTemuOfficialRows(data)) return data;

  const officialRows = await loadTemuOfficialProducts(connection);
  if (!officialRows.length) return data;

  const { mergeOfficialRowsIntoPriceSnapshotAsync } = require('./data-loader');
  const merged = await mergeOfficialRowsIntoPriceSnapshotAsync(data, officialRows.map(item => item.row));
  const updatedAt = officialRows
    .map(item => item.uploadedAt)
    .filter(Boolean)
    .sort()
    .pop() || new Date().toISOString();
  return {
    ...merged,
    sources: {
      ...(merged.sources || {}),
      temu_official: {
        type: 'upload_db',
        row_count: officialRows.length,
        updated_at: updatedAt
      }
    },
    summary: {
      ...(merged.summary || {}),
      temu_official_rows: officialRows.length
    }
  };
}

async function mergePersistedTemuBackendProducts(data, connection) {
  if (String(data.mode) !== 'price') return data;

  const incomingBackendSource = data.sources?.temu_backend || {};
  const incomingBackendRows = Number(data.summary?.temu_backend_rows || 0);
  if (incomingBackendRows > 0 || incomingBackendSource.file || incomingBackendSource.type) {
    return data;
  }

  const backendRows = await loadTemuBackendProducts(connection);
  if (!backendRows.length) return data;

  const updatedAt = backendRows
    .map(item => item.uploadedAt)
    .filter(Boolean)
    .sort()
    .pop() || new Date().toISOString();
  return buildPriceDataFromBackendAndOfficialRowsAsync(
    backendRows.map(item => item.row),
    [],
    {
      backendSource: {
        type: 'upload_db',
        row_count: backendRows.length,
        updated_at: updatedAt
      },
      officialSource: data.sources?.temu_official || {
        type: 'pending_upload_db_merge',
        row_count: 0,
        updated_at: updatedAt
      }
    }
  );
}

async function saveDashboardSnapshot(data) {
  if (!data || !data.mode) throw new Error('Invalid dashboard data: missing mode');

  const pool = getPool();
  importTrace(`${data.mode}: init schema`);
  await initDashboardSchema(pool);
  importTrace(`${data.mode}: get connection`);
  const connection = await pool.getConnection();
  importTrace(`${data.mode}: merge persisted backend products`);
  const dataWithBackend = await mergePersistedTemuBackendProducts(data, connection);
  importTrace(`${dataWithBackend.mode}: merge persisted official products`);
  const dataToSave = await mergePersistedTemuOfficialProducts(dataWithBackend, connection);
  const mode = String(dataToSave.mode);
  importTrace(`${mode}: filter rows`);
  const rowInput = filterRowsBeforeInsert(dataToSave.rows);
  const rows = rowInput.rows;
  const generatedAt = dataToSave.generated_at || new Date().toISOString();
  const summary = {
    ...(dataToSave.summary || {}),
    db_import_raw_rows: Array.isArray(dataToSave.rows) ? dataToSave.rows.length : 0,
    db_import_excluded_void_status_rows: rowInput.excludedVoidStatusRows
  };

  try {
    importTrace(`${mode}: begin transaction, rows=${rows.length}`);
    await connection.beginTransaction();

    importTrace(`${mode}: insert sync run`);
    const [syncRunResult] = await connection.execute(
      'INSERT INTO sync_runs (source, status, row_count, message, summary_json) VALUES (?, ?, ?, ?, ?)',
      [`dashboard:${mode}`, 'running', rows.length, 'import started', JSON.stringify(summary)]
    );
    const syncRunId = syncRunResult.insertId;

    importTrace(`${mode}: insert snapshot`);
    const [snapshotResult] = await connection.execute(
      `INSERT INTO dashboard_snapshots
       (mode, generated_at, summary_json, sources_json, row_count)
       VALUES (?, ?, ?, ?, ?)`,
      [
        mode,
        generatedAt,
        JSON.stringify(summary),
        JSON.stringify(dataToSave.sources || {}),
        rows.length
      ]
    );
    const snapshotId = snapshotResult.insertId;

    importTrace(`${mode}: insert rows`);
    if (rows.length) await insertRows(connection, snapshotId, mode, rows);

    importTrace(`${mode}: delete old snapshots`);
    await connection.execute('DELETE FROM dashboard_snapshots WHERE mode = ? AND id <> ?', [mode, snapshotId]);
    importTrace(`${mode}: update sync run`);
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

    importTrace(`${mode}: commit`);
    await connection.commit();
    importTrace(`${mode}: committed snapshot ${snapshotId}`);
    return { snapshotId, mode, rowCount: rows.length, generatedAt };
  } catch (error) {
    importTrace(`${mode}: rollback after error`);
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function loadRawDashboardSnapshot(mode) {
  const normalizedMode = text(mode) || 'price';
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
    [normalizedMode]
  );

  if (!snapshots.length) {
    const error = new Error(`数据库暂无 ${normalizedMode} 看板数据，请先在本机运行领星采集入库`);
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
    manual_pending_rows: rows.filter(row => row.manualProcessStatus === '未完成').length,
    manual_done_rows: rows.filter(row => row.manualProcessStatus === '已完成').length,
    manual_abandoned_rows: rows.filter(row => row.manualProcessStatus === '已下架').length
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
  const valid = actions.filter(Boolean).map(action => ({
    ...action,
    status: normalizeSavedRowActionStatus(action.status)
  }));
  return valid.find(action => action.status === '已下架' && text(action.note)) ||
    valid.find(action => action.status === '已下架') ||
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
    const status = normalizeSavedRowActionStatus(action?.status);
    const manualOwnerName = text(action?.manualOwnerName);
    if (!key || (!status && !manualOwnerName)) continue;
    const existing = bestByKey.get(key);
    if (!existing ||
      (existing.status !== '已下架' && status === '已下架') ||
      (!FINAL_ROW_ACTION_STATUSES.has(existing.status) && status === '已完成') ||
      (!text(existing.manualOwnerName) && manualOwnerName)
    ) {
      bestByKey.set(key, {
        rowKey: key,
        status: status || '未完成',
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
         status = IF(status IN ('已完成', '已下架', '弃用'), status, VALUES(status)),
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
    return Boolean(action && action !== '正常' && action !== '仓库地区待确认');
  }
  if (mode === 'price') {
    return row.priceOver20 === '是' || row.priceAlert === '前端超价20%';
  }
  return false;
}

function withManualActionStatus(mode, row, savedAction, notes = []) {
  const actionable = isManualActionable(mode, row);
  const savedStatus = normalizeSavedRowActionStatus(savedAction?.status);
  const manualProcessStatus = ROW_ACTION_STATUSES.includes(savedStatus) && (actionable || savedStatus !== '未完成')
    ? savedStatus
    : actionable ? '未完成' : '无需处理';
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
    manualActionable: (actionable || FINAL_ROW_ACTION_STATUSES.has(manualProcessStatus)) ? '是' : '否',
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
  const normalizedStatus = normalizeSavedRowActionStatus(status);
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
       VALUES (?, ?, '未完成', ?, ?, ?, CURRENT_TIMESTAMP(3))
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
         VALUES (?, ?, '未完成', ?, ?, ?, CURRENT_TIMESTAMP(3))
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
         VALUES (?, ?, '未完成', ?, ?)
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
       VALUES (?, ?, '未完成', ?, ?)
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
  loadRawDashboardSnapshot,
  loginOperator,
  loadDashboardSnapshot,
  disableOperatorsExcept,
  logOperation,
  loadTemuBackendProducts,
  mergeTemuBackendProducts,
  mergeTemuOfficialProducts,
  mergeTemuOfficialProductRows,
  provisionOperator,
  registerOperator,
  resolveOperator,
  rowKey,
  replaceTemuOfficialProducts,
  saveDashboardSnapshot,
  setBulkRowActionNote,
  setBulkRowActionOwner,
  setBulkRowActionStatus,
  setRowActionOwner,
  setRowActionNote,
  setRowActionStatus,
  updateRowActionNote
};
