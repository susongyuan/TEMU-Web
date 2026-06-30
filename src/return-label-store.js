const { getPool } = require('./db');
const { initDashboardSchema } = require('./schema');
const { resolveOperator } = require('./snapshot-store');

function text(value) {
  return String(value || '').trim();
}

function normalizePayload(body = {}) {
  return {
    externalId: text(body.externalId || body.external_id),
    orderNo: text(body.orderNo || body.order_no),
    trackingNo: text(body.trackingNo || body.tracking_no),
    platform: text(body.platform),
    storeName: text(body.storeName || body.store_name),
    status: text(body.status) || 'pending',
    message: text(body.message),
    requestJson: body.requestJson ?? body.request_json ?? null,
    responseJson: body.responseJson ?? body.response_json ?? null
  };
}

async function appendReturnLabelHistory({ body = {}, operator = {} } = {}) {
  const pool = getPool();
  await initDashboardSchema(pool);
  const resolvedOperator = await resolveOperator(pool, operator);
  const payload = normalizePayload(body);
  const [result] = await pool.execute(
    `INSERT INTO return_label_history (
      external_id, order_no, tracking_no, platform, store_name,
      status, message, request_json, response_json,
      operator_key, operator_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.externalId || null,
      payload.orderNo || null,
      payload.trackingNo || null,
      payload.platform || null,
      payload.storeName || null,
      payload.status,
      payload.message || null,
      payload.requestJson ? JSON.stringify(payload.requestJson) : null,
      payload.responseJson ? JSON.stringify(payload.responseJson) : null,
      resolvedOperator.operatorKey || null,
      resolvedOperator.operatorName || null
    ]
  );

  return {
    id: result.insertId,
    ...payload,
    operatorKey: resolvedOperator.operatorKey || null,
    operatorName: resolvedOperator.operatorName || null
  };
}

async function listReturnLabelHistory(options = {}) {
  const pool = getPool();
  await initDashboardSchema(pool);
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const [rows] = await pool.execute(
    `SELECT id, external_id AS externalId, order_no AS orderNo, tracking_no AS trackingNo,
      platform, store_name AS storeName, status, message,
      CAST(request_json AS CHAR) AS requestJson,
      CAST(response_json AS CHAR) AS responseJson,
      operator_key AS operatorKey, operator_name AS operatorName,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS createdAt
     FROM return_label_history
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`
  );
  return rows;
}

module.exports = {
  appendReturnLabelHistory,
  listReturnLabelHistory
};
