const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const express = require('express');
const compression = require('compression');
const { ensureEnvLoaded } = require('./env');
const {
  deleteRowActionNote,
  loadDashboardSnapshot,
  listOperationLogs,
  listSnapshotStatus,
  loginOperator,
  registerOperator,
  setBulkRowActionNote,
  setBulkRowActionOwner,
  setBulkRowActionStatus,
  setRowActionNote,
  setRowActionOwner,
  setRowActionStatus,
  updateRowActionNote
} = require('./snapshot-store');

ensureEnvLoaded();

const PORT = Number(process.env.DASHBOARD_PORT || 3106);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const MODULE_DIR = path.resolve(__dirname, '..');
const APP_DIR = path.resolve(MODULE_DIR, '..', '..');
const PUBLIC_DIR = path.join(MODULE_DIR, 'public');
const LINGXING_RUNNER = path.join(APP_DIR, 'modules', 'lingxing-temu-crawler', 'scripts', 'run_lingxing_fetch.ps1');
const WAREHOUSE_RUNNER = path.join(APP_DIR, 'modules', 'warehouse-inventory-monitor', 'scripts', 'run_inventory_refresh.ps1');
const DATA_SOURCE = String(process.env.DATA_SOURCE || 'db').toLowerCase();
const ENABLE_LOCAL_REFRESH = String(process.env.ENABLE_LOCAL_REFRESH || 'false').toLowerCase() === 'true';
const DASHBOARD_CACHE_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS || 4 * 60 * 60 * 1000);

const app = express();
let lingxingRefreshProcess = null;
let inventoryRefreshProcess = null;
const dashboardCache = new Map();

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

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

app.get('/api/operation-logs', async (req, res) => {
  try {
    const logs = await listOperationLogs({
      limit: req.query.limit,
      mode: req.query.mode,
      operatorName: req.query.operatorName,
      actionType: req.query.actionType,
      keyword: req.query.keyword
    });
    res.json({ data: logs });
  } catch (error) {
    res.status(500).json({
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
  try {
    const operator = await registerOperator({
      operatorName: req.body?.operatorName || req.body?.username || req.body?.name,
      password: req.body?.password
    });
    res.json({ data: operator });
  } catch (error) {
    res.status(400).json({
      error: {
        code: 'OPERATOR_REGISTER_FAILED',
        message: error.message
      }
    });
  }
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

function rejectLocalRefresh(res) {
  res.status(403).json({
    error: {
      code: 'LOCAL_REFRESH_DISABLED',
      message: '服务器看板不执行爬虫。请在本机运行领星定时采集，采集完成后会写入数据库。'
    }
  });
}

app.post('/api/refresh/lingxing', (req, res) => {
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
});

app.post('/api/refresh/inventory', (req, res) => {
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
