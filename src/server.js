const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const express = require('express');
const compression = require('compression');
const XLSX = require('xlsx');
const { getPool } = require('./db');
const { ensureEnvLoaded } = require('./env');
const {
  buildSkuOwnerIndexFromFile,
  csvParse,
  fileInfo,
  mergeOfficialRowsIntoPriceSnapshot,
  ownerMatchForSkuValues
} = require('./data-loader');
const {
  deleteRowActionNote,
  loadRawDashboardSnapshot,
  loadDashboardSnapshot,
  listOperationLogs,
  listSnapshotStatus,
  logOperation,
  loginOperator,
  resolveOperator,
  saveDashboardSnapshot,
  setBulkRowActionNote,
  setBulkRowActionOwner,
  setBulkRowActionStatus,
  setRowActionNote,
  setRowActionOwner,
  setRowActionStatus,
  updateRowActionNote
} = require('./snapshot-store');
const {
  appendReturnLabelHistory,
  listReturnLabelHistory
} = require('./return-label-store');

ensureEnvLoaded();

const PORT = Number(process.env.DASHBOARD_PORT || 3106);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const MODULE_DIR = path.resolve(__dirname, '..');
const APP_DIR = path.resolve(MODULE_DIR, '..', '..');
const PUBLIC_DIR = path.join(MODULE_DIR, 'public');
const DATA_DIR = path.join(MODULE_DIR, 'data');
const LINGXING_RUNNER = path.join(APP_DIR, 'modules', 'lingxing-temu-crawler', 'scripts', 'run_lingxing_fetch.ps1');
const WAREHOUSE_RUNNER = path.join(APP_DIR, 'modules', 'warehouse-inventory-monitor', 'scripts', 'run_inventory_refresh.ps1');
const DATA_SOURCE = String(process.env.DATA_SOURCE || 'db').toLowerCase();
const ENABLE_LOCAL_REFRESH = String(process.env.ENABLE_LOCAL_REFRESH || 'false').toLowerCase() === 'true';
const DASHBOARD_CACHE_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS || 4 * 60 * 60 * 1000);
const RETURN_LABEL_APP_URL = process.env.RETURN_LABEL_APP_URL || 'http://127.0.0.1:3206';
const SKU_OWNER_UPLOAD_DIR = path.join(APP_DIR, 'input');
const SKU_OWNER_UPLOAD_LIMIT = process.env.SKU_OWNER_UPLOAD_LIMIT || '10mb';
const OFFICIAL_PRODUCTS_UPLOAD_LIMIT = process.env.TEMU_OFFICIAL_UPLOAD_LIMIT || process.env.OFFICIAL_PRODUCTS_UPLOAD_LIMIT || '20mb';
const OFFICIAL_PRODUCTS_UPLOAD_TOKEN = process.env.TEMU_OFFICIAL_UPLOAD_TOKEN || process.env.OFFICIAL_PRODUCTS_UPLOAD_TOKEN || '';
const OFFICIAL_PRODUCTS_FILE = path.join(DATA_DIR, 'temu_official_products.csv');

const app = express();
let lingxingRefreshProcess = null;
let inventoryRefreshProcess = null;
const dashboardCache = new Map();

app.use(compression());
app.use(express.static(PUBLIC_DIR));
app.post(
  '/api/temu-official-products/upload',
  express.raw({
    type: [
      'application/json',
      'application/octet-stream',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/plain'
    ],
    limit: OFFICIAL_PRODUCTS_UPLOAD_LIMIT
  }),
  async (req, res) => {
    try {
      const operator = await resolveOfficialUploadOperator(req);
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!buffer.length) throw new Error('上传内容不能为空');

      const originalName = firstUploadedFileName(req) || 'temu_official_products.csv';
      const parsed = parseOfficialProductsUpload(buffer, originalName, String(req.headers['content-type'] || ''));
      const savedFile = saveOfficialProductsUpload(parsed.rows);
      const currentSnapshot = await loadRawDashboardSnapshot('price');
      const data = mergeOfficialRowsIntoPriceSnapshot(currentSnapshot, parsed.rows);
      const snapshot = await saveDashboardSnapshot(data);
      invalidateDashboardCache('price');

      await logOperation(getPool(), {
        mode: 'price',
        actionType: 'temu_official_products_upload',
        operator,
        targetType: 'temu_official_products',
        targetId: path.basename(savedFile),
        after: {
          file: savedFile,
          uploadedRows: parsed.rowCount,
          snapshotRows: snapshot.rowCount
        },
        detail: {
          originalName,
          savedFile: path.basename(savedFile),
          rowCount: parsed.rowCount,
          sheetNames: parsed.sheetNames,
          columns: parsed.columns,
          snapshot
        }
      });

      res.json({
        data: {
          uploaded: true,
          fileName: path.basename(savedFile),
          rowCount: parsed.rowCount,
          columns: parsed.columns,
          sheetNames: parsed.sheetNames,
          snapshot,
          operator
        }
      });
    } catch (error) {
      const unauthorized = /登录|账号|token|授权|TOKEN/i.test(error.message);
      const validationError = /上传|文件|表头|数据|格式|只支持|不能为空/i.test(error.message);
      res.status(unauthorized ? 401 : validationError ? 400 : 500).json({
        error: {
          code: unauthorized ? 'UNAUTHORIZED' : 'TEMU_OFFICIAL_PRODUCTS_UPLOAD_FAILED',
          message: error.message
        }
      });
    }
  }
);
app.use(express.json({ limit: '1mb' }));

async function getDashboardData(mode) {
  if (DATA_SOURCE === 'file') {
    const { loadDashboardData } = require('./data-loader');
    return loadDashboardData(mode);
  }
  return loadDashboardSnapshot(mode);
}

async function dashboardCacheMarker(mode) {
  if (DATA_SOURCE !== 'db') return '';
  const snapshots = await listSnapshotStatus();
  const snapshot = snapshots.find(item => item.mode === mode);
  if (!snapshot) return '';
  return [snapshot.generated_at, snapshot.row_count, snapshot.created_at].map(value => String(value || '')).join('|');
}

function buildDashboardPayload(data) {
  return {
    data: data.rows,
    meta: data.summary,
    sources: data.sources,
    generated_at: data.generated_at,
    mode: data.mode
  };
}

function encodeDashboardPayload(payload) {
  const json = JSON.stringify(payload);
  return {
    payload,
    json,
    gzip: zlib.gzipSync(json)
  };
}

async function getDashboardPayload(mode) {
  const marker = await dashboardCacheMarker(mode);
  const cached = dashboardCache.get(mode);
  if (cached && cached.expiresAt > Date.now() && (!marker || cached.marker === marker)) return cached;

  const encoded = encodeDashboardPayload(buildDashboardPayload(await getDashboardData(mode)));
  const entry = {
    expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS,
    marker,
    ...encoded
  };
  dashboardCache.set(mode, entry);
  return entry;
}

function invalidateDashboardCache(mode) {
  if (mode) dashboardCache.delete(mode);
  else dashboardCache.clear();
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

function sendDashboardPayload(req, res, entry) {
  res.type('application/json');
  if (acceptsGzip(req)) {
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    res.send(entry.gzip);
    return;
  }
  res.send(entry.json);
}

async function warmDashboardCache() {
  for (const mode of ['price', 'inventory']) {
    try {
      const entry = await getDashboardPayload(mode);
      console.log(`Cache warmed: ${mode}, rows=${entry.payload.data.length}`);
    } catch (error) {
      console.warn(`Cache warm skipped: ${mode}: ${error.message}`);
    }
  }
}

function sendLoadError(res, error) {
  const status = error.code === 'NO_DASHBOARD_SNAPSHOT' ? 404 : 500;
  res.status(status).json({
    error: {
      code: error.code || 'DATA_LOAD_FAILED',
      message: error.message
    }
  });
}

app.get('/api/health', async (req, res) => {
  try {
    const snapshots = DATA_SOURCE === 'db' ? await listSnapshotStatus() : [];
    res.json({
      ok: true,
      time: new Date().toISOString(),
      data_source: DATA_SOURCE,
      refresh_enabled: ENABLE_LOCAL_REFRESH,
      snapshots
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: { code: 'HEALTH_CHECK_FAILED', message: error.message } });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    sendDashboardPayload(req, res, await getDashboardPayload('price'));
  } catch (error) {
    sendLoadError(res, error);
  }
});

app.get('/api/price-products', async (req, res) => {
  try {
    sendDashboardPayload(req, res, await getDashboardPayload('price'));
  } catch (error) {
    sendLoadError(res, error);
  }
});

app.get('/api/inventory-products', async (req, res) => {
  try {
    sendDashboardPayload(req, res, await getDashboardPayload('inventory'));
  } catch (error) {
    sendLoadError(res, error);
  }
});

app.get('/api/sources', async (req, res) => {
  try {
    const entry = await getDashboardPayload(req.query.mode === 'inventory' ? 'inventory' : 'price');
    const payload = entry.payload;
    res.json({ data: payload.sources, meta: payload.meta, generated_at: payload.generated_at });
  } catch (error) {
    sendLoadError(res, error);
  }
});

function normalizeUploadHeader(value) {
  return String(value || '').toLowerCase().replace(/[^\p{Letter}\p{Number}\u4e00-\u9fa5]+/gu, '');
}

function firstUploadedFileName(req) {
  const raw =
    req.headers['x-upload-filename'] ||
    req.headers['x-file-name'] ||
    req.query.filename ||
    '';
  try {
    return path.basename(decodeURIComponent(String(raw || '')));
  } catch {
    return path.basename(String(raw || ''));
  }
}

function authorizationBearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

async function resolveOfficialUploadOperator(req) {
  const bearer = authorizationBearer(req);
  const uploadToken = String(OFFICIAL_PRODUCTS_UPLOAD_TOKEN || '').trim();
  if (uploadToken && bearer && bearer === uploadToken) {
    return {
      operatorKey: 'api-temu-official-upload',
      operatorName: 'API上传'
    };
  }
  return resolveOperator(getPool(), operatorFromRequest(req));
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function rowsFromJsonUpload(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(buffer.toString('utf8')));
  } catch (error) {
    throw new Error(`JSON解析失败：${error.message}`);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed.products)
        ? parsed.products
        : Array.isArray(parsed.listings)
          ? parsed.listings
          : [];
  if (!rows.length) throw new Error('JSON需要是数组，或包含 rows/products/listings 数组');
  return rows.map(row => row && typeof row === 'object' ? row : { value: row });
}

function rowsFromWorkbookUpload(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (error) {
    throw new Error(`Excel读取失败：${error.message}`);
  }
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
    for (const row of sheetRows) rows.push({ ...row, __sheet: sheetName });
  }
  if (!rows.length) throw new Error('Excel没有数据行');
  return { rows, sheetNames: workbook.SheetNames };
}

function normalizeOfficialUploadRows(rows) {
  return rows
    .filter(row => row && typeof row === 'object')
    .map(row => {
      const out = {};
      for (const [key, value] of Object.entries(row)) {
        if (String(key || '').startsWith('__')) continue;
        out[String(key || '').trim()] = value === null || value === undefined ? '' : value;
      }
      return out;
    })
    .filter(row => Object.values(row).some(value => String(value || '').trim()));
}

function uploadColumnSet(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!column || seen.has(column)) continue;
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}

function validateOfficialUploadRows(rows) {
  if (!rows.length) throw new Error('上传文件没有可用数据行');
  const columns = uploadColumnSet(rows);
  const normalized = columns.map(normalizeUploadHeader);
  const hasIdentity = normalized.some(header => [
    '标题',
    '商品标题',
    'title',
    'producttitle',
    'productname',
    'listingtitle',
    'sku',
    'sku货号',
    'skucode',
    'sellersku',
    '商品id',
    'goodsid',
    'productid'
  ].includes(header));
  const hasPrice = normalized.some(header => [
    'temu价格',
    '官方价格',
    '价格',
    'price',
    'saleprice',
    'sellingprice',
    'frontendprice'
  ].includes(header));
  if (!hasIdentity) throw new Error('前端价格表需要包含标题、SKU货号或商品ID列');
  if (!hasPrice) throw new Error('前端价格表需要包含价格列，例如 TEMU价格/官方价格/price');
  return columns;
}

function parseOfficialProductsUpload(buffer, fileName, contentType) {
  const ext = path.extname(fileName || '').toLowerCase();
  const lowerContentType = String(contentType || '').toLowerCase();
  let rows = [];
  let sheetNames = [];

  if (ext === '.json' || lowerContentType.includes('application/json')) {
    rows = rowsFromJsonUpload(buffer);
  } else if (['.xlsx', '.xls'].includes(ext) || lowerContentType.includes('spreadsheet') || lowerContentType.includes('ms-excel')) {
    const workbook = rowsFromWorkbookUpload(buffer);
    rows = workbook.rows;
    sheetNames = workbook.sheetNames;
  } else if (ext === '.csv' || lowerContentType.includes('csv') || lowerContentType.includes('text/plain')) {
    rows = csvParse(stripBom(buffer.toString('utf8')));
  } else {
    throw new Error('只支持上传 .csv、.xlsx、.xls、.json 文件；API上传请带 X-Upload-Filename');
  }

  const normalizedRows = normalizeOfficialUploadRows(rows);
  const columns = validateOfficialUploadRows(normalizedRows);
  return {
    rows: normalizedRows,
    rowCount: normalizedRows.length,
    columns,
    sheetNames
  };
}

function csvEscape(value) {
  const str = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function officialRowsToCsv(rows) {
  const columns = uploadColumnSet(rows);
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map(column => csvEscape(row[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

function saveOfficialProductsUpload(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OFFICIAL_PRODUCTS_FILE, officialRowsToCsv(rows), 'utf8');
  return OFFICIAL_PRODUCTS_FILE;
}

function inspectSkuOwnerWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (error) {
    throw new Error(`Excel读取失败：${error.message}`);
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel没有可读取的工作表');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!rows.length) throw new Error('Excel没有数据行');

  const headers = Object.keys(rows[0] || {}).map(normalizeUploadHeader);
  const skuHeaders = [
    '平台sku',
    '平台商品sku',
    'sellersku',
    '主sku',
    'mainsku',
    'sku',
    '系统sku',
    '产品代码',
    '仓库产品代码'
  ];
  const ownerHeaders = ['负责人', '销售负责人', '运营', '运营负责人'];
  const hasSku = headers.some(header => skuHeaders.includes(header));
  const hasOwner = headers.some(header => ownerHeaders.includes(header));
  if (!hasSku || !hasOwner) throw new Error('Excel表头需要包含SKU列和负责人/运营列');

  return {
    sheetName,
    rowCount: rows.length,
    columns: Object.keys(rows[0] || {})
  };
}

function saveSkuOwnerUpload(buffer) {
  fs.mkdirSync(SKU_OWNER_UPLOAD_DIR, { recursive: true });
  const fileName = 'SKU-运营映射表.xlsx';
  const file = path.join(SKU_OWNER_UPLOAD_DIR, fileName);
  fs.writeFileSync(file, buffer);
  return file;
}

function ownerMatchForSnapshotRow(mode, row, ownerIndex) {
  if (mode === 'inventory') {
    return ownerMatchForSkuValues(
      [row.skuCode, row.listingSkuCodes, row.listingStockedSkuCodes, row.listingSkuInventory, row.listingSkuDetails],
      ownerIndex,
      [row.skuName, row.title, row.listingSkuDetails],
      row
    );
  }
  return ownerMatchForSkuValues(
    [row.skuCode],
    ownerIndex,
    [row.skuName, row.title, row.officialTitle],
    row
  );
}

function applyOwnerMappingToRows(mode, rows, ownerIndex) {
  return rows.map(row => {
    const ownerMatch = ownerMatchForSnapshotRow(mode, row, ownerIndex);
    return {
      ...row,
      owner: ownerMatch.owner,
      ownerStatus: ownerMatch.ownerStatus,
      ownerMatchType: ownerMatch.ownerMatchType,
      ownerMatchScore: ownerMatch.ownerMatchScore,
      ownerMatchText: ownerMatch.ownerMatchText
    };
  });
}

async function rebuildSnapshotsWithOwnerMapping(mappingFile, workbookInfo) {
  if (DATA_SOURCE !== 'db') {
    invalidateDashboardCache();
    return [];
  }

  const ownerIndex = buildSkuOwnerIndexFromFile(mappingFile);
  const generatedAt = new Date().toISOString();
  const results = [];
  for (const mode of ['price', 'inventory']) {
    try {
      const snapshot = await loadRawDashboardSnapshot(mode);
      const rows = applyOwnerMappingToRows(mode, snapshot.rows, ownerIndex);
      const result = await saveDashboardSnapshot({
        ...snapshot,
        generated_at: generatedAt,
        sources: {
          ...snapshot.sources,
          sku_owner_mapping: fileInfo(mappingFile)
        },
        summary: {
          ...snapshot.summary,
          sku_owner_mapping_rows: workbookInfo.rowCount,
          sku_owner_mapping_sheet: workbookInfo.sheetName,
          sku_owner_mapping_uploaded_at: generatedAt
        },
        rows
      });
      results.push(result);
    } catch (error) {
      if (error.code !== 'NO_DASHBOARD_SNAPSHOT') throw error;
      results.push({ mode, skipped: true, message: error.message });
    }
  }
  invalidateDashboardCache();
  return results;
}

app.post(
  '/api/sku-owner-mapping/upload',
  express.raw({
    type: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream'
    ],
    limit: SKU_OWNER_UPLOAD_LIMIT
  }),
  async (req, res) => {
    try {
      const operator = await resolveOperator(getPool(), operatorFromRequest(req));
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!buffer.length) throw new Error('请选择要上传的Excel文件');

      const originalName = firstUploadedFileName(req);
      const ext = path.extname(originalName).toLowerCase();
      if (ext && ext !== '.xlsx') throw new Error('目前只支持上传 .xlsx 文件');

      const workbookInfo = inspectSkuOwnerWorkbook(buffer);
      const savedFile = saveSkuOwnerUpload(buffer);
      const snapshots = await rebuildSnapshotsWithOwnerMapping(savedFile, workbookInfo);

      await logOperation(getPool(), {
        actionType: 'sku_owner_mapping_upload',
        operator,
        targetType: 'sku_owner_mapping',
        targetId: path.basename(savedFile),
        after: {
          file: savedFile,
          rowCount: workbookInfo.rowCount,
          sheetName: workbookInfo.sheetName
        },
        detail: {
          originalName,
          savedFile: path.basename(savedFile),
          rowCount: workbookInfo.rowCount,
          sheetName: workbookInfo.sheetName,
          snapshots
        }
      });

      res.json({
        data: {
          uploaded: true,
          fileName: path.basename(savedFile),
          rowCount: workbookInfo.rowCount,
          sheetName: workbookInfo.sheetName,
          snapshots,
          operator
        }
      });
    } catch (error) {
      const unauthorized = /登录|账号|token/i.test(error.message);
      const validationError = /请选择|Excel|表头|数据行|只支持/i.test(error.message);
      res.status(unauthorized ? 401 : validationError ? 400 : 500).json({
        error: {
          code: unauthorized ? 'UNAUTHORIZED' : 'SKU_OWNER_MAPPING_UPLOAD_FAILED',
          message: error.message
        }
      });
    }
  }
);

function operatorFromRequest(req) {
  const authorization = String(req.headers.authorization || '');
  return {
    authToken:
      req.query.authToken ||
      req.query.token ||
      req.headers['x-auth-token'] ||
      authorization.replace(/^Bearer\s+/i, ''),
    operatorKey: req.query.operatorKey,
    operatorName: req.query.operatorName
  };
}

app.get('/api/operation-logs', async (req, res) => {
  try {
    await resolveOperator(getPool(), operatorFromRequest(req));
    const logs = await listOperationLogs({
      limit: req.query.limit,
      mode: req.query.mode,
      operatorName: req.query.operatorName,
      actionType: req.query.actionType,
      keyword: req.query.keyword
    });
    res.json({ data: logs });
  } catch (error) {
    res.status(/登录|账号|token/i.test(error.message) ? 401 : 500).json({
      error: {
        code: 'OPERATION_LOGS_LOAD_FAILED',
        message: error.message
      }
    });
  }
});

function operatorFromBody(body = {}) {
  return {
    authToken: body.authToken || body.token,
    operatorKey: body.operatorKey,
    operatorName: body.operatorName
  };
}

app.post('/api/operators/register', async (req, res) => {
  res.status(403).json({
    error: {
      code: 'OPERATOR_REGISTER_DISABLED',
      message: '账号由管理员统一创建，请使用分配的账号密码登录'
    }
  });
});

app.post('/api/operators/login', async (req, res) => {
  try {
    const operator = await loginOperator({
      operatorName: req.body?.operatorName || req.body?.username || req.body?.name,
      password: req.body?.password
    });
    res.json({ data: operator });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'OPERATOR_LOGIN_FAILED',
        message: error.message
      }
    });
  }
});

app.get('/api/return-label/interface', async (req, res) => {
  res.json({
    data: {
      module: 'return-label',
      status: 'available',
      appUrl: RETURN_LABEL_APP_URL,
      endpoints: [
        { method: 'GET', path: '/api/return-label/open' },
        { method: 'GET', path: '/api/return-label/history' },
        { method: 'POST', path: '/api/return-label/history' }
      ],
      historyTable: 'return_label_history'
    }
  });
});

app.get('/api/return-label/open', (req, res) => {
  res.redirect(302, RETURN_LABEL_APP_URL);
});

app.get('/api/return-label/history', async (req, res) => {
  try {
    await resolveOperator(getPool(), operatorFromRequest(req));
    const history = await listReturnLabelHistory({ limit: req.query.limit });
    res.json({ data: history });
  } catch (error) {
    res.status(/登录|账号|token/i.test(error.message) ? 401 : 500).json({
      error: {
        code: 'RETURN_LABEL_HISTORY_LOAD_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/return-label/history', async (req, res) => {
  try {
    const result = await appendReturnLabelHistory({
      body: req.body,
      operator: operatorFromBody(req.body)
    });
    res.json({ data: result });
  } catch (error) {
    res.status(/登录|账号|token/i.test(error.message) ? 401 : 400).json({
      error: {
        code: 'RETURN_LABEL_HISTORY_APPEND_FAILED',
        message: error.message
      }
    });
  }
});

function rejectLocalRefresh(res) {
  res.status(403).json({
    error: {
      code: 'LOCAL_REFRESH_DISABLED',
      message: '服务器看板不执行爬虫。请在本机运行领星定时采集，采集完成后会写入数据库。'
    }
  });
}

app.post('/api/refresh/lingxing', async (req, res) => {
  try {
    await resolveOperator(getPool(), operatorFromBody(req.body));
    if (!ENABLE_LOCAL_REFRESH) {
      rejectLocalRefresh(res);
      return;
    }
    if (lingxingRefreshProcess) {
      res.status(409).json({ error: { code: 'REFRESH_RUNNING', message: '领星刷新正在执行' } });
      return;
    }

    lingxingRefreshProcess = spawn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', LINGXING_RUNNER],
      { cwd: path.dirname(LINGXING_RUNNER), windowsHide: true }
    );

    lingxingRefreshProcess.on('exit', () => {
      lingxingRefreshProcess = null;
      invalidateDashboardCache();
    });

    res.json({ data: { started: true, runner: LINGXING_RUNNER } });
  } catch (error) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: error.message } });
  }
});

app.post('/api/refresh/inventory', async (req, res) => {
  try {
    await resolveOperator(getPool(), operatorFromBody(req.body));
    if (!ENABLE_LOCAL_REFRESH) {
      rejectLocalRefresh(res);
      return;
    }
    if (inventoryRefreshProcess) {
      res.status(409).json({ error: { code: 'REFRESH_RUNNING', message: '库存刷新正在执行' } });
      return;
    }

    inventoryRefreshProcess = spawn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', WAREHOUSE_RUNNER],
      { cwd: path.dirname(WAREHOUSE_RUNNER), windowsHide: true }
    );

    inventoryRefreshProcess.on('exit', () => {
      inventoryRefreshProcess = null;
      invalidateDashboardCache('inventory');
    });

    res.json({ data: { started: true, runner: WAREHOUSE_RUNNER } });
  } catch (error) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: error.message } });
  }
});

app.post('/api/action-status', async (req, res) => {
  try {
    const result = await setRowActionStatus({
      mode: req.body?.mode,
      rowKey: req.body?.rowKey,
      status: req.body?.status,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'ACTION_STATUS_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/action-owner', async (req, res) => {
  try {
    const result = await setRowActionOwner({
      mode: req.body?.mode,
      rowKey: req.body?.rowKey,
      ownerName: req.body?.ownerName,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'ACTION_OWNER_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/action-note', async (req, res) => {
  try {
    const result = await setRowActionNote({
      mode: req.body?.mode,
      rowKey: req.body?.rowKey,
      note: req.body?.note,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'ACTION_NOTE_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/bulk-action-status', async (req, res) => {
  try {
    const result = await setBulkRowActionStatus({
      mode: req.body?.mode,
      rowKeys: req.body?.rowKeys,
      status: req.body?.status,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'BULK_ACTION_STATUS_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/bulk-action-owner', async (req, res) => {
  try {
    const result = await setBulkRowActionOwner({
      mode: req.body?.mode,
      rowKeys: req.body?.rowKeys,
      ownerName: req.body?.ownerName,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'BULK_ACTION_OWNER_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/bulk-action-note', async (req, res) => {
  try {
    const result = await setBulkRowActionNote({
      mode: req.body?.mode,
      rowKeys: req.body?.rowKeys,
      note: req.body?.note,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'BULK_ACTION_NOTE_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.patch('/api/action-note', async (req, res) => {
  try {
    const result = await updateRowActionNote({
      mode: req.body?.mode,
      noteId: req.body?.noteId,
      note: req.body?.note,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'ACTION_NOTE_UPDATE_FAILED',
        message: error.message
      }
    });
  }
});

app.delete('/api/action-note', async (req, res) => {
  try {
    const result = await deleteRowActionNote({
      mode: req.body?.mode,
      noteId: req.body?.noteId,
      operator: operatorFromBody(req.body)
    });
    invalidateDashboardCache(result.mode);
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'ACTION_NOTE_DELETE_FAILED',
        message: error.message
      }
    });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`TEMU dashboard: http://${HOST}:${PORT}`);
  console.log(`DATA_SOURCE=${DATA_SOURCE}; ENABLE_LOCAL_REFRESH=${ENABLE_LOCAL_REFRESH}`);
  warmDashboardCache();
});
