const PAGE = location.pathname.includes('/inventory') ? 'inventory' : 'price';

const state = {
  rows: [],
  filtered: [],
  filters: new Map(),
  health: null
};

const UPDATE_STALE_MS = 5 * 60 * 60 * 1000;

const els = {
  title: document.getElementById('pageTitle'),
  sourceLine: document.getElementById('sourceLine'),
  updateStatus: document.getElementById('updateStatus'),
  metricGrid: document.getElementById('metricGrid'),
  tableHead: document.getElementById('tableHead'),
  tableBody: document.getElementById('tableBody'),
  searchInput: document.getElementById('searchInput'),
  filterGrid: document.getElementById('filterGrid'),
  refreshBtn: document.getElementById('refreshBtn'),
  runFetchBtn: document.getElementById('runFetchBtn'),
  runInventoryBtn: document.getElementById('runInventoryBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearFiltersBtn: document.getElementById('clearFiltersBtn'),
  resultCount: document.getElementById('resultCount'),
  priceNav: document.getElementById('priceNav'),
  inventoryNav: document.getElementById('inventoryNav')
};

const PAGE_CONFIG = {
  price: {
    title: '前后端价格同步',
    api: '/api/price-products',
    exportName: 'TEMU前后端价格同步',
    sourceLine(payload) {
      const meta = payload.meta || {};
      return `领星：${sourceText(payload.sources?.lingxing_price)}；TEMU官方：${sourceText(payload.sources?.temu_official)}；` +
        `合并行：${meta.merged_rows || 0}；超价20%：${meta.price_alert_rows || 0}；页面刷新：${new Date(payload.generated_at).toLocaleString('zh-CN')}`;
    },
    metrics: [
      ['lingxing_rows', '领星行数'],
      ['temu_official_rows', '官方行数'],
      ['matched_rows', '已匹配'],
      ['price_diff_rows', '价格差异', 'danger'],
      ['price_alert_rows', '超价20%', 'danger']
    ],
    filters: [
      { id: 'storeRegion', label: '店铺/区域', kind: 'field' },
      { id: 'owner', label: '负责人', kind: 'splitField' },
      { id: 'ownerStatus', label: '负责人状态', kind: 'fixed', options: ['已匹配负责人', '未匹配负责人'] },
      { id: 'ownerMatchType', label: '负责人匹配', kind: 'fixed', options: ['精确SKU', 'SKU前缀', '产品名', '模糊产品名', '未匹配'] },
      { id: 'storeName', label: '店铺', kind: 'field' },
      { id: 'area', label: '区域', kind: 'field' },
      { id: 'site', label: '站点', kind: 'field' },
      { id: 'matchStatus', label: '匹配状态', kind: 'fixed', options: ['领星未匹配官方', '官方未匹配领星', '标题匹配', 'SKU匹配'] },
      { id: 'priceAlert', label: '价格提醒', kind: 'fixed', options: ['前端超价20%', '价格不一致', '价格一致', '前端缺价', '后台缺价', '官方未匹配领星'] },
      { id: 'referencePriceType', label: '对比价类型', kind: 'fixed', options: ['活动价', '申报价'] },
      { id: 'priceOver20', label: '超价20%', kind: 'fixed', options: ['是', '否'] }
    ],
    columns: [
      ['image', '图片', imageCell],
      ['priceAlert', '价格提醒', priceAlertCell],
      ['priceOver20', '超20%', yesNoCell],
      ['sourceSide', '来源', sourceCell],
      ['platformSpu', '平台SPU'],
      ['skuCode', 'SKU货号'],
      ['skuName', '品名/SKU'],
      ['owner', '负责人'],
      ['ownerStatus', '负责人状态', ownerStatusCell],
      ['ownerMatchText', '匹配方式', ownerMatchCell],
      ['storeRegion', '店铺/区域'],
      ['site', '站点'],
      ['title', '标题', titleCell],
      ['referencePrice', '后台对比价', referencePriceCell],
      ['officialPrice', 'TEMU前端价', officialPriceCell],
      ['priceDiff', '差异'],
      ['priceDiffRate', '差异%'],
      ['matchStatus', '匹配', matchCell],
      ['lingxingDeclarePrice', '申报价'],
      ['lingxingActivityPrice', '活动价'],
      ['mallId', '店铺ID'],
      ['goodsId', '商品ID'],
      ['salesAmount', '销售额'],
      ['orderCount', '订单量'],
      ['volume', '销量']
    ],
    exportHeaders: [
      ['priceAlert', '价格提醒'],
      ['priceOver20', '超价20%'],
      ['sourceSide', '来源'],
      ['platformSpu', '平台SPU'],
      ['skuId', 'SKU ID'],
      ['skcId', 'SKC ID'],
      ['skuCode', 'SKU货号'],
      ['skuName', '品名'],
      ['owner', '负责人'],
      ['ownerStatus', '负责人状态'],
      ['ownerMatchType', '负责人匹配'],
      ['ownerMatchScore', '匹配分数'],
      ['storeName', '店铺'],
      ['area', '区域'],
      ['site', '站点'],
      ['title', '领星标题'],
      ['officialTitle', 'TEMU标题'],
      ['referencePriceType', '对比价类型'],
      ['referencePrice', '后台对比价'],
      ['referenceCurrency', '后台币种'],
      ['officialPrice', 'TEMU前端价'],
      ['officialCurrency', 'TEMU币种'],
      ['priceDiff', '价格差异'],
      ['priceDiffRate', '差异%'],
      ['matchStatus', '匹配状态'],
      ['officialUrl', 'TEMU链接'],
      ['image', '图片']
    ]
  },
  inventory: {
    title: '库存上下架提醒',
    api: '/api/inventory-products',
    exportName: 'TEMU库存上下架提醒',
    sourceLine(payload) {
      const meta = payload.meta || {};
      return `库存文件：${sourceText(payload.sources?.warehouse_inventory)}；领星全状态：${sourceText(payload.sources?.lingxing_inventory)}；` +
        `库存核对行：${meta.inventory_rows || 0}；强提醒：${meta.inventory_alert_rows || 0}；需处理：${meta.action_required_rows || 0}；页面刷新：${new Date(payload.generated_at).toLocaleString('zh-CN')}`;
    },
    metrics: [
      ['inventory_rows', '库存核对行'],
      ['inventory_alert_rows', '强提醒', 'danger'],
      ['action_required_rows', '需处理', 'warn'],
      ['manual_pending_rows', '未处理', 'warn'],
      ['manual_done_rows', '已完成'],
      ['active_listing_no_available_stock_rows', '在卖无可用库存', 'danger'],
      ['no_active_listing_with_stock_rows', '有库存无在卖', 'warn'],
      ['other_region_stock_rows', '其他区域有库存']
    ],
    filters: [
      { id: 'storeRegion', label: '店铺/区域', kind: 'field' },
      { id: 'owner', label: '负责人', kind: 'splitField' },
      { id: 'ownerStatus', label: '负责人状态', kind: 'fixed', options: ['已匹配负责人', '未匹配负责人'] },
      { id: 'ownerMatchType', label: '负责人匹配', kind: 'fixed', options: ['精确SKU', 'SKU前缀', '产品名', '模糊产品名', '未匹配'] },
      { id: 'storeName', label: '店铺', kind: 'field' },
      { id: 'area', label: '区域', kind: 'field' },
      { id: 'site', label: '站点', kind: 'field' },
      { id: 'regionGroup', label: '区域组', kind: 'fixed', options: ['美国/Global', '欧区'] },
      { id: 'status', label: '领星状态', kind: 'field' },
      { id: 'stockAction', label: '处理动作', kind: 'fixed', options: ['有在卖但没可用库存', '有库存但无在卖链接', '库存源异常', '正常'] },
      { id: 'manualProcessStatus', label: '处理状态', kind: 'fixed', options: ['未处理', '已完成', '无需处理'] },
      { id: 'warehouseRegionMatchStatus', label: '仓库地区', kind: 'fixed', options: ['同区匹配', '其他区域有库存', '无库存记录'] },
      { id: 'warehouseSource', label: '仓库来源', kind: 'splitField' }
    ],
    columns: [
      ['image', '图片', imageCell],
      ['storeRegion', '店铺/区域'],
      ['platformSpu', '平台SPU'],
      ['listingStockedSkuCodes', '有库存SKU', skuListCell],
      ['listingSkuCodes', '链接SKU货号', skuListCell],
      ['listingPriceDetails', '申报价/活动价', priceDetailsCell],
      ['skuRegionLingxingStatuses', '链接SKU状态', statusSummaryCell],
      ['stockAction', '处理动作', stockActionCell],
      ['manualProcessStatus', '处理状态', manualProcessStatusCell],
      ['skuName', '品名/SKU'],
      ['owner', '负责人'],
      ['title', '标题', titleCell],
      ['inventoryAlertReason', '提醒原因'],
      ['status', '领星状态', statusCell],
      ['statusCode', '状态码'],
      ['site', '站点'],
      ['regionGroup', '区域组'],
      ['listingSkuCount', '链接SKU数'],
      ['skuRegionActiveListingCount', '已加入SKU'],
      ['skuRegionAvailableQty', '链接同区可用'],
      ['listingSkuInventory', 'SKU库存', multilineCell],
      ['warehouseRegionMatchStatus', '仓库地区'],
      ['siteMatchedAvailableQty', '同区可用'],
      ['otherRegionAvailableQty', '异区可用'],
      ['inStockQty', '同区在库'],
      ['frozenQty', '冻结/待发'],
      ['warehouse', '同区仓库'],
      ['otherRegionWarehouse', '异区仓库'],
      ['inventoryMatchStatus', '仓库匹配'],
      ['ownerStatus', '负责人状态', ownerStatusCell],
      ['ownerMatchText', '匹配方式', ownerMatchCell],
      ['skuRegionAlertRepresentative', '代表行', yesNoCell],
      ['listingSkuDetails', '链接SKU明细', multilineCell],
      ['skuId', 'SKU ID'],
      ['skcId', 'SKC ID']
    ],
    exportHeaders: [
      ['platformSpu', '平台SPU'],
      ['listingSkuCodes', '链接SKU货号'],
      ['skuCode', '代表SKU'],
      ['skuName', '品名/SKU'],
      ['owner', '负责人'],
      ['ownerStatus', '负责人状态'],
      ['ownerMatchType', '负责人匹配'],
      ['ownerMatchScore', '匹配分数'],
      ['title', '标题'],
      ['image', '图片'],
      ['stockAction', '处理动作'],
      ['manualProcessStatus', '处理状态'],
      ['manualActionUpdatedAt', '处理时间'],
      ['inventoryAlertReason', '提醒原因'],
      ['skuRegionAlertRepresentative', '提醒代表行'],
      ['hasInventoryButOffShelf', '有库存但无在卖链接'],
      ['status', '领星状态'],
      ['statusCode', '领星状态码'],
      ['storeName', '店铺'],
      ['area', '区域'],
      ['site', '站点'],
      ['regionGroup', '区域组'],
      ['listingSkuCount', '链接SKU数'],
      ['listingStockedSkuCodes', '有库存SKU'],
      ['listingPriceDetails', '申报价/活动价'],
      ['listingSkuInventory', '链接SKU库存'],
      ['listingSkuDetails', '链接SKU明细'],
      ['skuRegionListingCount', '链接区域行数'],
      ['skuRegionActiveListingCount', '链接已加入站点SKU数'],
      ['skuRegionAvailableQty', '链接同区可用库存'],
      ['skuRegionLingxingStatuses', '链接SKU领星状态'],
      ['warehouseRegionMatchStatus', '仓库地区匹配'],
      ['siteMatchedAvailableQty', '同区可用库存'],
      ['otherRegionAvailableQty', '异区可用库存'],
      ['inStockQty', '同区在库库存'],
      ['frozenQty', '冻结/待发库存'],
      ['warehouseSource', '仓库来源'],
      ['warehouse', '同区仓库'],
      ['otherRegionWarehouse', '异区仓库'],
      ['inventoryMatchStatus', '仓库匹配状态'],
      ['skuId', 'SKU ID'],
      ['skcId', 'SKC ID']
    ]
  }
};

const config = PAGE_CONFIG[PAGE];
const EMPTY_OWNER_FILTER_VALUE = '__EMPTY_OWNER__';
const EMPTY_OWNER_LABEL = '负责人为空';

function text(value) {
  return String(value ?? '').trim();
}

function compactSearchText(value) {
  return text(value).toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function searchTextForRow(row) {
  const fields = [
    'platformSpu',
    'spuId',
    'skcId',
    'skuId',
    'skuCode',
    'listingSkuCodes',
    'listingStockedSkuCodes',
    'listingSkuDetails',
    'skuName',
    'title',
    'officialTitle',
    'owner',
    'ownerStatus',
    'ownerMatchText',
    'storeName',
    'storeRegion',
    'area',
    'site',
    'regionGroup',
    'mallId',
    'goodsId',
    'warehouseSku',
    'warehouse',
    'inventoryAlertReason',
    'manualProcessStatus'
  ];
  const explicitValues = fields.map(field => row[field]);
  const values = [...explicitValues, ...Object.values(row)]
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => text(value))
    .filter(Boolean);
  const plain = values.join(' ').toLowerCase();
  const compact = values.map(compactSearchText).filter(Boolean).join(' ');
  return { plain, compact };
}

function escapeHtml(value) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sourceText(source) {
  if (!source || !source.exists) return '未生成';
  return `${source.file.split(/[\\/]/).pop()}，${new Date(source.updated_at).toLocaleString('zh-CN')}`;
}

function sourceFileName(source) {
  if (!source?.file) return '';
  return source.file.split(/[\\/]/).pop();
}

function formatDateTime(value) {
  if (!value) return '未生成';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间异常';
  return date.toLocaleString('zh-CN');
}

function ageText(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}小时${rest}分钟前` : `${hours}小时前`;
  const days = Math.floor(hours / 24);
  const dayRest = hours % 24;
  return dayRest ? `${days}天${dayRest}小时前` : `${days}天前`;
}

function updateSourceItems(payload) {
  if (PAGE === 'inventory') {
    return [
      { label: '库存核对生成', source: payload.sources?.warehouse_inventory, checkFreshness: true },
      { label: '领星全状态', source: payload.sources?.lingxing_inventory, checkFreshness: true },
      { label: '页面读取', updatedAt: payload.generated_at, checkFreshness: false }
    ];
  }
  return [
    { label: '领星价格数据', source: payload.sources?.lingxing_price, checkFreshness: true },
    { label: 'TEMU官方数据', source: payload.sources?.temu_official, checkFreshness: false },
    { label: '页面读取', updatedAt: payload.generated_at, checkFreshness: false }
  ];
}

function updateItemStatus(item) {
  const updatedAt = item.updatedAt || item.source?.updated_at || '';
  const expectsSource = Object.prototype.hasOwnProperty.call(item, 'source');
  if (expectsSource && (!item.source || !item.source.exists)) {
    return {
      tone: item.checkFreshness ? 'danger' : 'warn',
      updatedAt,
      detail: '文件未生成',
      fileName: sourceFileName(item.source)
    };
  }
  if (item.checkFreshness) {
    if (!updatedAt) {
      return {
        tone: 'danger',
        updatedAt,
        detail: '未读取到更新时间',
        fileName: sourceFileName(item.source)
      };
    }
    const age = Date.now() - new Date(updatedAt).getTime();
    if (!Number.isFinite(age)) {
      return {
        tone: 'danger',
        updatedAt,
        detail: '更新时间异常',
        fileName: sourceFileName(item.source)
      };
    }
    if (age > UPDATE_STALE_MS) {
      return {
        tone: 'warn',
        updatedAt,
        detail: `${ageText(updatedAt)}，可能未更新`,
        fileName: sourceFileName(item.source)
      };
    }
  }
  return {
    tone: 'ok',
    updatedAt,
    detail: ageText(updatedAt) || '正常',
    fileName: sourceFileName(item.source)
  };
}

function renderUpdateStatus(payload) {
  const items = updateSourceItems(payload).map(item => ({ ...item, status: updateItemStatus(item) }));
  const abnormal = items.filter(item => item.checkFreshness && item.status.tone !== 'ok');
  const overviewTone = abnormal.some(item => item.status.tone === 'danger') ? 'danger' : abnormal.length ? 'warn' : 'ok';
  const overviewText = abnormal.length
    ? `更新状态：可能异常，${abnormal.map(item => item.label).join('、')}需检查`
    : '更新状态：正常';
  const chips = items.map(item => `
    <div class="update-chip ${escapeHtml(item.status.tone)}" title="${escapeHtml(item.status.fileName)}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(formatDateTime(item.status.updatedAt))}</strong>
      <em>${escapeHtml(item.status.detail)}</em>
    </div>
  `).join('');

  els.updateStatus.innerHTML = `
    <div class="update-overview ${escapeHtml(overviewTone)}">${escapeHtml(overviewText)}</div>
    <div class="update-chips">${chips}</div>
  `;
}

function splitValues(value) {
  return text(value).split(/[；;,，\n\r]+/).map(item => item.trim()).filter(Boolean);
}

function normalizeOption(option) {
  return Array.isArray(option) ? { value: option[0], label: option[1] } : { value: option, label: option };
}

function valueFor(row, def) {
  if (def.id === 'owner') {
    const values = splitValues(row[def.id]);
    return values.length ? values : [EMPTY_OWNER_FILTER_VALUE];
  }
  if (def.kind === 'splitField') return splitValues(row[def.id]);
  return text(row[def.id]);
}

function optionLabel(def, value) {
  if (def.id === 'owner' && value === EMPTY_OWNER_FILTER_VALUE) return EMPTY_OWNER_LABEL;
  return value;
}

function optionBaseValuesForDef(def, rows) {
  if (def.kind === 'fixed') return (def.options || []).map(normalizeOption);
  const values = new Set();
  for (const row of rows) {
    const value = valueFor(row, def);
    if (Array.isArray(value)) value.forEach(item => values.add(item));
    else if (value) values.add(value);
  }
  return [...values].sort((a, b) => {
    if (a === EMPTY_OWNER_FILTER_VALUE) return -1;
    if (b === EMPTY_OWNER_FILTER_VALUE) return 1;
    return a.localeCompare(b, 'zh-CN');
  }).map(value => ({ value, label: optionLabel(def, value) }));
}

function optionCountsForDef(def, rows) {
  const counts = new Map();
  for (const row of rows) {
    const value = valueFor(row, def);
    if (Array.isArray(value)) {
      value.forEach(item => counts.set(item, (counts.get(item) || 0) + 1));
    } else if (value) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return counts;
}

function optionValuesForDef(def, rows, countRows = rows) {
  const counts = optionCountsForDef(def, countRows);
  return optionBaseValuesForDef(def, rows).map(option => ({
    ...option,
    count: counts.get(option.value) || 0
  }));
}

function selectedSet(id) {
  if (!state.filters.has(id)) state.filters.set(id, new Set());
  return state.filters.get(id);
}

function selectedLabel(def, options) {
  const selected = selectedSet(def.id);
  if (!selected.size) return '全部';
  if (selected.size === 1) {
    const value = [...selected][0];
    return options.find(option => text(option.value) === value)?.label || value;
  }
  return `已选 ${selected.size} 项`;
}

function rowMatchesKeyword(row, keyword) {
  if (!keyword) return true;
  const tokens = text(keyword).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const searchable = searchTextForRow(row);
  return tokens.every(token => {
    const compactToken = compactSearchText(token);
    return searchable.plain.includes(token) || (compactToken && searchable.compact.includes(compactToken));
  });
}

function rowMatchesFilters(row, excludeFilterId = '') {
  for (const def of config.filters) {
    if (def.id === excludeFilterId) continue;
    const selected = selectedSet(def.id);
    if (!selected.size) continue;
    const value = valueFor(row, def);
    if (Array.isArray(value)) {
      if (!value.some(item => selected.has(item))) return false;
    } else if (!selected.has(value)) {
      return false;
    }
  }
  return true;
}

function rowsForOptionCounts(excludeFilterId) {
  const keyword = text(els.searchInput.value).toLowerCase();
  return state.rows.filter(row => rowMatchesKeyword(row, keyword) && rowMatchesFilters(row, excludeFilterId));
}

function renderPageChrome() {
  document.body.dataset.page = PAGE;
  document.title = `${config.title} - TEMU运营看板`;
  els.title.textContent = config.title;
  els.priceNav.classList.toggle('active', PAGE === 'price');
  els.inventoryNav.classList.toggle('active', PAGE === 'inventory');
  renderTableHead();
}

function applyHealthUi() {
  const refreshEnabled = state.health?.refresh_enabled === true;
  for (const button of [els.runFetchBtn, els.runInventoryBtn]) {
    if (!button) continue;
    button.disabled = !refreshEnabled;
    button.title = refreshEnabled ? '' : '服务器看板不执行爬虫；本机计划任务会更新数据库';
    button.classList.toggle('is-disabled', !refreshEnabled);
  }
}

function renderMetrics(meta) {
  els.metricGrid.innerHTML = config.metrics.map(([key, label, tone]) => `
    <div class="metric ${tone || ''}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(meta[key] ?? 0)}</strong>
    </div>
  `).join('');
}

function columnClass(key) {
  return `col-${String(key).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function rowClass(row) {
  if (PAGE === 'inventory') {
    if (row.stockAction === '有在卖但没可用库存') return 'row-danger';
    if (row.stockAction === '有库存但无在卖链接' || row.stockAction === '库存源异常') return 'row-warn';
    return '';
  }
  if (row.priceAlert === '前端超价20%') return 'row-danger';
  if (row.priceAlert === '价格不一致') return 'row-warn';
  return '';
}

function filterOptionsHtml(def, options) {
  const selected = selectedSet(def.id);
  if (!options.length) return '<div class="filter-empty">暂无可筛选值</div>';
  return options.map(option => {
    const label = text(option.label);
    const value = text(option.value);
    return `
      <label class="filter-option ${option.count ? '' : 'is-zero'}" data-label="${escapeHtml(label.toLowerCase())}">
        <input type="checkbox" value="${escapeHtml(value)}" ${selected.has(value) ? 'checked' : ''} />
        <span class="filter-option-name">${escapeHtml(label)}</span>
        <span class="filter-option-count">${escapeHtml(option.count)}</span>
      </label>
    `;
  }).join('');
}

function renderFilterOptions(menu, def) {
  const options = optionValuesForDef(def, state.rows, rowsForOptionCounts(def.id));
  const filterOptions = menu.querySelector('.filter-options');
  if (!filterOptions) return;
  filterOptions.innerHTML = filterOptionsHtml(def, options);
  const keyword = text(menu.querySelector('.filter-search')?.value).toLowerCase();
  if (keyword) {
    filterOptions.querySelectorAll('.filter-option').forEach(option => {
      option.hidden = !option.dataset.label.includes(keyword);
    });
  }
}

function refreshOpenFilterPanels() {
  document.querySelectorAll('.filter-menu').forEach(menu => {
    const panel = menu.querySelector('.filter-panel');
    if (!panel || panel.hidden) return;
    const def = config.filters.find(item => item.id === menu.dataset.filterId);
    if (def) renderFilterOptions(menu, def);
  });
}

function renderFilters() {
  els.filterGrid.innerHTML = config.filters.map(def => {
    const options = optionValuesForDef(def, state.rows, rowsForOptionCounts(def.id));
    const selected = selectedSet(def.id);
    const selectedCount = options.filter(option => selected.has(text(option.value))).length;
    const optionHtml = filterOptionsHtml(def, options);

    return `
      <div class="filter-menu" data-filter-id="${escapeHtml(def.id)}">
        <button class="filter-trigger ${selectedCount ? 'is-active' : ''}" type="button" aria-haspopup="true" aria-expanded="false">
          <span><strong>${escapeHtml(def.label)}</strong><em>${escapeHtml(selectedLabel(def, options))}</em></span>
          <b>${selectedCount || ''}</b>
        </button>
        <div class="filter-panel" hidden>
          <div class="filter-panel-actions">
            <button type="button" data-action="all">全选</button>
            <button type="button" data-action="clear">清空</button>
          </div>
          <input class="filter-search" type="search" placeholder="搜索${escapeHtml(def.label)}" />
          <div class="filter-options">${optionHtml}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTableHead() {
  els.tableHead.innerHTML = `<tr>${config.columns.map(([key, label]) => `<th class="${columnClass(key)}">${escapeHtml(label)}</th>`).join('')}</tr>`;
}

function applyFilters() {
  const keyword = text(els.searchInput.value).toLowerCase();
  state.filtered = state.rows.filter(row => {
    return rowMatchesKeyword(row, keyword) && rowMatchesFilters(row);
  });
  updateResultCount();
  refreshOpenFilterPanels();
  renderTable();
}

function updateResultCount() {
  if (!els.resultCount) return;
  els.resultCount.textContent = `${state.filtered.length} / ${state.rows.length}`;
}

function renderTable() {
  const rows = state.filtered.slice(0, 2000);
  if (!rows.length) {
    els.tableBody.innerHTML = `<tr><td colspan="${config.columns.length}" class="empty">没有符合条件的数据</td></tr>`;
    return;
  }
  els.tableBody.innerHTML = rows.map(row => `
    <tr class="${rowClass(row)}">
      ${config.columns.map(([key, , render]) => `<td class="${columnClass(key)}">${render ? render(row, key) : defaultCell(row, key)}</td>`).join('')}
    </tr>
  `).join('');
}

function imageCell(row) {
  return row.image
    ? `<img class="product-img" src="${escapeHtml(row.image)}" loading="lazy" referrerpolicy="no-referrer" alt="">`
    : '<div class="product-img"></div>';
}

function titleCell(row) {
  if (row.title && row.officialTitle && row.title !== row.officialTitle) {
    return `<div class="title-cell">${escapeHtml(row.title)}<div class="muted">TEMU：${escapeHtml(row.officialTitle)}</div></div>`;
  }
  return `<div class="title-cell">${escapeHtml(row.title || row.officialTitle)}</div>`;
}

function multilineCell(row, key) {
  return `<div class="multi-cell">${escapeHtml(row[key]).replace(/\n/g, '<br>')}</div>`;
}

function defaultCell(row, key) {
  if (key === 'owner' && !text(row[key])) return pill(EMPTY_OWNER_LABEL, 'muted-pill');
  return `<div class="plain-cell">${escapeHtml(row[key])}</div>`;
}

function skuListCell(row, key) {
  const values = text(row[key])
    .split(/[；;,，\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
  if (!values.length) return '';
  return `<div class="sku-list-cell">${values.map(value => {
    const parts = value.match(/^(.+?)(?::\s*(-?\d+(?:\.\d+)?))?$/);
    const sku = parts?.[1]?.trim() || value;
    const qty = parts?.[2] ?? '';
    return `<span><b>${escapeHtml(sku)}</b>${qty !== '' ? `<em>${escapeHtml(qty)}</em>` : ''}</span>`;
  }).join('')}</div>`;
}

function priceDetailsCell(row, key) {
  const values = text(row[key])
    .split(/\n+/)
    .map(item => item.trim())
    .filter(Boolean);
  if (!values.length) return '';
  return `<div class="price-details-cell">${values.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</div>`;
}

function cleanStatusText(value) {
  return text(value)
    .replace(/\((\d+)\)/g, '')
    .replace(/:\s*(\d+)/g, ' x$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusSummaryCell(row, key) {
  const values = text(row[key])
    .split(/[；;,，\n]+/)
    .map(cleanStatusText)
    .filter(Boolean);
  if (!values.length) return '';
  return `<div class="status-list-cell">${values.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</div>`;
}

function pill(textValue, type = '') {
  if (!textValue) return '';
  return `<span class="pill ${type}">${escapeHtml(textValue)}</span>`;
}

function sourceCell(row) {
  return row.sourceSide === 'TEMU官方' ? pill('TEMU官方', 'official') : pill(row.sourceSide || '领星');
}

function matchCell(row) {
  if (row.matchStatus === '领星未匹配官方' || row.matchStatus === '官方未匹配领星') return pill(row.matchStatus, 'danger');
  if (row.matchStatus === '标题匹配') return pill(row.matchStatus, 'warn');
  return pill(row.matchStatus);
}

function statusCell(row) {
  return pill(row.status);
}

function ownerStatusCell(row) {
  return row.ownerStatus === '未匹配负责人' ? pill(row.ownerStatus, 'warn') : pill(row.ownerStatus);
}

function ownerMatchCell(row) {
  if (row.ownerMatchType === '模糊产品名') return pill(row.ownerMatchText, 'warn');
  if (row.ownerMatchType === '未匹配') return pill(row.ownerMatchText, 'muted-pill');
  return pill(row.ownerMatchText);
}

function yesNoCell(row, key) {
  const value = text(row[key]);
  if (value === '是') return pill('是', 'danger');
  if (value === '否') return pill('否', 'muted-pill');
  return '';
}

function priceAlertCell(row) {
  if (row.priceAlert === '前端超价20%') return pill(row.priceAlert, 'danger');
  if (row.priceAlert === '价格不一致') return pill(row.priceAlert, 'warn');
  if (row.priceAlert === '价格一致') return pill(row.priceAlert);
  return pill(row.priceAlert, 'muted-pill');
}

function stockActionCell(row) {
  if (row.stockAction === '有在卖但没可用库存') return pill(row.stockAction, 'danger');
  if (row.stockAction === '有库存但无在卖链接' || row.stockAction === '公司有库存但TEMU无在卖') return pill(row.stockAction, 'warn');
  if (row.stockAction === '库存源异常') return pill(row.stockAction, 'muted-pill');
  return pill(row.stockAction);
}

function manualProcessStatusCell(row) {
  const status = text(row.manualProcessStatus || '无需处理');
  if (status === '无需处理' || row.manualActionable !== '是') return pill('无需处理', 'muted-pill');
  const nextStatus = status === '已完成' ? '未处理' : '已完成';
  const tone = status === '已完成' ? 'is-done' : 'is-pending';
  return `
    <button
      type="button"
      class="manual-status-toggle ${tone}"
      data-row-key="${escapeHtml(row._rowKey)}"
      data-current-status="${escapeHtml(status)}"
      title="点击标记为${escapeHtml(nextStatus)}"
    >${escapeHtml(status)}</button>
  `;
}

function referencePriceCell(row) {
  return `${escapeHtml(row.referencePrice)} <span class="muted">${escapeHtml(row.referencePriceType)}</span>`;
}

function officialPriceCell(row) {
  const value = escapeHtml(row.officialPrice);
  return row.officialUrl ? `<a href="${escapeHtml(row.officialUrl)}" target="_blank" rel="noreferrer">${value}</a>` : value;
}

function closeFilterMenus(except) {
  document.querySelectorAll('.filter-menu').forEach(menu => {
    if (except && menu === except) return;
    const panel = menu.querySelector('.filter-panel');
    const trigger = menu.querySelector('.filter-trigger');
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function updateFilterSummary(filterId) {
  const def = config.filters.find(item => item.id === filterId);
  const menu = document.querySelector(`.filter-menu[data-filter-id="${CSS.escape(filterId)}"]`);
  if (!def || !menu) return;
  const options = optionValuesForDef(def, state.rows, rowsForOptionCounts(filterId));
  const selectedCount = options.filter(option => selectedSet(filterId).has(text(option.value))).length;
  menu.querySelector('.filter-trigger em').textContent = selectedLabel(def, options);
  menu.querySelector('.filter-trigger b').textContent = selectedCount || '';
  menu.querySelector('.filter-trigger').classList.toggle('is-active', selectedCount > 0);
}

function handleFilterClick(event) {
  const trigger = event.target.closest('.filter-trigger');
  if (trigger) {
    const menu = trigger.closest('.filter-menu');
    const panel = menu.querySelector('.filter-panel');
    const willOpen = panel.hidden;
    closeFilterMenus(menu);
    if (willOpen) {
      const def = config.filters.find(item => item.id === menu.dataset.filterId);
      if (def) renderFilterOptions(menu, def);
    }
    panel.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) menu.querySelector('.filter-search')?.focus();
    return;
  }

  const actionBtn = event.target.closest('[data-action]');
  if (actionBtn) {
    const menu = actionBtn.closest('.filter-menu');
    const selected = selectedSet(menu.dataset.filterId);
    if (actionBtn.dataset.action === 'clear') selected.clear();
    if (actionBtn.dataset.action === 'all') {
      selected.clear();
      menu.querySelectorAll('.filter-option input').forEach(input => selected.add(input.value));
    }
    menu.querySelectorAll('.filter-option input').forEach(input => {
      input.checked = selected.has(input.value);
    });
    updateFilterSummary(menu.dataset.filterId);
    applyFilters();
  }
}

function handleFilterInput(event) {
  const checkbox = event.target.closest('.filter-option input[type="checkbox"]');
  if (checkbox) {
    const menu = checkbox.closest('.filter-menu');
    const selected = selectedSet(menu.dataset.filterId);
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    updateFilterSummary(menu.dataset.filterId);
    applyFilters();
    return;
  }
  const search = event.target.closest('.filter-search');
  if (search) {
    const keyword = text(search.value).toLowerCase();
    search.closest('.filter-menu').querySelectorAll('.filter-option').forEach(option => {
      option.hidden = keyword && !option.dataset.label.includes(keyword);
    });
  }
}

async function updateManualProcessStatus(button) {
  const rowKey = button.dataset.rowKey;
  const currentStatus = button.dataset.currentStatus;
  const nextStatus = currentStatus === '已完成' ? '未处理' : '已完成';
  if (!rowKey) return;
  button.disabled = true;
  button.textContent = '保存中';
  try {
    const response = await fetch('/api/action-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: PAGE, rowKey, status: nextStatus })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '处理状态保存失败');
    await loadData();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = currentStatus;
  }
}

function handleTableClick(event) {
  const button = event.target.closest('.manual-status-toggle');
  if (button) {
    updateManualProcessStatus(button);
  }
}

function clearFilters() {
  state.filters.forEach(selected => selected.clear());
  els.searchInput.value = '';
  renderFilters();
  applyFilters();
}

async function loadData() {
  els.sourceLine.textContent = '读取数据中';
  els.updateStatus.textContent = '读取数据中';
  const response = await fetch(config.api);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || '读取失败');
  state.rows = payload.data || [];
  renderMetrics(payload.meta || {});
  renderUpdateStatus(payload);
  els.sourceLine.textContent = config.sourceLine(payload);
  renderFilters();
  applyFilters();
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const payload = await response.json();
    if (response.ok) state.health = payload;
  } catch {
    state.health = null;
  }
  applyHealthUi();
}

async function postRefresh(url, button, pendingText, normalText) {
  button.disabled = true;
  button.textContent = pendingText;
  try {
    const response = await fetch(url, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '提交失败');
  } catch (error) {
    alert(error.message);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = normalText;
    }, 3000);
  }
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportFiltered() {
  const headers = config.exportHeaders;
  const lines = [headers.map(([, label]) => csvEscape(label)).join(',')];
  for (const row of state.filtered) {
    lines.push(headers.map(([key]) => csvEscape(row[key])).join(','));
  }
  const blob = new Blob(['\ufeff', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  link.href = URL.createObjectURL(blob);
  link.download = `${config.exportName}_当前筛选_${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

renderPageChrome();
loadHealth();
els.searchInput.addEventListener('input', applyFilters);
els.filterGrid.addEventListener('click', handleFilterClick);
els.filterGrid.addEventListener('input', handleFilterInput);
els.tableBody.addEventListener('click', handleTableClick);
document.addEventListener('click', event => {
  if (!event.target.closest('.filter-menu')) closeFilterMenus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeFilterMenus();
});

els.refreshBtn.addEventListener('click', () => loadData().catch(error => alert(error.message)));
els.runFetchBtn.addEventListener('click', () => postRefresh('/api/refresh/lingxing', els.runFetchBtn, '已提交同步更新', '同步更新领星+库存'));
els.runInventoryBtn.addEventListener('click', () => postRefresh('/api/refresh/inventory', els.runInventoryBtn, '已提交库存刷新', '仅刷新库存'));
els.exportBtn.addEventListener('click', exportFiltered);
els.clearFiltersBtn.addEventListener('click', clearFilters);

loadData().catch(error => {
  els.updateStatus.textContent = `读取失败：${error.message}`;
  els.sourceLine.textContent = `读取失败：${error.message}`;
  els.tableBody.innerHTML = `<tr><td colspan="${config.columns.length}" class="empty">${escapeHtml(error.message)}</td></tr>`;
});
