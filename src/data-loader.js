const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const MODULE_DIR = path.resolve(__dirname, '..');
const APP_DIR = path.resolve(MODULE_DIR, '..', '..');
const PROJECT_DIR = path.resolve(APP_DIR, '..');
const INPUT_DIR = path.join(APP_DIR, 'input', '在售');
const DATA_DIR = path.join(MODULE_DIR, 'data');
const WAREHOUSE_DATA_DIR = path.join(APP_DIR, 'modules', 'warehouse-inventory-monitor', 'data');

const LINGXING_PRICE_BASENAME = '领星_TEMU_今日已加入站点_全店铺';
const LINGXING_INVENTORY_BASENAME = '领星_TEMU_今日全状态_全店铺';
const LINGXING_PRICE_CSV = path.join(INPUT_DIR, `${LINGXING_PRICE_BASENAME}.csv`);
const LINGXING_INVENTORY_CSV = path.join(INPUT_DIR, `${LINGXING_INVENTORY_BASENAME}.csv`);
const WAREHOUSE_INVENTORY_CSV = path.join(WAREHOUSE_DATA_DIR, 'warehouse_inventory_latest.csv');
const STATIC_SKU_OWNER_FILES = [
  path.join(APP_DIR, 'input', '平台SKU_1781161550125.xlsx'),
  path.join(APP_DIR, 'input', 'SKU-运营映射表.xlsx'),
  path.join(INPUT_DIR, 'SKU-运营映射表.xlsx')
];
const TEMU_OFFICIAL_FILES = [
  path.join(DATA_DIR, 'temu_official_products.csv'),
  path.join(DATA_DIR, 'temu_official_products.json')
];
let skuOwnerCache = null;
let priceDataCache = null;
let inventoryDataCache = null;

function fileInfo(file) {
  if (!file || !fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    file,
    exists: true,
    size: stat.size,
    updated_at: stat.mtime.toISOString()
  };
}

function fileMtime(file) {
  return file && fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
}

function cacheKey(parts) {
  return parts.map(part => `${part.file || ''}:${part.mtime || 0}`).join('|');
}

function newest(files) {
  const existing = files.filter(file => fs.existsSync(file));
  if (!existing.length) return '';
  return existing
    .map(file => ({ file, time: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.time - a.time)[0].file;
}

function findSkuOwnerFiles() {
  const dirs = [
    PROJECT_DIR,
    path.join(PROJECT_DIR, 'return-label-automation'),
    path.join(APP_DIR, 'input'),
    INPUT_DIR
  ];
  const files = [...STATIC_SKU_OWNER_FILES];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/^平台SKU_\d+\.xlsx$/i.test(name) || /SKU.*运营.*映射.*\.xlsx$/i.test(name)) {
        files.push(path.join(dir, name));
      }
    }
  }
  return [...new Set(files)];
}

function findLatestLingxingRaw(baseName) {
  if (!fs.existsSync(INPUT_DIR)) return '';
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}_.*_raw\\.json$`);
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter(name => re.test(name))
    .map(name => path.join(INPUT_DIR, name));
  return newest(files);
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows
    .filter(values => values.some(value => String(value || '').trim()))
    .map(values => {
      const out = {};
      headers.forEach((header, index) => {
        out[header] = values[index] || '';
      });
      return out;
    });
}

function readSheet(file) {
  if (!file || !fs.existsSync(file)) return [];
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.rows)) return json.rows;
    if (Array.isArray(json.products)) return json.products;
    if (Array.isArray(json.listings)) return json.listings;
    return [];
  }
  if (ext === '.csv') return csvParse(fs.readFileSync(file, 'utf8'));
  return [];
}

function normalizeHeader(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function readWorkbookRows(file) {
  if (!file || !fs.existsSync(file)) return [];
  const workbook = XLSX.readFile(file, { cellDates: false });
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    const values = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    if (!values.length) continue;
    const headers = values[0].map(header => String(header || '').trim());
    const normalizedHeaders = headers.map(normalizeHeader);
    for (const rowValues of values.slice(1)) {
      const row = { __sheet: sheetName };
      headers.forEach((header, index) => {
        if (header) row[header] = rowValues[index] ?? '';
      });
      row.__headers = normalizedHeaders;
      rows.push(row);
    }
  }
  return rows;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeKey(value) {
  return normalizeText(value).replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

const EU_SITE_CODES = new Set(['DE', 'UK', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PL', 'SE', 'CZ']);
const GLOBAL_SITE_CODES = new Set(['US', 'AU', 'CA', 'JP', 'AM', 'QT']);

function ownerStoreInfo(value) {
  const source = String(value || '').trim();
  if (!source) return { tokens: [], region: '' };
  let code = source.replace(/^temu[_\s-]*/i, '').trim();
  const parts = code.split(/[_\s-]+/).filter(Boolean);
  let region = '';
  if (parts.length) {
    const suffix = parts[parts.length - 1].toUpperCase();
    if (EU_SITE_CODES.has(suffix) || suffix === 'EU') {
      region = 'eu';
      parts.pop();
    } else if (GLOBAL_SITE_CODES.has(suffix)) {
      region = 'global';
      parts.pop();
    }
  }
  const tokenValues = [parts.join(''), parts[parts.length - 1], code, source];
  return {
    tokens: [...new Set(tokenValues.map(normalizeKey).filter(Boolean))],
    region
  };
}

function rowStoreTokens(row = {}) {
  const source = String(row.storeName || row.store || row.mallName || '').trim();
  if (!source) return [];
  const storeOnly = source
    .split(/\s+\/\s+/)[0]
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[-_\s]*(美[，,]?\s*全球|美国\s*\/?\s*global|欧区|欧洲|EU|AM|QT)\s*$/i, '')
    .trim();
  const tokenValues = [storeOnly, storeOnly.split(/[-_\s]+/)[0], source];
  return [...new Set(tokenValues.map(normalizeKey).filter(Boolean))];
}

function rowRegionGroup(row = {}) {
  const primary = `${row.storeName || ''} ${row.area || ''} ${row.regionGroup || ''}`;
  if (/欧区|欧洲|\bEU\b|\bDE\b|\bUK\b|\bFR\b|\bIT\b|\bES\b/i.test(primary)) return 'eu';
  if (/美|美国|全球|Global|\bUS\b|\bAM\b|\bQT\b/i.test(primary)) return 'global';
  const site = String(row.site || '').trim().toUpperCase();
  if (EU_SITE_CODES.has(site) || site === 'EU') return 'eu';
  if (GLOBAL_SITE_CODES.has(site)) return 'global';
  return '';
}

function storeSkuKey(storeToken, region, skuKey) {
  return [storeToken, region || '*', skuKey].join('|');
}

function excludedStoreNames() {
  return String(process.env.EXCLUDED_STORE_NAMES || 'Broadure,Broadure-EU,guangyd,guangyd-EU')
    .split(',')
    .map(item => normalizeKey(item))
    .filter(Boolean);
}

function isExcludedStoreName(value) {
  const key = normalizeKey(value);
  return Boolean(key && excludedStoreNames().includes(key));
}

function pick(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return String(row[name]);
  }
  return '';
}

function pickByNormalizedHeader(row, candidates) {
  const wanted = candidates.map(normalizeHeader);
  const headers = Object.keys(row);
  for (const candidate of wanted) {
    for (const header of headers) {
      if (header.startsWith('__')) continue;
      if (normalizeHeader(header) === candidate) return String(row[header] ?? '');
    }
  }
  for (const candidate of wanted) {
    for (const header of headers) {
      if (header.startsWith('__')) continue;
      const normalized = normalizeHeader(header);
      if (normalized.includes(candidate) || candidate.includes(normalized)) return String(row[header] ?? '');
    }
  }
  return '';
}

function splitSkuValues(value) {
  return String(value || '')
    .split(/[；;,，\n\r\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function extractSkuCodes(value) {
  const source = String(value || '');
  const matches = source.match(/[A-Z0-9]+(?:-[A-Z0-9]+){1,3}/gi) || [];
  if (matches.length) return matches.map(item => item.trim()).filter(Boolean);
  return splitSkuValues(source);
}

function skuPrefix(value) {
  const sku = String(value || '').trim();
  const parts = sku.split('-').filter(Boolean);
  return parts.length >= 2 ? normalizeKey(parts[0]) : '';
}

function cleanOwnerItems(value) {
  const invalidOwners = new Set(['该人员已离职', '暂无开发请联系开发部负责人', '起订量采购员', '集单采购员']);
  return String(value || '')
    .split(/[；;,，/\n\r]+/)
    .map(item => item.replace(/\s*(正|负)\s*$/g, '').trim())
    .filter(item => item && !invalidOwners.has(item));
}

function splitProductNameValues(value) {
  return String(value || '')
    .split(/[；;\n\r]+/)
    .map(item => item.replace(/^\s*\d+\.\s*/, '').split(/\s*\|\s*SKU[:：]/i)[0].trim())
    .filter(Boolean);
}

function productNameKeys(value) {
  const source = String(value || '').trim();
  const withoutBracketNote = source.replace(/[（(][^）)]*[）)]/g, '').trim();
  return [...new Set([source, withoutBracketNote].map(normalizeKey).filter(Boolean))];
}

function fuzzyNameKey(value) {
  return normalizeKey(
    String(value || '')
      .replace(/\s*\|\s*SKU[:：].*$/i, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/一箱|一套|一个|套装|组合装|配件|适用于|用于/g, '')
  );
}

function ngrams(value) {
  const source = String(value || '');
  if (source.length <= 2) return source ? [source] : [];
  const out = [];
  for (let index = 0; index < source.length - 1; index++) {
    out.push(source.slice(index, index + 2));
  }
  return out;
}

function diceSimilarity(left, right) {
  const a = fuzzyNameKey(left);
  const b = fuzzyNameKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 3 && longer.includes(shorter)) {
    return Math.min(0.96, 0.72 + 0.24 * (shorter.length / longer.length));
  }
  const leftParts = ngrams(a);
  const rightCounts = new Map();
  for (const item of ngrams(b)) rightCounts.set(item, (rightCounts.get(item) || 0) + 1);
  let hits = 0;
  for (const item of leftParts) {
    const count = rightCounts.get(item) || 0;
    if (!count) continue;
    hits++;
    if (count === 1) rightCounts.delete(item);
    else rightCounts.set(item, count - 1);
  }
  return (2 * hits) / (leftParts.length + [...rightCounts.values()].reduce((sum, count) => sum + count, 0) + hits);
}

function addOwnerToSetMap(map, key, owner) {
  if (!key || !owner) return;
  if (!map.has(key)) map.set(key, new Set());
  for (const item of cleanOwnerItems(owner)) map.get(key).add(item);
}

function uniqueOwnerMap(setMap) {
  const out = new Map();
  for (const [key, owners] of setMap.entries()) {
    if (owners.size === 1) out.set(key, [...owners][0]);
  }
  return out;
}

function allOwnerMap(setMap) {
  const out = new Map();
  for (const [key, owners] of setMap.entries()) {
    if (owners.size) out.set(key, [...owners].join('；'));
  }
  return out;
}

function addToArrayMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function ownerMatchCacheKey(skuValues, nameValues, rowContext = {}) {
  return [
    skuValues.map(value => String(value || '').trim()).join('\u001f'),
    nameValues.map(value => String(value || '').trim()).join('\u001f'),
    [rowContext.storeName || '', rowContext.area || '', rowContext.site || '', rowContext.regionGroup || ''].join('\u001f')
  ].join('\u001e');
}

function addOwnerResult(owners, seen, owner) {
  for (const item of cleanOwnerItems(owner)) {
    if (seen.has(item)) continue;
    seen.add(item);
    owners.push(item);
  }
}

function ownerResult(owners, matchType, score = '') {
  const owner = owners.join('；');
  return {
    owner,
    ownerStatus: owner ? (owners.length > 1 ? '多负责人候选' : '已匹配负责人') : '未匹配负责人',
    ownerMatchType: owner ? matchType : '未匹配',
    ownerMatchScore: score,
    ownerMatchText: owner ? `${matchType}${score ? ` ${score}` : ''}` : '未匹配'
  };
}

function ownerCandidateResult(owners, matchType, score = '') {
  const result = ownerResult(owners, matchType, score);
  if (owners.length > 1) result.ownerMatchText = `${matchType}候选 ${owners.length}人`;
  return result;
}

function collectOwnersBySku(skuValues, ownerIndex, keyForSku) {
  const owners = [];
  const seen = new Set();
  for (const value of skuValues) {
    for (const sku of extractSkuCodes(value)) {
      const owner = ownerIndex.get(keyForSku(sku));
      if (owner) addOwnerResult(owners, seen, owner);
    }
  }
  return owners;
}

function collectOwnersByStoreSku(skuValues, ownerIndex, rowContext = {}) {
  const owners = [];
  const seen = new Set();
  const storeTokens = rowStoreTokens(rowContext);
  if (!storeTokens.length) return owners;
  const region = rowRegionGroup(rowContext);
  for (const value of skuValues) {
    for (const sku of extractSkuCodes(value)) {
      const skuKeys = [normalizeKey(sku), skuPrefix(sku)].filter(Boolean);
      for (const storeToken of storeTokens) {
        for (const skuKey of skuKeys) {
          for (const regionKey of [region, '*'].filter(Boolean)) {
            const owner = ownerIndex.byStoreSku?.get(storeSkuKey(storeToken, regionKey, skuKey));
            if (owner) addOwnerResult(owners, seen, owner);
          }
        }
      }
    }
  }
  return owners;
}

function collectOwnersByRegionSku(skuValues, ownerIndex, rowContext = {}) {
  const owners = [];
  const seen = new Set();
  const region = rowRegionGroup(rowContext);
  if (!region) return owners;
  for (const value of skuValues) {
    for (const sku of extractSkuCodes(value)) {
      const skuKeys = [normalizeKey(sku), skuPrefix(sku)].filter(Boolean);
      for (const skuKey of skuKeys) {
        const owner = ownerIndex.byRegionSku?.get(storeSkuKey('*', region, skuKey));
        if (owner) addOwnerResult(owners, seen, owner);
      }
    }
  }
  return owners;
}

function collectOwnersByProductName(nameValues, ownerIndex) {
  const owners = [];
  const seen = new Set();
  for (const value of nameValues) {
    for (const name of splitProductNameValues(value)) {
      for (const key of productNameKeys(name)) {
        const owner = ownerIndex.byProductName?.get(key);
        if (owner) addOwnerResult(owners, seen, owner);
      }
    }
  }
  return owners;
}

function fuzzyOwnerByProductName(skuValues, nameValues, ownerIndex) {
  const entries = ownerIndex.fuzzyProductNames || [];
  if (!entries.length) return null;
  const rowPrefixes = new Set();
  for (const value of skuValues) {
    for (const sku of extractSkuCodes(value)) {
      const prefix = skuPrefix(sku);
      if (prefix) rowPrefixes.add(prefix);
    }
  }

  let bestScore = 0;
  const bestOwners = new Set();
  for (const value of nameValues) {
    for (const name of splitProductNameValues(value)) {
      const nameKey = fuzzyNameKey(name);
      if (nameKey.length < 2) continue;
      const candidates = new Set();
      for (const prefix of rowPrefixes) {
        for (const entry of ownerIndex.fuzzyBySkuPrefix?.get(prefix) || []) candidates.add(entry);
      }
      for (const gram of new Set(ngrams(nameKey))) {
        for (const entry of ownerIndex.fuzzyByGram?.get(gram) || []) candidates.add(entry);
      }
      for (const entry of candidates) {
        const sharedSkuPrefix = entry.skuPrefixes.some(prefix => rowPrefixes.has(prefix));
        const baseScore = diceSimilarity(nameKey, entry.key);
        const score = Math.min(0.99, baseScore + (sharedSkuPrefix ? 0.14 : 0));
        const threshold = sharedSkuPrefix ? 0.78 : 0.86;
        if (score < threshold) continue;
        if (score > bestScore + 0.03) {
          bestScore = score;
          bestOwners.clear();
        }
        if (score >= bestScore - 0.03) {
          for (const owner of cleanOwnerItems(entry.owner)) bestOwners.add(owner);
        }
      }
    }
  }

  if (!bestScore || bestOwners.size !== 1) return null;
  return ownerResult([...bestOwners], '模糊产品名', `${Math.round(bestScore * 100)}%`);
}

function ownerMatchForSkuValues(skuValues, ownerIndex, nameValues = [], rowContext = {}) {
  if (!ownerIndex.ownerMatchCache) ownerIndex.ownerMatchCache = new Map();
  const matchCacheKey = ownerMatchCacheKey(skuValues, nameValues, rowContext);
  if (ownerIndex.ownerMatchCache.has(matchCacheKey)) return ownerIndex.ownerMatchCache.get(matchCacheKey);

  const storeSkuOwners = collectOwnersByStoreSku(skuValues, ownerIndex, rowContext);
  if (storeSkuOwners.length) {
    const result = ownerCandidateResult(storeSkuOwners, '店铺SKU');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const exactOwners = collectOwnersBySku(skuValues, ownerIndex, sku => normalizeKey(sku));
  if (exactOwners.length) {
    const result = ownerCandidateResult(exactOwners, '精确SKU');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const regionSkuOwners = collectOwnersByRegionSku(skuValues, ownerIndex, rowContext);
  if (regionSkuOwners.length) {
    const result = ownerCandidateResult(regionSkuOwners, '区域SKU');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const prefixOwners = collectOwnersBySku({ [Symbol.iterator]: function* () { yield* skuValues; } }, { get: key => ownerIndex.bySkuPrefix?.get(key) }, skuPrefix);
  if (prefixOwners.length) {
    const result = ownerCandidateResult(prefixOwners, 'SKU前缀');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const nameOwners = collectOwnersByProductName(nameValues, ownerIndex);
  if (nameOwners.length) {
    const result = ownerCandidateResult(nameOwners, '产品名');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const result = fuzzyOwnerByProductName(skuValues, nameValues, ownerIndex) || ownerResult([], '未匹配');
  ownerIndex.ownerMatchCache.set(matchCacheKey, result);
  return result;
}

function ownerTextForSkuValues(skuValues, ownerIndex, nameValues = [], rowContext = {}) {
  return ownerMatchForSkuValues(skuValues, ownerIndex, nameValues, rowContext).owner;
}

function skuOwnerFile() {
  return newest(findSkuOwnerFiles());
}

function buildSkuOwnerIndexFromFile(file) {
  const index = new Map();
  const exactOwners = new Map();
  const storeSkuOwners = new Map();
  const regionSkuOwners = new Map();
  const prefixOwners = new Map();
  const productNameOwners = new Map();
  const fuzzyProductNames = [];
  const fuzzySeen = new Set();
  for (const row of readWorkbookRows(file)) {
    const platform = pickByNormalizedHeader(row, ['平台', 'platform']) || pick(row, ['平台', 'platform']);
    if (platform && !/temu/i.test(platform)) continue;
    const skuValues = [
      pickByNormalizedHeader(row, ['平台sku', '平台SKU', '平台商品SKU', 'seller sku', 'seller_sku']) ||
        pick(row, ['平台sku', '平台SKU', '平台商品SKU', 'seller sku', 'seller_sku']),
      pickByNormalizedHeader(row, ['主SKU', '主sku', 'main sku', 'main_sku']) ||
        pick(row, ['主SKU', '主sku', 'main sku', 'main_sku']),
      pickByNormalizedHeader(row, ['SKU', '系统SKU', '产品代码', '仓库产品代码', 'sku']) ||
        pick(row, ['SKU', '系统SKU', '产品代码', '仓库产品代码', 'sku'])
    ].filter(Boolean);
    const owner =
      pickByNormalizedHeader(row, ['负责人', '销售负责人', '运营', '运营负责人']) ||
      pick(row, ['负责人', '销售负责人', '运营', '运营负责人']);
    const productName =
      pickByNormalizedHeader(row, ['产品名称', '中文名称', '品名', '商品名称', '产品中文名']) ||
      pick(row, ['产品名称', '中文名称', '品名', '商品名称', '产品中文名']);
    const storeInfo = ownerStoreInfo(
      pickByNormalizedHeader(row, ['店铺code', '店铺代码', '店铺', '店铺名', 'store code', 'store_code', 'store']) ||
        pick(row, ['店铺code', '店铺代码', '店铺', '店铺名', 'store code', 'store_code', 'store'])
    );
    const cleanedOwner = cleanOwnerItems(owner).join('；');
    if (!skuValues.length || !cleanedOwner) continue;
    const skuPrefixes = new Set();
    for (const sku of skuValues) {
      const skuText = String(sku || '').trim();
      const directKey = normalizeKey(skuText);
      addOwnerToSetMap(exactOwners, directKey, cleanedOwner);
      for (const item of extractSkuCodes(skuText)) {
        const key = normalizeKey(item);
        addOwnerToSetMap(exactOwners, key, cleanedOwner);
        addOwnerToSetMap(prefixOwners, skuPrefix(item), cleanedOwner);
        if (skuPrefix(item)) skuPrefixes.add(skuPrefix(item));
        for (const storeToken of storeInfo.tokens) {
          if (key) {
            addOwnerToSetMap(storeSkuOwners, storeSkuKey(storeToken, storeInfo.region, key), cleanedOwner);
            addOwnerToSetMap(storeSkuOwners, storeSkuKey(storeToken, '*', key), cleanedOwner);
          }
          const prefix = skuPrefix(item);
          if (prefix) {
            addOwnerToSetMap(storeSkuOwners, storeSkuKey(storeToken, storeInfo.region, prefix), cleanedOwner);
            addOwnerToSetMap(storeSkuOwners, storeSkuKey(storeToken, '*', prefix), cleanedOwner);
          }
        }
        if (storeInfo.region) {
          if (key) addOwnerToSetMap(regionSkuOwners, storeSkuKey('*', storeInfo.region, key), cleanedOwner);
          const prefix = skuPrefix(item);
          if (prefix) addOwnerToSetMap(regionSkuOwners, storeSkuKey('*', storeInfo.region, prefix), cleanedOwner);
        }
      }
    }
    for (const name of splitProductNameValues(productName)) {
      for (const key of productNameKeys(name)) {
        addOwnerToSetMap(productNameOwners, key, cleanedOwner);
      }
      const fuzzyKey = fuzzyNameKey(name);
      const seenKey = `${fuzzyKey}|${cleanedOwner}|${[...skuPrefixes].sort().join(',')}`;
      if (fuzzyKey.length >= 2 && !fuzzySeen.has(seenKey)) {
        fuzzySeen.add(seenKey);
        fuzzyProductNames.push({
          key: fuzzyKey,
          owner: cleanedOwner,
          skuPrefixes: [...skuPrefixes]
        });
      }
    }
  }
  for (const [key, owner] of uniqueOwnerMap(exactOwners).entries()) index.set(key, owner);
  index.byStoreSku = allOwnerMap(storeSkuOwners);
  index.byRegionSku = allOwnerMap(regionSkuOwners);
  index.bySkuPrefix = allOwnerMap(prefixOwners);
  index.byProductName = allOwnerMap(productNameOwners);
  index.fuzzyProductNames = fuzzyProductNames;
  index.fuzzyBySkuPrefix = new Map();
  index.fuzzyByGram = new Map();
  for (const entry of fuzzyProductNames) {
    for (const prefix of entry.skuPrefixes) addToArrayMap(index.fuzzyBySkuPrefix, prefix, entry);
    for (const gram of new Set(ngrams(entry.key))) addToArrayMap(index.fuzzyByGram, gram, entry);
  }
  index.ownerMatchCache = new Map();
  return index;
}

function loadSkuOwnerIndex() {
  const file = skuOwnerFile();
  const mtimeMs = file && fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  if (skuOwnerCache && skuOwnerCache.file === file && skuOwnerCache.mtimeMs === mtimeMs) {
    return skuOwnerCache.index;
  }

  const index = buildSkuOwnerIndexFromFile(file);
  skuOwnerCache = { file, mtimeMs, index };
  return index;
}

function firstNumber(value) {
  const source = String(value || '').replace(/,/g, '');
  const match = source.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(digits);
}

const STATUS_MAP = {
  0: '已弃用',
  1: '待平台选品',
  2: '待上传生产资料',
  3: '待寄样',
  4: '寄样中',
  5: '待平台审版',
  6: '审版不合格',
  7: '平台核价中',
  8: '待修改生产资料',
  9: '核价未通过',
  10: '待下首单',
  11: '已下首单',
  12: '已加入站点',
  13: '已下架',
  14: '待卖家修改',
  15: '已修改',
  16: '服饰可加色',
  17: '已终止'
};

function statusCode(status) {
  const value = String(status ?? '').trim();
  if (/^\d+$/.test(value)) return value;
  const found = Object.entries(STATUS_MAP).find(([, label]) => label === value);
  return found ? found[0] : '';
}

function statusText(status) {
  const value = String(status ?? '').trim();
  return STATUS_MAP[value] || value;
}

function configuredActiveStatusCodes() {
  const codes = String(process.env.LINGXING_ACTIVE_STATUS_CODES || '12')
    .split(/[，,\s]+/)
    .map(item => item.trim())
    .filter(item => item && item !== '10');
  return new Set(codes.length ? codes : ['12']);
}

function isActiveStatus(status) {
  const code = statusCode(status);
  if (code && configuredActiveStatusCodes().has(code)) return true;
  const value = statusText(status);
  return value === '在售' || value === '已上架';
}

function isVoidLingxingStatus(row = {}) {
  const code = statusCode(row.statusCode || row.lingxingStatusCode || row.status || row.lingxingStatus);
  const label = statusText(row.status || row.lingxingStatus || row.statusCode || row.lingxingStatusCode);
  return code === '9' || label === '核价未通过';
}

function filterLingxingRows(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const afterStoreFilter = sourceRows.filter(row => !isExcludedStoreName(row.storeName));
  const afterVoidFilter = afterStoreFilter.filter(row => !isVoidLingxingStatus(row));
  return {
    rows: afterVoidFilter,
    stats: {
      raw_rows: sourceRows.length,
      excluded_store_rows: sourceRows.length - afterStoreFilter.length,
      excluded_void_status_rows: afterStoreFilter.length - afterVoidFilter.length
    }
  };
}

function priceForSku(product, skuCode, field) {
  const list = Array.isArray(product[field]) ? product[field] : [];
  if (!list.length) return null;
  const normalizedSku = normalizeKey(skuCode);
  const found = list.find(item => {
    const itemSku = item?.seller_sku || item?.sku || item?.seller_sku_id || item?.sku_id || '';
    return normalizeKey(itemSku) === normalizedSku;
  });
  if (found) return found;
  if (list.length === 1) return list[0];
  return null;
}

function skuItems(product) {
  if (Array.isArray(product.base_info_list) && product.base_info_list.length) return product.base_info_list;
  if (Array.isArray(product.baseInfoList) && product.baseInfoList.length) return product.baseInfoList;
  if (Array.isArray(product.sku_list) && product.sku_list.length) return product.sku_list;
  return [product];
}

function normalizeLingxingRaw(products) {
  const rows = [];
  for (const product of products) {
    for (const item of skuItems(product)) {
      const skuCode = String(item.seller_sku || item.sku || product.seller_sku || product.sku || '');
      const rawStatus = item.status ?? product.status;
      const supply = priceForSku(product, skuCode, 'supply_price');
      const activity = priceForSku(product, skuCode, 'activity_price');
      rows.push({
        source: 'lingxing',
        image: String(item.image_url || product.image_url || ''),
        platformSpu: String(product.spu_id || item.spu_id || ''),
        skuId: String(item.seller_sku_id || item.sku_id || product.seller_sku_id || ''),
        skcId: String(item.skc_id || product.skc_id || ''),
        skuCode,
        skuName: String(item.local_name || product.local_name || item.sku_name || ''),
        status: statusText(rawStatus),
        statusCode: statusCode(rawStatus),
        storeName: String(item.store_name || product.store_name || ''),
        area: String(item.area || product.area || ''),
        site: String(item.site || product.site || ''),
        title: String(item.platform_product_name || product.platform_product_name || item.title || ''),
        category: String(item.category || product.category || ''),
        brand: String(item.brand || product.brand || ''),
        lingxingDeclarePrice: String(supply?.price ?? product.declare_price ?? product.declared_price ?? ''),
        lingxingDeclareCurrency: String(supply?.currency_code || product.currency_code || ''),
        lingxingActivityPrice: String(activity?.price ?? ''),
        lingxingActivityCurrency: String(activity?.currency_code || product.currency_code || ''),
        salesAmount: String(product.sales_amount || product.sales || product.sale_amount || ''),
        orderCount: String(product.order_count || product.order_num || ''),
        volume: String(product.volume || product.sales_volume || ''),
        salesProfit: String(product.gross_profit || product.profit || ''),
        raw: product
      });
    }
  }
  return rows;
}

function normalizeLingxingSheet(rows) {
  return rows.map(row => {
    const rawStatus = pick(row, ['状态码', 'SKU字段.status', '商品字段.status', '状态', 'sku_status', 'status']);
    return {
      source: 'lingxing',
      image: pick(row, ['图片', 'image_url', '商品字段.image_url']),
      platformSpu: pick(row, ['平台SPU', 'SPU ID', 'spu_id', '商品字段.spu_id']),
      skuId: pick(row, ['SKU ID', 'sku_seller_sku_id', 'seller_sku_id', '商品字段.seller_sku_id']),
      skcId: pick(row, ['SKC ID', 'sku_skc_id', 'skc_id', '商品字段.skc_id']),
      skuCode: pick(row, ['SKU货号', 'SKU字段.seller_sku', '商品字段.seller_sku', 'seller_sku', 'sku', '品名/SKU']),
      skuName: pick(row, ['品名/SKU', '本地品名', 'sku_local_name', 'local_name']),
      status: statusText(rawStatus),
      statusCode: statusCode(rawStatus),
      storeName: pick(row, ['店铺', 'store_name']),
      area: pick(row, ['区域', 'area']),
      site: pick(row, ['站点', 'SKU字段.site', 'site']),
      title: pick(row, ['标题', '商品标题', 'platform_product_name']),
      category: pick(row, ['分类', '类目', 'category']),
      brand: pick(row, ['品牌', 'brand']),
      lingxingDeclarePrice: pick(row, ['申报价', '申报价格', 'declare_price', 'declared_price']),
      lingxingDeclareCurrency: pick(row, ['申报价格币种', '币种', 'currency_code']),
      lingxingActivityPrice: pick(row, ['活动价', 'activity_price']),
      lingxingActivityCurrency: pick(row, ['活动价币种', 'activity_currency']),
      salesAmount: pick(row, ['销售额', 'sales_amount']),
      orderCount: pick(row, ['订单量', 'order_count']),
      volume: pick(row, ['销量', 'volume']),
      salesProfit: pick(row, ['销售收益', '利润', 'gross_profit']),
      raw: row
    };
  });
}

function normalizeOfficial(rows) {
  return rows.map(row => ({
    source: 'official',
    image: pick(row, ['图片', 'image', 'image_url', 'img', '主图']),
    title: pick(row, ['标题', '商品标题', 'title', 'product_title', 'productName', 'listing_title']),
    skuCode: pick(row, ['SKU', 'SKU货号', 'sku', 'skuCode', 'seller_sku']),
    skuName: pick(row, ['品名', '本地品名', 'sku_name', 'local_name']),
    storeName: pick(row, ['店铺', '店铺名', 'store', 'store_name', 'seller_name', 'mall_name']),
    area: pick(row, ['区域', '站点', 'area', 'site', 'region']),
    site: pick(row, ['站点', 'site']),
    mallId: pick(row, ['店铺ID', 'mall_id', 'mallId']),
    goodsId: pick(row, ['商品ID', 'goods_id', 'goodsId', 'product_id']),
    officialPrice: pick(row, ['TEMU价格', '官方价格', '价格', 'price', 'sale_price']),
    officialCurrency: pick(row, ['币种', 'currency', 'currency_code']),
    officialUrl: pick(row, ['链接', 'url', 'product_url', 'goods_url']),
    raw: row
  }));
}

function readLingxing(baseName, standardCsv) {
  const rawFile = findLatestLingxingRaw(baseName);
  if (rawFile) {
    const products = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    const filtered = filterLingxingRows(normalizeLingxingRaw(Array.isArray(products) ? products : []));
    return {
      rows: filtered.rows,
      stats: filtered.stats,
      source: fileInfo(rawFile)
    };
  }
  const filtered = filterLingxingRows(normalizeLingxingSheet(readSheet(standardCsv)));
  return {
    rows: filtered.rows,
    stats: filtered.stats,
    source: fileInfo(standardCsv)
  };
}

function readOfficial() {
  const file = newest(TEMU_OFFICIAL_FILES);
  return {
    rows: normalizeOfficial(readSheet(file)),
    source: fileInfo(file)
  };
}

function rowStoreRegion(row) {
  return [row.storeName, row.area].filter(Boolean).join(' / ');
}

function buildOfficialIndexes(officialRows) {
  const byTitle = new Map();
  const bySku = new Map();
  for (const official of officialRows) {
    const titleKey = normalizeKey(official.title);
    const skuKey = normalizeKey(official.skuCode);
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, official);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, official);
  }
  return { byTitle, bySku };
}

function buildLingxingIndexes(lingxingRows) {
  const byTitle = new Map();
  const bySku = new Map();
  for (const row of lingxingRows) {
    const titleKey = normalizeKey(row.title);
    const skuKey = normalizeKey(row.skuCode);
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, row);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, row);
  }
  return { byTitle, bySku };
}

function referencePrice(row) {
  const activity = firstNumber(row.lingxingActivityPrice);
  if (activity !== null && activity > 0) {
    return {
      value: activity,
      type: '活动价',
      currency: row.lingxingActivityCurrency || row.lingxingDeclareCurrency
    };
  }
  const declare = firstNumber(row.lingxingDeclarePrice);
  return {
    value: declare,
    type: '申报价',
    currency: row.lingxingDeclareCurrency
  };
}

function priceStatus(row) {
  const ref = referencePrice(row);
  const official = firstNumber(row.officialPrice);
  if (official === null) return { state: '前端缺价', diff: '', diffRate: '', over20: '否' };
  if (ref.value === null || ref.value <= 0) return { state: '后台缺价', diff: '', diffRate: '', over20: '否' };
  const diff = official - ref.value;
  const diffRate = diff / ref.value;
  if (diffRate > 0.2) {
    return { state: '前端超价20%', diff: formatNumber(diff), diffRate: formatNumber(diffRate * 100), over20: '是' };
  }
  if (diff !== 0) {
    return { state: '价格不一致', diff: formatNumber(diff), diffRate: formatNumber(diffRate * 100), over20: '否' };
  }
  return { state: '价格一致', diff: '0.00', diffRate: '0.00', over20: '否' };
}

function fromLingxingPrice(row, official, matchStatus, index, ownerIndex) {
  const ref = referencePrice(row);
  const status = priceStatus({ ...row, officialPrice: official?.officialPrice || '' });
  const ownerMatch = ownerMatchForSkuValues([row.skuCode], ownerIndex, [row.skuName, row.title], row);
  return {
    id: `price-lx-${row.platformSpu || 'spu'}-${row.skcId || row.skuId || index}`,
    sourceSide: '领星',
    image: row.image || official?.image || '',
    platformSpu: row.platformSpu,
    skuId: row.skuId,
    skcId: row.skcId,
    skuCode: row.skuCode,
    skuName: row.skuName,
    owner: ownerMatch.owner,
    ownerStatus: ownerMatch.ownerStatus,
    ownerMatchType: ownerMatch.ownerMatchType,
    ownerMatchScore: ownerMatch.ownerMatchScore,
    ownerMatchText: ownerMatch.ownerMatchText,
    status: row.status,
    storeName: row.storeName,
    area: row.area,
    site: row.site || '',
    storeRegion: rowStoreRegion(row),
    mallId: official?.mallId || '',
    goodsId: official?.goodsId || '',
    title: row.title,
    officialTitle: official?.title || '',
    category: row.category,
    brand: row.brand,
    lingxingDeclarePrice: row.lingxingDeclarePrice,
    lingxingDeclareCurrency: row.lingxingDeclareCurrency,
    lingxingActivityPrice: row.lingxingActivityPrice,
    referencePrice: ref.value === null ? '' : String(ref.value),
    referencePriceType: ref.type,
    referenceCurrency: ref.currency,
    officialPrice: official?.officialPrice || '',
    officialCurrency: official?.officialCurrency || '',
    officialUrl: official?.officialUrl || '',
    priceDiff: status.diff,
    priceDiffRate: status.diffRate,
    priceAlert: status.state,
    priceOver20: status.over20,
    matchStatus,
    salesAmount: row.salesAmount,
    orderCount: row.orderCount,
    volume: row.volume,
    salesProfit: row.salesProfit
  };
}

function fromOfficialPrice(official, index, ownerIndex) {
  const ownerMatch = ownerMatchForSkuValues([official.skuCode], ownerIndex, [official.skuName, official.title], official);
  return {
    id: `price-official-${official.mallId || 'mall'}-${official.goodsId || normalizeKey(official.title) || index}`,
    sourceSide: 'TEMU官方',
    image: official.image,
    platformSpu: '',
    skuId: '',
    skcId: '',
    skuCode: official.skuCode,
    skuName: official.skuName,
    owner: ownerMatch.owner,
    ownerStatus: ownerMatch.ownerStatus,
    ownerMatchType: ownerMatch.ownerMatchType,
    ownerMatchScore: ownerMatch.ownerMatchScore,
    ownerMatchText: ownerMatch.ownerMatchText,
    status: '',
    storeName: official.storeName,
    area: official.area,
    site: official.site || '',
    storeRegion: rowStoreRegion(official),
    mallId: official.mallId,
    goodsId: official.goodsId,
    title: '',
    officialTitle: official.title,
    category: '',
    brand: '',
    lingxingDeclarePrice: '',
    lingxingDeclareCurrency: '',
    lingxingActivityPrice: '',
    referencePrice: '',
    referencePriceType: '',
    referenceCurrency: '',
    officialPrice: official.officialPrice,
    officialCurrency: official.officialCurrency,
    officialUrl: official.officialUrl,
    priceDiff: '',
    priceDiffRate: '',
    priceAlert: '官方未匹配领星',
    priceOver20: '否',
    matchStatus: '官方未匹配领星',
    salesAmount: '',
    orderCount: '',
    volume: '',
    salesProfit: ''
  };
}

function matchPriceRows(lingxingRows, officialRows, ownerIndex) {
  const officialIndexes = buildOfficialIndexes(officialRows);
  const lingxingIndexes = buildLingxingIndexes(lingxingRows);
  const usedOfficial = new Set();

  const rows = lingxingRows.map((row, index) => {
    const titleKey = normalizeKey(row.title);
    const skuKey = normalizeKey(row.skuCode);
    const titleMatch = titleKey ? officialIndexes.byTitle.get(titleKey) : null;
    const skuMatch = !titleMatch && skuKey ? officialIndexes.bySku.get(skuKey) : null;
    const official = titleMatch || skuMatch || null;
    if (official) {
      usedOfficial.add(official);
      return fromLingxingPrice(row, official, titleMatch ? '标题匹配' : 'SKU匹配', index, ownerIndex);
    }
    return fromLingxingPrice(row, null, '领星未匹配官方', index, ownerIndex);
  });

  for (const [index, official] of officialRows.entries()) {
    if (usedOfficial.has(official)) continue;
    const titleKey = normalizeKey(official.title);
    const skuKey = normalizeKey(official.skuCode);
    if ((titleKey && lingxingIndexes.byTitle.has(titleKey)) || (skuKey && lingxingIndexes.bySku.has(skuKey))) continue;
    rows.push(fromOfficialPrice(official, index, ownerIndex));
  }

  return rows;
}

function normalizeInventory(rows, ownerIndex) {
  return rows.map((row, index) => {
    const out = {
      id: `inventory-${pick(row, ['SKU货号', 'skuCode']) || index}-${index}`,
      image: pick(row, ['图片', 'image']),
      platformSpu: pick(row, ['平台SPU', 'platformSpu']),
      skuId: pick(row, ['SKU ID', 'skuId']),
      skcId: pick(row, ['SKC ID', 'skcId']),
      skuCode: pick(row, ['SKU货号', 'skuCode']),
      skuName: pick(row, ['品名/SKU', 'skuName']),
      owner: '',
      status: statusText(pick(row, ['领星状态', 'lingxingStatus'])),
      storeName: pick(row, ['店铺', 'storeName']),
      area: pick(row, ['区域', 'area']),
      site: pick(row, ['站点', 'site']),
      regionGroup: pick(row, ['区域组', 'regionGroup']),
      skuRegionKey: pick(row, ['链接区域键', 'SKU区域键', 'skuRegionKey']),
      skuRegionListingCount: pick(row, ['链接区域行数', '同SKU区域链接数', 'skuRegionListingCount']),
      skuRegionActiveListingCount: pick(row, ['链接上架状态SKU数', '链接已加入站点SKU数', '同SKU区域在卖链接数', 'skuRegionActiveListingCount']),
      skuRegionAvailableQty: pick(row, ['链接同区可用库存', '同SKU区域可用库存', 'skuRegionAvailableQty']),
      skuRegionAlertRepresentative: pick(row, ['提醒代表行', 'skuRegionAlertRepresentative']),
      skuRegionLingxingStatuses: pick(row, ['链接SKU领星状态', '同SKU区域领星状态', 'skuRegionLingxingStatuses']),
      listingSkuCount: pick(row, ['链接SKU数', 'listingSkuCount']),
      listingSkuCodes: pick(row, ['链接SKU货号', 'listingSkuCodes']),
      listingStockedSkuCodes: pick(row, ['有库存SKU', 'listingStockedSkuCodes']),
      listingPriceDetails: pick(row, ['申报价/活动价', 'listingPriceDetails']),
      listingSkuInventory: pick(row, ['链接SKU库存', 'listingSkuInventory']),
      listingSkuDetails: pick(row, ['链接SKU明细', 'listingSkuDetails']),
      title: pick(row, ['标题', 'title']),
      lingxingDeclarePrice: pick(row, ['申报价', 'declarePrice']),
      lingxingDeclareCurrency: pick(row, ['申报价币种', 'declareCurrency']),
      lingxingActivityPrice: pick(row, ['活动价', 'activityPrice']),
      lingxingActivityCurrency: pick(row, ['活动价币种', 'activityCurrency']),
      inventoryMatchStatus: pick(row, ['仓库匹配状态', 'inventoryMatchStatus']),
      warehouseRegionMatchStatus: pick(row, ['仓库地区匹配', 'warehouseRegionMatchStatus']),
      warehouseSource: pick(row, ['仓库来源', 'warehouseSource']),
      warehouseSku: pick(row, ['仓库SKU', 'warehouseSku']),
      warehouse: pick(row, ['仓库', 'warehouse']),
      otherRegionWarehouse: pick(row, ['异区仓库', 'otherRegionWarehouse']),
      availableQty: pick(row, ['可用库存', 'availableQty']),
      siteMatchedAvailableQty: pick(row, ['同区可用库存', 'siteMatchedAvailableQty']),
      otherRegionAvailableQty: pick(row, ['异区可用库存', 'otherRegionAvailableQty']),
      inStockQty: pick(row, ['在库库存', 'inStockQty']),
      frozenQty: pick(row, ['冻结/待发库存', 'frozenQty']),
      onWayQty: pick(row, ['在途库存', 'onWayQty']),
      pendingQty: pick(row, ['待上架库存', 'pendingQty']),
      stockAction: pick(row, ['处理动作', 'stockAction']),
      inventoryAlertReason: pick(row, ['提醒原因', 'alertReason']),
      hasInventoryButOffShelf: pick(row, ['有库存但无在卖链接', '公司有库存但TEMU无在卖', '有库存但无在卖', '有库存但下架', 'hasInventoryButOffShelf']),
      statusCode: pick(row, ['领星状态码', 'lingxingStatusCode'])
    };
    out.storeRegion = rowStoreRegion(out);
    const ownerMatch = ownerMatchForSkuValues(
      [out.skuCode, out.listingSkuCodes, out.listingStockedSkuCodes, out.listingSkuInventory, out.listingSkuDetails],
      ownerIndex,
      [out.skuName, out.title, out.listingSkuDetails],
      out
    );
    out.owner = ownerMatch.owner;
    out.ownerStatus = ownerMatch.ownerStatus;
    out.ownerMatchType = ownerMatch.ownerMatchType;
    out.ownerMatchScore = ownerMatch.ownerMatchScore;
    out.ownerMatchText = ownerMatch.ownerMatchText;
    if (!out.statusCode) out.statusCode = statusCode(out.status);
    if (!out.stockAction) out.stockAction = stockAction(out);
    return out;
  });
}

function stockAction(row) {
  const activeCount = firstNumber(row.skuRegionActiveListingCount) || 0;
  const availableQty = firstNumber(row.skuRegionAvailableQty || row.siteMatchedAvailableQty || row.availableQty) || 0;
  if (activeCount > 0 && availableQty <= 0) return '有在卖但没可用库存';
  if (activeCount <= 0 && availableQty > 0) return '有库存但无在卖链接';
  return '正常';
}

function stockCheckType(row) {
  if (row.stockAction === '库存源异常') return '异常';
  if (row.stockAction === '有在卖但没可用库存') return '强提醒';
  if (row.stockAction === '有库存但无在卖链接') return '需处理';
  if (row.stockAction === '公司有库存但TEMU无在卖') return '需处理';
  return '正常';
}

function loadPriceData() {
  const lingxingFile = findLatestLingxingRaw(LINGXING_PRICE_BASENAME) || LINGXING_PRICE_CSV;
  const officialFile = newest(TEMU_OFFICIAL_FILES);
  const ownerFile = skuOwnerFile();
  const key = cacheKey([
    { file: lingxingFile, mtime: fileMtime(lingxingFile) },
    { file: officialFile, mtime: fileMtime(officialFile) },
    { file: ownerFile, mtime: fileMtime(ownerFile) }
  ]);
  if (priceDataCache?.key === key) return priceDataCache.data;

  const lingxing = readLingxing(LINGXING_PRICE_BASENAME, LINGXING_PRICE_CSV);
  const official = readOfficial();
  const ownerIndex = loadSkuOwnerIndex();
  const rows = matchPriceRows(lingxing.rows, official.rows, ownerIndex);
  const stores = new Set(rows.map(row => row.storeRegion).filter(Boolean));

  const data = {
    generated_at: new Date().toISOString(),
    mode: 'price',
    sources: {
      lingxing_price: lingxing.source,
      temu_official: official.source,
      sku_owner_mapping: fileInfo(skuOwnerFile())
    },
    summary: {
      lingxing_rows: lingxing.rows.length,
      lingxing_raw_rows: lingxing.stats.raw_rows,
      excluded_store_rows: lingxing.stats.excluded_store_rows,
      excluded_void_status_rows: lingxing.stats.excluded_void_status_rows,
      temu_official_rows: official.rows.length,
      merged_rows: rows.length,
      matched_rows: rows.filter(row => row.matchStatus === '标题匹配' || row.matchStatus === 'SKU匹配').length,
      unmatched_lingxing_rows: rows.filter(row => row.matchStatus === '领星未匹配官方').length,
      unmatched_official_rows: rows.filter(row => row.matchStatus === '官方未匹配领星').length,
      price_alert_rows: rows.filter(row => row.priceOver20 === '是').length,
      price_diff_rows: rows.filter(row => row.priceDiff !== '' && Number(row.priceDiff) !== 0).length,
      store_count: stores.size
    },
    rows
  };
  priceDataCache = { key, data };
  return data;
}

function loadInventoryData() {
  const ownerFile = skuOwnerFile();
  const key = cacheKey([
    { file: WAREHOUSE_INVENTORY_CSV, mtime: fileMtime(WAREHOUSE_INVENTORY_CSV) },
    { file: LINGXING_INVENTORY_CSV, mtime: fileMtime(LINGXING_INVENTORY_CSV) },
    { file: ownerFile, mtime: fileMtime(ownerFile) }
  ]);
  if (inventoryDataCache?.key === key) return inventoryDataCache.data;

  const ownerIndex = loadSkuOwnerIndex();
  const inventoryRows = normalizeInventory(readSheet(WAREHOUSE_INVENTORY_CSV), ownerIndex);
  const filteredInventory = filterLingxingRows(inventoryRows);
  const inventory = {
    rows: filteredInventory.rows,
    stats: filteredInventory.stats,
    source: fileInfo(WAREHOUSE_INVENTORY_CSV)
  };
  const stores = new Set(inventory.rows.map(row => row.storeRegion).filter(Boolean));

  const data = {
    generated_at: new Date().toISOString(),
    mode: 'inventory',
    sources: {
      warehouse_inventory: inventory.source,
      lingxing_inventory: fileInfo(LINGXING_INVENTORY_CSV),
      sku_owner_mapping: fileInfo(skuOwnerFile())
    },
    summary: {
      inventory_rows: inventory.rows.length,
      inventory_raw_rows: inventory.stats.raw_rows,
      excluded_store_rows: inventory.stats.excluded_store_rows,
      excluded_void_status_rows: inventory.stats.excluded_void_status_rows,
      inventory_alert_rows: inventory.rows.filter(row => stockCheckType(row) === '强提醒' || stockCheckType(row) === '异常').length,
      has_inventory_but_off_shelf_rows: inventory.rows.filter(row => row.hasInventoryButOffShelf === '是').length,
      action_required_rows: inventory.rows.filter(row => stockCheckType(row) === '需处理').length,
      no_active_listing_with_stock_rows: inventory.rows.filter(row => row.stockAction === '有库存但无在卖链接').length,
      active_listing_no_available_stock_rows: inventory.rows.filter(row => row.stockAction === '有在卖但没可用库存').length,
      other_region_stock_rows: inventory.rows.filter(row => row.warehouseRegionMatchStatus === '其他区域有库存').length,
      store_count: stores.size
    },
    rows: inventory.rows
  };
  inventoryDataCache = { key, data };
  return data;
}

function loadDashboardData(mode = 'price') {
  return mode === 'inventory' ? loadInventoryData() : loadPriceData();
}

module.exports = {
  APP_DIR,
  INPUT_DIR,
  DATA_DIR,
  MODULE_DIR,
  buildSkuOwnerIndexFromFile,
  fileInfo,
  loadDashboardData,
  loadInventoryData,
  loadPriceData,
  normalizeKey,
  normalizeText,
  ownerMatchForSkuValues,
  skuOwnerFile,
  csvParse
};
