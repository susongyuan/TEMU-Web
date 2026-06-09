const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { ensureEnvLoaded } = require('./env');
const { loadDashboardSnapshot, listSnapshotStatus, setRowActionStatus } = require('./snapshot-store');

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

const app = express();
let lingxingRefreshProcess = null;
let inventoryRefreshProcess = null;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

async function getDashboardData(mode) {
  if (DATA_SOURCE === 'file') {
    const { loadDashboardData } = require('./data-loader');
    return loadDashboardData(mode);
  }
  return loadDashboardSnapshot(mode);
}

function sendDashboardData(res, data) {
  res.json({
    data: data.rows,
    meta: data.summary,
    sources: data.sources,
    generated_at: data.generated_at,
    mode: data.mode
  });
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
    sendDashboardData(res, await getDashboardData('price'));
  } catch (error) {
    sendLoadError(res, error);
  }
});

app.get('/api/price-products', async (req, res) => {
  try {
    sendDashboardData(res, await getDashboardData('price'));
  } catch (error) {
    sendLoadError(res, error);
  }
});

app.get('/api/inventory-products', async (req, res) => {
  try {
    sendDashboardData(res, await getDashboardData('inventory'));
  } catch (error) {
    sendLoadError(res, error);
  }
});

app.get('/api/sources', async (req, res) => {
  try {
    const data = await getDashboardData(req.query.mode === 'inventory' ? 'inventory' : 'price');
    res.json({ data: data.sources, meta: data.summary, generated_at: data.generated_at });
  } catch (error) {
    sendLoadError(res, error);
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
  });

  res.json({ data: { started: true, runner: WAREHOUSE_RUNNER } });
});

app.post('/api/action-status', async (req, res) => {
  try {
    const result = await setRowActionStatus({
      mode: req.body?.mode,
      rowKey: req.body?.rowKey,
      status: req.body?.status
    });
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

app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`TEMU dashboard: http://${HOST}:${PORT}`);
  console.log(`DATA_SOURCE=${DATA_SOURCE}; ENABLE_LOCAL_REFRESH=${ENABLE_LOCAL_REFRESH}`);
});
