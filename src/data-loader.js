const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
  extractImageUrl,
  hydrateImageHashes,
  imageHashSimilarity,
  urlFingerprintSimilarity
} = require('./image-hash');
const { translatePriceMatchingTitles } = require('./translation');

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
const WAREHOUSE_INVENTORY_XLSX = path.join(WAREHOUSE_DATA_DIR, 'warehouse_inventory_latest.xlsx');
const DEFAULT_BACKEND_EXPORT_DIR = path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', 'Desktop', 'Ziniao_TEMU_Export_Output');
const DEFAULT_BACKEND_EXPORT_FILE = path.join(DEFAULT_BACKEND_EXPORT_DIR, 'TEMU_Product_Data.xlsx');
const STATIC_SKU_OWNER_FILES = [
  path.join(APP_DIR, 'input', '平台SKU_1781161550125.xlsx'),
  path.join(APP_DIR, 'input', 'SKU-运营映射表.xlsx'),
  path.join(INPUT_DIR, 'SKU-运营映射表.xlsx')
];
const TEMU_OFFICIAL_FILES = [
  path.join(DATA_DIR, 'temu_official_products.csv'),
  path.join(DATA_DIR, 'temu_official_products.json')
];
const PRICE_MATCH_STATUSES = new Set(['图片匹配', '标题匹配', '标题模糊匹配', '翻译标题匹配', '店铺标题弱匹配']);
const STRICT_TITLE_MATCH_THRESHOLD = 0.85;
const SAME_STORE_WEAK_TITLE_MATCH_THRESHOLD = 0.5;
const BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD = Number(process.env.BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD || 0.45);
const BACKEND_OFFICIAL_TRANSLATED_TITLE_MATCH_THRESHOLD = Number(process.env.BACKEND_OFFICIAL_TRANSLATED_TITLE_MATCH_THRESHOLD || 0.40);
const PRICE_IMAGE_MATCH_THRESHOLD = Number(process.env.PRICE_IMAGE_MATCH_THRESHOLD || 90);
const PRICE_TITLE_AMBIGUITY_GAP = Number(process.env.PRICE_TITLE_AMBIGUITY_GAP || 0.08);
const PRICE_TITLE_AMBIGUITY_STRICT_BELOW = Number(process.env.PRICE_TITLE_AMBIGUITY_STRICT_BELOW || STRICT_TITLE_MATCH_THRESHOLD);
const PRICE_TITLE_MIN_LENGTH_RATIO = Number(process.env.PRICE_TITLE_MIN_LENGTH_RATIO || 0.50);
const PRICE_TRANSLATED_TITLE_MIN_LENGTH_RATIO = Number(process.env.PRICE_TRANSLATED_TITLE_MIN_LENGTH_RATIO || 0.40);
const PRICE_TITLE_MAX_LENGTH_DIFF = Number(process.env.PRICE_TITLE_MAX_LENGTH_DIFF || 24);
const PRICE_TRANSLATED_TITLE_MAX_LENGTH_DIFF = Number(process.env.PRICE_TRANSLATED_TITLE_MAX_LENGTH_DIFF || 36);
const FUZZY_TITLE_MIN_KEY_LENGTH = 24;
const TRANSLATED_TITLE_MIN_KEY_LENGTH = 8;
const TRANSLATED_TITLE_MIN_TOKEN_OVERLAP = Number(process.env.TRANSLATED_TITLE_MIN_TOKEN_OVERLAP || 0.16);
const BACKEND_UNMATCHED_OFFICIAL_STATUS = '后台未匹配前端';
const OFFICIAL_UNMATCHED_BACKEND_STATUS = '前端未匹配后台';
const NORMAL_PRICE_SPREAD_STATUS = '正常价差';
const TITLE_TOKEN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'without', 'from', 'into', 'onto', 'your', 'this', 'that',
  'pcs', 'piece', 'pieces', 'pack', 'set', 'sets', 'bulk', 'heavy', 'duty', 'universal',
  'adjustable', 'foldable', 'portable', 'suitable', 'used', 'use', 'home', 'outdoor', 'indoor',
  'large', 'small', 'black', 'white', 'gray', 'grey', 'blue', 'green', 'red', 'cm', 'inch',
  'inches', 'feet', 'ft', 'mm', 'meter', 'metre', 'high', 'height', 'stand', 'holder',
  '架', '支架', '套装', '适用', '用于', '可调', '调节', '折叠', '户外', '室内', '黑色',
  '白色', '灰色', '大型', '小型', '通用'
]);
const MALL_ID_TO_STORE_NAME = new Map([
  ['634418219290009', 'YYcareU'],
  ['634418228142942', 'Drevalora'],
  ['634418225384418', 'VastOrigin'],
  ['634418215126235', 'uyoyous'],
  ['634418219730772', 'Ruralityro']
]);
const DEFAULT_FX_USD_RATES = {
  USD: 1,
  GBP: 1.3245,
  EUR: 1.1406,
  CNY: 0.1472,
  RMB: 0.1472
};
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

function newestRecursiveXlsx(dir, depth = 2) {
  if (!dir || !fs.existsSync(dir)) return '';
  const files = [];
  const visit = (currentDir, currentDepth) => {
    if (currentDepth > depth || !fs.existsSync(currentDir)) return;
    for (const name of fs.readdirSync(currentDir)) {
      const full = path.join(currentDir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        visit(full, currentDepth + 1);
      } else if (/\.xlsx$/i.test(name) && !name.startsWith('~$')) {
        files.push(full);
      }
    }
  };
  visit(dir, 0);
  return newest(files);
}

function findBackendExportFile() {
  const configuredFile = String(process.env.TEMU_BACKEND_EXPORT_FILE || '').trim();
  if (configuredFile && fs.existsSync(configuredFile)) return configuredFile;
  if (fs.existsSync(DEFAULT_BACKEND_EXPORT_FILE)) return DEFAULT_BACKEND_EXPORT_FILE;

  const configuredDir = String(process.env.TEMU_BACKEND_EXPORT_DIR || '').trim();
  return newestRecursiveXlsx(configuredDir || DEFAULT_BACKEND_EXPORT_DIR);
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

function normalizeMallId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const queryMatch = text.match(/mall[\s_-]*id\s*=\s*(\d+)/i);
  if (queryMatch) return queryMatch[1];
  const digits = text.match(/\d{8,}/);
  return digits ? digits[0] : '';
}

function goodsIdFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const queryMatch = text.match(/goods[\s_-]*id\s*=\s*(\d+)/i);
  if (queryMatch) return queryMatch[1];
  const digits = text.match(/\d{8,}/);
  return digits ? digits[0] : '';
}

function storeNameForMallId(value) {
  return MALL_ID_TO_STORE_NAME.get(normalizeMallId(value)) || '';
}

function canonicalStoreDisplayName(value) {
  const key = normalizeKey(value);
  if (!key) return '';
  for (const name of MALL_ID_TO_STORE_NAME.values()) {
    if (normalizeKey(name) === key) return name;
  }
  return '';
}

function regionalStoreDisplayName(storeName, regionLabel) {
  const source = String(storeName || '').trim();
  if (!source || !regionLabel) return source;
  const sourceKey = normalizeKey(source);
  const knownNames = [
    ...MALL_ID_TO_STORE_NAME.values(),
    'Drevalora-EU', 'Drevalora-美，全球',
    'Ruralityro-EU', 'Ruralityro-美，全球',
    'uyoyous-欧区', 'uyoyous-美，全球',
    'VastOrigin 欧区', 'VastOrigin-美，全球',
    'YYcareU-欧区', 'YYcareU-美，全球'
  ];
  const known = knownNames.find(name => normalizeKey(name) === sourceKey);
  if (known && known !== canonicalStoreDisplayName(known)) return known;
  const brand = canonicalStoreDisplayName(source) || source;
  if (!brand || !regionLabel) return brand;
  const byBrand = {
    Drevalora: { '欧区': 'Drevalora-EU', '美国/Global': 'Drevalora-美，全球' },
    Ruralityro: { '欧区': 'Ruralityro-EU', '美国/Global': 'Ruralityro-美，全球' },
    uyoyous: { '欧区': 'uyoyous-欧区', '美国/Global': 'uyoyous-美，全球' },
    VastOrigin: { '欧区': 'VastOrigin 欧区', '美国/Global': 'VastOrigin-美，全球' },
    YYcareU: { '欧区': 'YYcareU-欧区', '美国/Global': 'YYcareU-美，全球' }
  };
  return byBrand[brand]?.[regionLabel] || `${brand}${regionLabel === '欧区' ? '-EU' : '-美，全球'}`;
}

function canonicalStoreName(row = {}) {
  const mapped = storeNameForMallId(row.mallId || row.mall_id || row.mallID || row.officialUrl || row.url);
  return mapped || String(row.storeName || row.store || row.mallName || row.mall_name || '').trim();
}

function storeIdentityTokens(row = {}) {
  const values = [
    canonicalStoreName(row),
    row.storeName,
    row.store,
    row.mallName,
    storeNameForMallId(row.mallId || row.mall_id || row.officialUrl || row.url)
  ];
  const tokens = [];
  for (const value of values) {
    const source = String(value || '').trim();
    if (!source) continue;
    const clean = source
      .split(/\s+\/\s+/)[0]
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[-_\s]*(美[，,]?\s*全球|美国\s*\/?\s*global|欧区|欧洲|EU|AM|QT)\s*$/i, '')
      .trim();
    tokens.push(clean, clean.split(/[-_\s]+/)[0], source);
  }
  return [...new Set(tokens.map(normalizeKey).filter(Boolean))];
}

function storeCompatible(left = {}, right = {}) {
  const leftTokens = storeIdentityTokens(left);
  const rightTokens = storeIdentityTokens(right);
  if (!leftTokens.length || !rightTokens.length) return true;
  return leftTokens.some(leftToken =>
    rightTokens.some(rightToken => leftToken === rightToken || leftToken.includes(rightToken) || rightToken.includes(leftToken))
  );
}

function storeStrictlyCompatible(left = {}, right = {}) {
  const leftTokens = storeIdentityTokens(left);
  const rightTokens = storeIdentityTokens(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  return leftTokens.some(leftToken =>
    rightTokens.some(rightToken => leftToken === rightToken || leftToken.includes(rightToken) || rightToken.includes(leftToken))
  );
}

const EU_SITE_CODES = new Set([
  'AT', 'BE', 'BG', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK', 'UK'
]);
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

function regionGroupLabel(row = {}) {
  const group = rowRegionGroup(row);
  if (group === 'eu') return '欧区';
  if (group === 'global') return '美国/Global';
  return String(row.regionGroup || '').trim();
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

function firstImageUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const urlMatch = text.match(/https?:\/\/[^\s"',，；;]+/i);
  if (urlMatch) return urlMatch[0];
  return text.split(/[；;,，\n\r]+/).map(item => item.trim()).filter(Boolean)[0] || '';
}

function decodeImageText(value) {
  const text = firstImageUrl(value);
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalizedImageUrl(value) {
  const text = decodeImageText(value)
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/[?#].*$/g, '')
    .replace(/\/+$/g, '');
  return text;
}

function imageBasename(value) {
  const normalized = normalizedImageUrl(value);
  if (!normalized) return '';
  const last = normalized.split('/').filter(Boolean).pop() || '';
  return last.replace(/\.(jpg|jpeg|png|webp|gif|avif|bmp)$/i, '');
}

function imageIdTokens(value) {
  const text = normalizedImageUrl(value)
    .replace(/\.(jpg|jpeg|png|webp|gif|avif|bmp)$/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ');
  return [...new Set((text.match(/[a-z0-9]{10,}/gi) || [])
    .map(item => item.toLowerCase())
    .filter(item => !/^(thumbnail|image|images|product|goods|mainimage)$/.test(item)))];
}

function imageSimilarityScore(left, right) {
  return urlFingerprintSimilarity(left, right, diceSimilarity);
}

function imageSimilarityForRows(row = {}, official = {}) {
  const hashScore = imageHashSimilarity(row.imageHash || row.lingxingImageHash, official.imageHash || official.officialImageHash);
  if (hashScore > 0) return hashScore;
  return imageSimilarityScore(row.lingxingImage || row.image, official.officialImage || official.image);
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

function skuKeysForOwnerMatch(sku, { includeExact = true, includePrefix = true } = {}) {
  return [
    includeExact ? normalizeKey(sku) : '',
    includePrefix ? skuPrefix(sku) : ''
  ].filter(Boolean);
}

function collectOwnersByStoreSku(skuValues, ownerIndex, rowContext = {}, keyOptions = {}) {
  const owners = [];
  const seen = new Set();
  const storeTokens = rowStoreTokens(rowContext);
  if (!storeTokens.length) return owners;
  const region = rowRegionGroup(rowContext);
  for (const value of skuValues) {
    for (const sku of extractSkuCodes(value)) {
      const skuKeys = skuKeysForOwnerMatch(sku, keyOptions);
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

function collectOwnersByRegionSku(skuValues, ownerIndex, rowContext = {}, keyOptions = {}) {
  const owners = [];
  const seen = new Set();
  const region = rowRegionGroup(rowContext);
  if (!region) return owners;
  for (const value of skuValues) {
    for (const sku of extractSkuCodes(value)) {
      const skuKeys = skuKeysForOwnerMatch(sku, keyOptions);
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

  const storeSkuOwners = collectOwnersByStoreSku(skuValues, ownerIndex, rowContext, { includePrefix: false });
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

  const regionSkuOwners = collectOwnersByRegionSku(skuValues, ownerIndex, rowContext, { includePrefix: false });
  if (regionSkuOwners.length) {
    const result = ownerCandidateResult(regionSkuOwners, '区域SKU');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const storeSkuPrefixOwners = collectOwnersByStoreSku(skuValues, ownerIndex, rowContext, { includeExact: false });
  if (storeSkuPrefixOwners.length) {
    const result = ownerCandidateResult(storeSkuPrefixOwners, '店铺SKU前缀');
    ownerIndex.ownerMatchCache.set(matchCacheKey, result);
    return result;
  }

  const regionSkuPrefixOwners = collectOwnersByRegionSku(skuValues, ownerIndex, rowContext, { includeExact: false });
  if (regionSkuPrefixOwners.length) {
    const result = ownerCandidateResult(regionSkuPrefixOwners, '区域SKU前缀');
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
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const source = String(value || '').replace(/\u00a0/g, ' ');
  const match = source.match(/-?\d[\d\s.,]*/);
  if (!match) return null;

  let numberText = match[0].replace(/\s+/g, '');
  const commaIndex = numberText.lastIndexOf(',');
  const dotIndex = numberText.lastIndexOf('.');

  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    numberText = numberText.split(thousandsSeparator).join('');
    if (decimalSeparator === ',') numberText = numberText.replace(',', '.');
  } else if (commaIndex >= 0) {
    const parts = numberText.split(',');
    const last = parts[parts.length - 1];
    if (parts.length === 2 && last.length > 0 && last.length <= 2) {
      numberText = `${parts[0]}.${last}`;
    } else if (parts.length > 2 && last.length > 0 && last.length <= 2) {
      numberText = `${parts.slice(0, -1).join('')}.${last}`;
    } else {
      numberText = parts.join('');
    }
  } else if ((numberText.match(/\./g) || []).length > 1) {
    const parts = numberText.split('.');
    const last = parts[parts.length - 1];
    numberText = last.length > 0 && last.length <= 2
      ? `${parts.slice(0, -1).join('')}.${last}`
      : parts.join('');
  }

  const parsed = Number(numberText);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeCurrencyCode(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  if (/美元|美金/.test(text)) return 'USD';
  if (/欧元|歐元/.test(text)) return 'EUR';
  if (/英镑|英鎊/.test(text)) return 'GBP';
  if (/人民币|人民幣/.test(text)) return 'CNY';
  if (text === '￥' || text === '¥' || text === 'RMB' || text === 'CN¥') return 'CNY';
  if (text === 'US$' || text === '$') return 'USD';
  if (text === '£') return 'GBP';
  if (text === '€') return 'EUR';
  const match = text.match(/[A-Z]{3}/);
  return match ? match[0] : text;
}

function normalizeSiteCode(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const text = source.toLowerCase();
  if (/英国|英國|united\s*kingdom|great\s*britain|\buk\b|\bgb\b/.test(text)) return 'GB';
  if (/美国|美國|美区|美站|全球|united\s*states|\busa\b|\bus\b|global/.test(text)) return 'US';
  if (/澳大利亚|澳大利亞|澳洲|australia|\bau\b/.test(text)) return 'AU';
  if (/加拿大|canada|\bca\b/.test(text)) return 'CA';
  if (/日本|japan|\bjp\b/.test(text)) return 'JP';
  if (/德国|德國|germany|deutschland|\bde\b/.test(text)) return 'DE';
  if (/法国|法國|france|\bfr\b/.test(text)) return 'FR';
  if (/意大利|italy|\bit\b/.test(text)) return 'IT';
  if (/西班牙|spain|\bes\b/.test(text)) return 'ES';
  if (/荷兰|荷蘭|netherlands|\bnl\b/.test(text)) return 'NL';
  if (/比利时|比利時|belgium|\bbe\b/.test(text)) return 'BE';
  if (/奥地利|奧地利|austria|\bat\b/.test(text)) return 'AT';
  if (/爱尔兰|愛爾蘭|ireland|\bie\b/.test(text)) return 'IE';
  if (/波兰|波蘭|poland|\bpl\b/.test(text)) return 'PL';
  if (/葡萄牙|portugal|\bpt\b/.test(text)) return 'PT';
  if (/匈牙利|hungary|\bhu\b/.test(text)) return 'HU';
  if (/罗马尼亚|羅馬尼亞|romania|\bro\b/.test(text)) return 'RO';
  if (/斯洛伐克|slovakia|\bsk\b/.test(text)) return 'SK';
  if (/保加利亚|保加利亞|bulgaria|\bbg\b/.test(text)) return 'BG';
  if (/马耳他|馬耳他|malta|\bmt\b/.test(text)) return 'MT';
  if (/卢森堡|盧森堡|luxembourg|\blu\b/.test(text)) return 'LU';
  if (/芬兰|芬蘭|finland|\bfi\b/.test(text)) return 'FI';
  if (/丹麦|丹麥|denmark|\bdk\b/.test(text)) return 'DK';
  if (/希腊|希臘|greece|\bgr\b/.test(text)) return 'GR';
  if (/克罗地亚|克羅地亞|croatia|\bhr\b/.test(text)) return 'HR';
  if (/斯洛文尼亚|斯洛文尼亞|slovenia|\bsi\b/.test(text)) return 'SI';
  if (/立陶宛|lithuania|\blt\b/.test(text)) return 'LT';
  if (/拉脱维亚|拉脫維亞|latvia|\blv\b/.test(text)) return 'LV';
  if (/爱沙尼亚|愛沙尼亞|estonia|\bee\b/.test(text)) return 'EE';
  if (/瑞典|sweden|\bse\b/.test(text)) return 'SE';
  if (/捷克|czech|\bcz\b/.test(text)) return 'CZ';
  if (/欧区|歐區|欧洲|歐洲|\beu\b/.test(text)) return 'EU';
  const compact = source.replace(/[^a-zA-Z]/g, '').toUpperCase();
  if (compact === 'UK') return 'GB';
  if (/^[A-Z]{2}$/.test(compact)) return compact;
  const codeMatch = source.toUpperCase().match(/\b([A-Z]{2})\b/);
  if (!codeMatch) return '';
  return codeMatch[1] === 'UK' ? 'GB' : codeMatch[1];
}

function splitSiteText(value) {
  return String(value || '')
    .split(/[\/|,，;；、\n\r]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function broadSiteType(value) {
  const text = String(value || '').toLowerCase();
  if (/欧区|歐區|欧洲|歐洲|\beu\b/.test(text)) return 'eu';
  if (/全球|global|美[，,]?\s*全球|美国\s*\/?\s*global|美國\s*\/?\s*global|\bam\b|\bqt\b/.test(text)) return 'global';
  return '';
}

function siteEntriesFromValue(value, exactSource = true) {
  const parts = splitSiteText(value);
  const values = parts.length ? parts : [String(value || '').trim()].filter(Boolean);
  return values
    .map(part => {
      const broad = broadSiteType(part) || broadSiteType(value);
      const code = normalizeSiteCode(part);
      return {
        code,
        broad,
        exact: Boolean(exactSource && code && code !== 'EU' && !broad)
      };
    })
    .filter(item => item.code);
}

function siteEntriesForRow(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const useOfficialSite = row.source === 'official' || row.sourceSide === 'TEMU官方';
  const explicit = pickByNormalizedHeader(raw, [
    '前端站点',
    '前台站点',
    'TEMU站点',
    '官方站点',
    '价格站点',
    '站点信息',
    '站点名称',
    '国家名称',
    '国家代码',
    'siteName',
    'countryName',
    'countryCode'
  ]);
  const exactValues = [
    useOfficialSite ? row.officialSite : '',
    row.site,
    row.backendPriceSite,
    explicit
  ];
  const broadValues = [
    row.backendOperatingSites,
    row.area,
    row.region,
    row.regionGroup,
    row.storeRegion
  ];
  const exactEntries = [];
  for (const value of exactValues) {
    exactEntries.push(...siteEntriesFromValue(value, true));
  }
  const valuesByPrecision = exactEntries.some(entry => entry.exact)
    ? [exactEntries]
    : [exactEntries, broadValues.flatMap(value => siteEntriesFromValue(value, false))];
  const seen = new Set();
  const entries = [];
  for (const valueEntries of valuesByPrecision) {
    for (const entry of valueEntries) {
      const key = `${entry.code}:${entry.broad}:${entry.exact ? '1' : '0'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

function exactSiteEntriesForRow(row = {}) {
  return siteEntriesForRow(row).filter(entry => entry.exact);
}

function hasSiteEvidence(row = {}) {
  return siteEntriesForRow(row).length > 0;
}

function hasExactSiteConflict(left = {}, right = {}) {
  const leftSites = exactSiteEntriesForRow(left);
  const rightSites = exactSiteEntriesForRow(right);
  if (!leftSites.length || !rightSites.length) return false;
  return !leftSites.some(leftSite => rightSites.some(rightSite => siteEntryCompatible(leftSite, rightSite)));
}

function siteEntryCompatible(left, right) {
  if (!left?.code || !right?.code) return true;
  if (left.code === right.code) return true;
  if ((left.code === 'EU' && EU_SITE_CODES.has(right.code)) || (right.code === 'EU' && EU_SITE_CODES.has(left.code))) return true;
  if ((left.broad === 'eu' && EU_SITE_CODES.has(right.code)) || (right.broad === 'eu' && EU_SITE_CODES.has(left.code))) return true;
  if ((left.broad === 'global' && right.code === 'US') || (right.broad === 'global' && left.code === 'US')) return true;
  return false;
}

function siteCompatible(left = {}, right = {}) {
  const leftSites = siteEntriesForRow(left);
  const rightSites = siteEntriesForRow(right);
  if (!leftSites.length || !rightSites.length) return true;
  return leftSites.some(leftSite => rightSites.some(rightSite => siteEntryCompatible(leftSite, rightSite)));
}

function storeAndSiteCompatible(left = {}, right = {}) {
  return storeCompatible(left, right) && hasSiteEvidence(left) && hasSiteEvidence(right) && siteCompatible(left, right);
}

function storeAndSiteStrictlyCompatible(left = {}, right = {}) {
  return storeStrictlyCompatible(left, right) && hasSiteEvidence(left) && hasSiteEvidence(right) && siteCompatible(left, right);
}

function storeFallbackCompatible(left = {}, right = {}) {
  return storeCompatible(left, right) && !hasExactSiteConflict(left, right);
}

function storeFallbackStrictlyCompatible(left = {}, right = {}) {
  return storeStrictlyCompatible(left, right) && !hasExactSiteConflict(left, right);
}

function matchScopeCompatible(scope, left = {}, right = {}) {
  return scope === 'store' ? storeFallbackCompatible(left, right) : storeAndSiteCompatible(left, right);
}

function matchScopeStrictlyCompatible(scope, left = {}, right = {}) {
  return scope === 'store' ? storeFallbackStrictlyCompatible(left, right) : storeAndSiteStrictlyCompatible(left, right);
}

function currencyFromPriceText(value) {
  const text = String(value || '').trim();
  if (/£|\bGBP\b|英镑|英鎊/i.test(text)) return 'GBP';
  if (/€|\bEUR\b|欧元|歐元/i.test(text)) return 'EUR';
  if (/US\$|\$|\bUSD\b|美元|美金/i.test(text)) return 'USD';
  if (/CN¥|￥|¥|\bCNY\b|\bRMB\b|人民币|人民幣/i.test(text)) return 'CNY';
  return '';
}

function siteFromCurrency(currency) {
  const code = normalizeCurrencyCode(currency);
  if (code === 'GBP') return 'GB';
  if (code === 'USD') return 'US';
  if (code === 'EUR') return 'EU';
  if (code === 'CNY') return 'CN';
  return '';
}

function frontendSiteFromRow(row = {}, currency = '', priceText = '') {
  const explicit =
    pickByNormalizedHeader(row, [
      '前端站点',
      '前台站点',
      'TEMU站点',
      '官方站点',
      '价格站点',
      '站点信息',
      '站点名称',
      '站点',
      '国家',
      '国家名称',
      '国家代码',
      'frontendSite',
      'officialSite',
      'site',
      'siteName',
      'country',
      'countryName',
      'countryCode',
      'region'
    ]) ||
    pick(row, [
      '前端站点',
      '前台站点',
      'TEMU站点',
      '官方站点',
      '价格站点',
      '站点信息',
      '站点名称',
      '站点',
      '国家',
      '国家名称',
      '国家代码',
      'frontendSite',
      'officialSite',
      'site',
      'siteName',
      'country',
      'countryName',
      'countryCode',
      'region'
    ]);
  const explicitCode = normalizeSiteCode(explicit);
  const currencySite = siteFromCurrency(currency || currencyFromPriceText(priceText));
  if (explicitCode && explicitCode !== 'EU') return explicitCode;
  return currencySite || explicitCode;
}

function currencyFromSite(row = {}) {
  const text = [row.officialSite, row.site, row.area, row.region, row.storeRegion, row.officialUrl]
    .map(value => String(value || ''))
    .join(' ');
  if (/英国|英國|\bUK\b|\bGB\b|united\s*kingdom|great\s*britain/i.test(text)) return 'GBP';
  if (/德国|德國|\bDE\b|germany|deutschland|\bFR\b|\bIT\b|\bES\b|\bNL\b|\bBE\b|\bAT\b|\bIE\b|\bEU\b|欧区|欧洲/i.test(text)) return 'EUR';
  if (/美国|美区|全球|\bUS\b|\bAM\b|\bQT\b|global/i.test(text)) return 'USD';
  return '';
}

function configuredFxUsdRates() {
  const raw = String(process.env.PRICE_FX_USD_RATES || '').trim();
  if (!raw) return DEFAULT_FX_USD_RATES;
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FX_USD_RATES, ...Object.fromEntries(Object.entries(parsed).map(([key, value]) => [normalizeCurrencyCode(key), Number(value)])) };
  } catch {
    const entries = raw
      .split(/[;,，]/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => item.split(/[:=]/).map(part => part.trim()))
      .filter(parts => parts.length === 2 && normalizeCurrencyCode(parts[0]) && Number.isFinite(Number(parts[1])))
      .map(([key, value]) => [normalizeCurrencyCode(key), Number(value)]);
    return { ...DEFAULT_FX_USD_RATES, ...Object.fromEntries(entries) };
  }
}

function convertCurrency(value, fromCurrency, toCurrency) {
  const amount = Number(value);
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  if (!Number.isFinite(amount)) return { value: null, rate: null, error: '金额无效' };
  if (!from || !to || from === to) return { value: amount, rate: 1, error: '' };
  const rates = configuredFxUsdRates();
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    return { value: null, rate: null, error: `缺少汇率 ${from}->${to}` };
  }
  return {
    value: amount * fromRate / toRate,
    rate: fromRate / toRate,
    error: ''
  };
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
  return value === '在售' || value === '在售中' || value === '已上架' || value === '已加入站点';
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
        image: extractImageUrl(item.image_url || product.image_url || ''),
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
      image: extractImageUrl(pick(row, ['图片', 'image', 'image_url', '商品字段.image_url', '主图', 'main_image', 'thumbnail'])),
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
  return rows.map(row => {
    const title = pick(row, ['标题', '商品标题', 'title', 'product_title', 'productName', 'listing_title']);
    const officialUrl = pick(row, ['链接', 'url', 'product_url', 'goods_url']);
    const rawMallId = pick(row, ['店铺ID', 'mall_id', 'mallId']);
    const mallId = normalizeMallId(rawMallId || officialUrl);
    const rawGoodsId = pick(row, ['商品ID', 'goods_id', 'goodsId', 'product_id']);
    const goodsId = rawGoodsId || goodsIdFromValue(officialUrl);
    const storeName = pick(row, ['店铺', '店铺名', 'store', 'store_name', 'seller_name', 'mall_name']) || storeNameForMallId(mallId);
    const officialPrice = pick(row, ['TEMU价格', '官方价格', '价格', 'price', 'sale_price']);
    const officialCurrency = normalizeCurrencyCode(pick(row, ['币种', 'currency', 'currency_code']) || currencyFromPriceText(officialPrice));
    const officialSite = frontendSiteFromRow(row, officialCurrency, officialPrice);
    const translatedTitles = [
      pick(row, ['中文标题', '翻译标题', '标题翻译', '商品中文标题', '商品标题中文', 'title_cn', 'cn_title', 'translated_title', 'translatedTitle']),
      pick(row, ['英文标题', '商品英文标题', '商品标题英文', 'title_en', 'en_title'])
    ].filter(Boolean);
    const altTitles = [title, ...translatedTitles].filter(Boolean);
    return {
      source: 'official',
      image: extractImageUrl(pick(row, ['图片', '图片链接', '图片URL', '前端图片', '前端图片链接', '前端图片URL', 'TEMU图片', 'TEMU图片链接', 'TEMU图片URL', '官方图片', '官方图片链接', '官方图片URL', 'image', 'image_url', 'imageUrl', 'img', 'img_url', 'imgUrl', '主图', 'main_image', 'mainImage', 'thumbnail', 'thumb', 'cover'])),
      imageHash: pick(row, ['图片哈希', 'imageHash', 'image_hash']),
      title,
      altTitles,
      translatedTitles,
      skuCode: pick(row, ['SKU', 'SKU货号', 'sku', 'skuCode', 'seller_sku']),
      skuName: pick(row, ['品名', '本地品名', 'sku_name', 'local_name']),
      storeName,
      area: pick(row, ['区域', 'area', 'region']),
      site: pick(row, ['站点', 'site']) || officialSite,
      officialSite,
      mallId,
      goodsId,
      officialPrice,
      officialCurrency,
      officialUrl,
      raw: row
    };
  });
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

function backendStoreNameFromFile(file) {
  const base = path.basename(file || '', path.extname(file || '')).trim();
  if (!base || /^temu[_\s-]*product[_\s-]*data$/i.test(base)) return '';
  return base
    .replace(/[_\s-]*(all|全部|全量|商品基础信息|product[_\s-]*data)$/i, '')
    .replace(/[_\s-]+$/g, '')
    .trim();
}

function backendStatusCode(status) {
  const value = String(status || '').trim();
  if (/在售|已加入站点|已发布|上架/.test(value)) return '12';
  if (/未发布|下架|终止|作废/.test(value)) return '13';
  return statusCode(value);
}

function isBackendActive(row = {}) {
  return /在售|已加入站点|已发布|上架/.test(String(row.backendProductStatus || row.status || ''));
}

function isBackendPriceActive(row = {}) {
  return /在售/.test(String(row.backendProductStatus || row.status || ''));
}

function backendRegionGroup(site) {
  const code = normalizeSiteCode(site);
  return EU_SITE_CODES.has(code) || code === 'EU' ? '欧区' : '美国/Global';
}

function normalizeBackendExport(rows, sourceFile) {
  const inferredStore = backendStoreNameFromFile(sourceFile);
  return rows
    .map((row, index) => {
      const platformSpu =
        pickByNormalizedHeader(row, ['SPU ID', 'SPUID', '平台SPU', 'spu_id']) ||
        pick(row, ['SPU ID', '平台SPU', 'spu_id']);
      const skuCode =
        pickByNormalizedHeader(row, ['SKU货号', 'SKU', 'seller_sku', '平台SKU']) ||
        pick(row, ['SKU货号', 'SKU', 'seller_sku', '平台SKU']);
      const skuId =
        pickByNormalizedHeader(row, ['SKU ID', 'SKUID', 'sku_id']) ||
        pick(row, ['SKU ID', 'sku_id']);
      const skcId =
        pickByNormalizedHeader(row, ['SKC ID', 'SKCID', 'skc_id']) ||
        pick(row, ['SKC ID', 'skc_id']);
      const title =
        pickByNormalizedHeader(row, ['商品标题', '标题', 'title', 'product_title']) ||
        pick(row, ['商品标题', '标题', 'title', 'product_title']);
      const translatedTitle =
        pickByNormalizedHeader(row, ['中文标题', '翻译标题', '标题翻译', '商品中文标题', '商品标题中文', 'title_cn', 'cn_title', 'translated_title', 'translatedTitle']) ||
        pick(row, ['中文标题', '翻译标题', '标题翻译', '商品中文标题', '商品标题中文', 'title_cn', 'cn_title', 'translated_title', 'translatedTitle']);
      const englishTitle =
        pickByNormalizedHeader(row, ['英文标题', '商品英文标题', '商品标题英文', 'title_en', 'en_title']) ||
        pick(row, ['英文标题', '商品英文标题', '商品标题英文', 'title_en', 'en_title']);
      const priceSite =
        pickByNormalizedHeader(row, ['申报价格站点', '价格站点', '站点', 'site']) ||
        pick(row, ['申报价格站点', '价格站点', '站点', 'site']);
      const operatingSites =
        pickByNormalizedHeader(row, ['经营站点', '销售站点', '站点列表']) ||
        pick(row, ['经营站点', '销售站点', '站点列表']);
      const siteName = priceSite || operatingSites;
      const site = normalizeSiteCode(siteName);
      const mallId =
        pickByNormalizedHeader(row, ['Mall ID', '店铺ID', 'mall_id', 'mallId']) ||
        pick(row, ['Mall ID', '店铺ID', 'mall_id', 'mallId']);
      const brandName =
        pickByNormalizedHeader(row, ['品牌', 'brand']) ||
        pick(row, ['品牌', 'brand']);
      const rawStoreName =
        pickByNormalizedHeader(row, ['紫鸟店铺', '店铺', '店铺名', 'store', 'store_name']) ||
        pick(row, ['紫鸟店铺', '店铺', '店铺名', 'store', 'store_name']) ||
        inferredStore;
      const storeName =
        storeNameForMallId(mallId) ||
        canonicalStoreDisplayName(brandName) ||
        rawStoreName;
      const productStatus =
        pickByNormalizedHeader(row, ['商品状态', '状态', 'status']) ||
        pick(row, ['商品状态', '状态', 'status']);
      const declarePrice =
        pickByNormalizedHeader(row, ['申报价格(USD)', '申报价格USD', '申报价USD', '申报价格', '申报价']) ||
        pick(row, ['申报价格(USD)', '申报价格USD', '申报价USD', '申报价格', '申报价']);
      const declarePriceStatus =
        pickByNormalizedHeader(row, ['申报价格状态', '核价状态', '价格状态']) ||
        pick(row, ['申报价格状态', '核价状态', '价格状态']);
      return {
        source: 'backend',
        backendRowIndex: index,
        backendSourceFile: sourceFile,
        backendProductStatus: productStatus,
        backendDeclarePriceStatus: declarePriceStatus,
        backendOperatingSites: operatingSites,
        backendPriceSite: priceSite,
        backendOriginalStoreName: rawStoreName,
        mallId: normalizeMallId(mallId),
        backendInventoryQty:
          pickByNormalizedHeader(row, ['库存', 'inventory', 'stock']) ||
          pick(row, ['库存', 'inventory', 'stock']),
        backendCreatedAt:
          pickByNormalizedHeader(row, ['创建时间', 'created_at', 'createdAt']) ||
          pick(row, ['创建时间', 'created_at', 'createdAt']),
        backendSpecText: [
          pickByNormalizedHeader(row, ['规格1名称']) || pick(row, ['规格1名称']),
          pickByNormalizedHeader(row, ['规格2名称']) || pick(row, ['规格2名称'])
        ].filter(Boolean).join('；'),
        image: extractImageUrl(
          pickByNormalizedHeader(row, ['图片', '图片链接', '图片URL', '主图', 'main_image', 'image', 'image_url', 'imageUrl']) ||
          pick(row, ['图片', '图片链接', '图片URL', '主图', 'main_image', 'image', 'image_url', 'imageUrl'])
        ),
        platformSpu: String(platformSpu || '').trim(),
        skuId: String(skuId || '').trim(),
        skcId: String(skcId || '').trim(),
        skuCode: String(skuCode || '').trim(),
        skuName:
          pickByNormalizedHeader(row, ['SKC货号', '品名/SKU', '品名', 'skuName']) ||
          pick(row, ['SKC货号', '品名/SKU', '品名', 'skuName']) ||
          String(skuCode || '').trim(),
        status: productStatus,
        statusCode: backendStatusCode(productStatus),
        storeName,
        area: siteName,
        site,
        regionGroup: backendRegionGroup(site),
        title,
        backendTranslatedTitle: translatedTitle,
        backendTitleCn: translatedTitle,
        backendEnglishTitle: englishTitle,
        category:
          pickByNormalizedHeader(row, ['叶子类目名称', '类目', '分类', 'category']) ||
          pick(row, ['叶子类目名称', '类目', '分类', 'category']),
        brand: '',
        lingxingDeclarePrice: declarePrice,
        lingxingDeclareCurrency: 'USD',
        lingxingActivityPrice: '',
        lingxingActivityCurrency: '',
        salesAmount: '',
        orderCount: '',
        volume: '',
        salesProfit: '',
        raw: row
      };
    })
    .filter(row => row.platformSpu || row.skuCode || row.title);
}

function readBackendExport() {
  const file = findBackendExportFile();
  const rows = file ? normalizeBackendExport(readWorkbookRows(file), file) : [];
  return {
    rows,
    source: fileInfo(file)
  };
}

function rowStoreRegion(row) {
  return [row.storeName, row.area].filter(Boolean).join(' / ');
}

function normalizeRowStoreRegion(row = {}) {
  const region = regionGroupLabel(row);
  const normalizedStore = regionalStoreDisplayName(row.storeName, region);
  if (!normalizedStore || !region) {
    return {
      ...row,
      storeRegion: row.storeRegion || rowStoreRegion(row)
    };
  }
  return {
    ...row,
    storeName: normalizedStore,
    area: region,
    regionGroup: row.regionGroup || region,
    storeRegion: rowStoreRegion({ ...row, storeName: normalizedStore, area: region })
  };
}

function hasSameStoreBackendTitleMatch(official, backendRows, scope = 'store-site') {
  return backendRows.some(row => {
    if (!matchScopeCompatible(scope, row, official)) return false;
    return Boolean(bestOfficialTitleMatchForRow(row, [official], BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD));
  });
}

function priceTitleSimilarity(left, right, minKeyLength = FUZZY_TITLE_MIN_KEY_LENGTH) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 1;
  if (leftKey.length < minKeyLength || rightKey.length < minKeyLength) return 0;
  return Math.max(diceSimilarity(left, right), tokenOverlapSimilarity(left, right));
}

function titleTokens(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\u3400-\u9fff]+/gu, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && !/^\d+$/.test(item)))];
}

function meaningfulTitleTokens(value) {
  return titleTokens(value)
    .map(token => token.toLowerCase())
    .filter(token =>
      token.length >= 3 &&
      !TITLE_TOKEN_STOPWORDS.has(token) &&
      !/^\d+(?:\.\d+)?$/.test(token)
    );
}

function tokenOverlapSimilarity(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const hits = leftTokens.filter(token => rightSet.has(token)).length;
  return hits / Math.min(leftTokens.length, rightTokens.length);
}

function meaningfulTokenOverlapSimilarity(left, right) {
  const leftTokens = meaningfulTitleTokens(left);
  const rightTokens = meaningfulTitleTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const hits = leftTokens.filter(token => rightSet.has(token)).length;
  return hits / Math.min(leftTokens.length, rightTokens.length);
}

function translatedTitlePairAllowed(left, right) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  return meaningfulTokenOverlapSimilarity(left, right) >= TRANSLATED_TITLE_MIN_TOKEN_OVERLAP;
}

function titleComparableLength(value) {
  const tokens = meaningfulTitleTokens(value);
  if (tokens.length) return tokens.join('').length;
  return normalizeKey(value).length;
}

function titleLengthCompatible(left, right, { translated = false, score = 0 } = {}) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;

  const leftLength = titleComparableLength(left);
  const rightLength = titleComparableLength(right);
  if (!leftLength || !rightLength) return false;
  const longer = Math.max(leftLength, rightLength);
  const shorter = Math.min(leftLength, rightLength);
  const diff = longer - shorter;
  const ratio = shorter / longer;
  const minRatio = translated ? PRICE_TRANSLATED_TITLE_MIN_LENGTH_RATIO : PRICE_TITLE_MIN_LENGTH_RATIO;
  const maxDiff = translated ? PRICE_TRANSLATED_TITLE_MAX_LENGTH_DIFF : PRICE_TITLE_MAX_LENGTH_DIFF;
  return ratio >= minRatio || diff <= maxDiff;
}

function uniqueTitleCandidates(items) {
  const byKey = new Map();
  for (const item of items) {
    const value = String(item?.value || '').trim();
    const key = normalizeText(value);
    if (!key) continue;
    const existing = byKey.get(key);
    byKey.set(key, {
      value: existing?.value || value,
      translated: existing ? Boolean(existing.translated && item.translated) : Boolean(item.translated)
    });
  }
  return [...byKey.values()];
}

function titleCandidateItemsForRow(row = {}) {
  return uniqueTitleCandidates([
    { value: row.title },
    { value: row.backendEnglishTitle },
    { value: row.skuName },
    { value: row.backendTitleCn, translated: true },
    { value: row.backendTranslatedTitle, translated: true },
    { value: row.backendMachineTranslatedTitle, translated: true }
  ]);
}

function titleCandidatesForRow(row = {}) {
  return titleCandidateItemsForRow(row).map(item => item.value);
}

function officialTitleCandidateItems(official = {}) {
  const translatedKeys = new Set([
    ...(official.translatedTitles || []),
    official.machineTranslatedTitle
  ].map(value => normalizeText(value)).filter(Boolean));
  return uniqueTitleCandidates([
    { value: official.title },
    ...(official.altTitles || []).map(value => ({
      value,
      translated: translatedKeys.has(normalizeText(value))
    })),
    ...(official.translatedTitles || []).map(value => ({ value, translated: true })),
    { value: official.machineTranslatedTitle, translated: true }
  ]);
}

function officialTitleCandidates(official) {
  return officialTitleCandidateItems(official).map(item => item.value);
}

function officialTranslatedTitleCandidates(official) {
  return officialTitleCandidateItems(official)
    .filter(item => item.translated)
    .map(item => item.value);
}

function officialCandidatesForRow(row, officialRows, scope = 'store-site') {
  return officialRows.filter(official => matchScopeCompatible(scope, row, official));
}

function bestOfficialTitleMatchForRow(row, officialRows, threshold = BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD) {
  const rowTitles = titleCandidateItemsForRow(row);
  if (!rowTitles.length) return null;
  const scored = [];
  for (const official of officialRows) {
    const officialTitles = officialTitleCandidateItems(official);
    let officialBestScore = 0;
    let officialBestStatus = '';
    let officialUsedTranslation = false;
    for (const leftTitle of rowTitles) {
      for (const title of officialTitles) {
        const score = priceTitleSimilarity(leftTitle.value, title.value, TRANSLATED_TITLE_MIN_KEY_LENGTH);
        const usesTranslation = Boolean(leftTitle.translated || title.translated);
        if (usesTranslation && !translatedTitlePairAllowed(leftTitle.value, title.value)) continue;
        if (!titleLengthCompatible(leftTitle.value, title.value, { translated: usesTranslation, score })) continue;
        if (score <= officialBestScore) continue;
        officialBestScore = score;
        officialUsedTranslation = usesTranslation;
        officialBestStatus = leftTitle.translated || title.translated
          ? '翻译标题匹配'
          : score >= STRICT_TITLE_MATCH_THRESHOLD ? '标题匹配' : '标题模糊匹配';
      }
    }
    if (officialBestScore > 0) {
      scored.push({
        official,
        score: officialBestScore,
        matchStatus: officialBestStatus,
        usedTranslation: officialUsedTranslation
      });
    }
  }
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) return null;
  const requiredScore = best.usedTranslation ? Math.min(threshold, BACKEND_OFFICIAL_TRANSLATED_TITLE_MATCH_THRESHOLD) : threshold;
  const runnerUp = scored[1];
  const ambiguous = runnerUp &&
    best.score < PRICE_TITLE_AMBIGUITY_STRICT_BELOW &&
    best.score - runnerUp.score < PRICE_TITLE_AMBIGUITY_GAP;
  return best.score >= requiredScore && !ambiguous
    ? { official: best.official, score: Math.round(best.score * 100), matchStatus: best.matchStatus || '标题模糊匹配' }
    : null;
}

function bestOfficialImageMatchForRow(row, officialRows) {
  let best = null;
  for (const official of officialRows) {
    const score = imageSimilarityForRows(row, official);
    if (score < PRICE_IMAGE_MATCH_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = { official, score };
    }
  }
  return best
    ? { official: best.official, score: best.score, matchStatus: '图片匹配' }
    : null;
}

function sameStoreWeakTitleOfficialMatch(row, officialRows, threshold = SAME_STORE_WEAK_TITLE_MATCH_THRESHOLD, scope = 'store-site') {
  let bestOfficial = null;
  let bestScore = 0;
  for (const official of officialRows) {
    if (!matchScopeStrictlyCompatible(scope, row, official)) continue;
    for (const title of officialTitleCandidates(official)) {
      const score = priceTitleSimilarity(row.title, title, TRANSLATED_TITLE_MIN_KEY_LENGTH);
      if (!titleLengthCompatible(row.title, title, { score })) continue;
      if (score <= bestScore) continue;
      bestOfficial = official;
      bestScore = score;
    }
    for (const title of officialTranslatedTitleCandidates(official)) {
      const score = priceTitleSimilarity(row.title, title, TRANSLATED_TITLE_MIN_KEY_LENGTH);
      if (!titleLengthCompatible(row.title, title, { translated: true, score })) continue;
      if (score <= bestScore) continue;
      bestOfficial = official;
      bestScore = score;
    }
  }
  return bestOfficial && bestScore >= threshold
    ? { official: bestOfficial, score: Math.round(bestScore * 100), matchStatus: '店铺标题弱匹配' }
    : null;
}

function bestOfficialMatchForRow(row, officialRows, scope = 'store-site') {
  const candidates = officialCandidatesForRow(row, officialRows, scope);
  const imageMatch = bestOfficialImageMatchForRow(row, candidates);
  if (imageMatch) return imageMatch;
  const titleMatch = bestOfficialTitleMatchForRow(row, candidates);
  const weakTitleMatch = !titleMatch ? sameStoreWeakTitleOfficialMatch(row, candidates, Math.min(SAME_STORE_WEAK_TITLE_MATCH_THRESHOLD, BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD), scope) : null;
  const official = titleMatch?.official || weakTitleMatch?.official || null;
  if (!official) return null;
  return {
    official,
    matchStatus: titleMatch ? titleMatch.matchStatus : weakTitleMatch.matchStatus,
    score: titleMatch?.score || weakTitleMatch?.score || ''
  };
}

function bestRowMatchForOfficial(official, rows, scope = 'store-site') {
  let best = null;
  const candidates = rows.filter(row => matchScopeStrictlyCompatible(scope, row, official));
  const officialTitles = officialTitleCandidateItems(official);

  for (const row of candidates) {
    let bestTitleScore = 0;
    let usedTranslation = false;
    for (const rowTitle of titleCandidateItemsForRow(row)) {
      for (const title of officialTitles) {
        const score = priceTitleSimilarity(rowTitle.value, title.value, TRANSLATED_TITLE_MIN_KEY_LENGTH);
        const usesTranslation = Boolean(rowTitle.translated || title.translated);
        if (usesTranslation && !translatedTitlePairAllowed(rowTitle.value, title.value)) continue;
        if (!titleLengthCompatible(rowTitle.value, title.value, { translated: usesTranslation, score })) continue;
        if (score > bestTitleScore) {
          bestTitleScore = score;
          usedTranslation = usesTranslation;
        }
      }
    }
    const threshold = usedTranslation ? BACKEND_OFFICIAL_TRANSLATED_TITLE_MATCH_THRESHOLD : BACKEND_OFFICIAL_TITLE_MATCH_THRESHOLD;
    if (bestTitleScore >= threshold && (!best || bestTitleScore > best.score)) {
      best = {
        row,
        matchStatus: usedTranslation ? '翻译标题匹配' : bestTitleScore >= STRICT_TITLE_MATCH_THRESHOLD ? '标题匹配' : '标题模糊匹配',
        score: Math.round(bestTitleScore * 100)
      };
    }
  }
  return best;
}

function priceMatchCount(rows) {
  return rows.filter(row => PRICE_MATCH_STATUSES.has(row.matchStatus)).length;
}

function siteVatRate(row = {}) {
  const officialSite = normalizeSiteCode(row.officialSite);
  if (officialSite === 'DE') return 0.19;
  if (officialSite === 'GB') return 0.20;
  if (officialSite && officialSite !== 'EU') return 0;

  const text = [
    row.site,
    row.area,
    row.storeRegion,
    row.region,
    row.storeName,
    row.officialUrl
  ].map(value => String(value || '')).join(' ');
  if (/德国|德國|\bDE\b|germany|deutschland/i.test(text)) return 0.19;
  if (!officialSite && /英国|英國|\bUK\b|\bGB\b|united\s*kingdom|great\s*britain/i.test(text)) return 0.20;
  return 0;
}

function referencePrice(row) {
  const declare = firstNumber(row.lingxingDeclarePrice);
  const vatRate = siteVatRate(row);
  const currency = normalizeCurrencyCode(row.lingxingDeclareCurrency) || 'USD';
  const declareUsd = declare === null
    ? { value: null, rate: null, error: '' }
    : convertCurrency(declare, currency, 'USD');
  const comparisonValue = declareUsd.value === null ? null : declareUsd.value * (1 + vatRate);
  return {
    value: declare,
    comparisonValue,
    baseValue: declare,
    comparableBaseValue: declareUsd.value,
    vatRate,
    type: '申报价',
    currency,
    comparisonCurrency: 'USD',
    conversionRate: declareUsd.rate,
    warning: declareUsd.error
  };
}

function priceStatus(row) {
  const ref = referencePrice(row);
  const official = firstNumber(row.officialPrice);
  const officialCurrency = normalizeCurrencyCode(row.officialCurrency || currencyFromPriceText(row.officialPrice) || currencyFromSite(row)) || 'USD';
  const officialComparable = convertCurrency(official, officialCurrency, 'USD');
  if (official === null) return { state: '前端缺价', diff: '', diffRate: '', over20: '否' };
  if (ref.value === null || ref.value <= 0) return { state: '后台缺价', diff: '', diffRate: '', over20: '否' };
  if (ref.comparisonValue === null || ref.comparisonValue <= 0) {
    return {
      state: '币种缺汇率',
      diff: '',
      diffRate: '',
      over20: '否',
      officialCurrency,
      officialComparablePrice: '',
      officialComparableCurrency: 'USD',
      currencyConversionRate: '',
      currencyWarning: ref.warning
    };
  }
  if (officialComparable.value === null) {
    return {
      state: '币种缺汇率',
      diff: '',
      diffRate: '',
      over20: '否',
      officialCurrency,
      officialComparablePrice: '',
      officialComparableCurrency: 'USD',
      currencyConversionRate: '',
      currencyWarning: officialComparable.error
    };
  }
  const diff = officialComparable.value - ref.comparisonValue;
  const diffRate = officialComparable.value / ref.comparisonValue - 1;
  const base = {
    officialCurrency,
    officialComparablePrice: formatNumber(officialComparable.value),
    officialComparableCurrency: 'USD',
    currencyConversionRate: officialComparable.rate === null ? '' : formatNumber(officialComparable.rate, 6),
    currencyWarning: officialComparable.error
  };
  if (diffRate > 0.2) {
    return { ...base, state: '前端超价20%', diff: formatNumber(diff), diffRate: formatNumber(diffRate * 100), over20: '是' };
  }
  return { ...base, state: NORMAL_PRICE_SPREAD_STATUS, diff: formatNumber(diff), diffRate: formatNumber(diffRate * 100), over20: '否' };
}

function officialSiteValue(official = {}) {
  return official.officialSite || official.site || '';
}

function officialDetailForPriceRow(row, official) {
  const site = officialSiteValue(official);
  const priceContext = {
    ...row,
    site: row.site || official?.site || '',
    area: row.area || official?.area || '',
    officialSite: site || row.officialSite || '',
    officialUrl: official?.officialUrl || row.officialUrl || ''
  };
  const status = priceStatus({
    ...priceContext,
    officialPrice: official?.officialPrice || '',
    officialCurrency: official?.officialCurrency || '',
    officialSite: site || row.officialSite || ''
  });
  return {
    site,
    price: official?.officialPrice || '',
    currency: status.officialCurrency || official?.officialCurrency || '',
    comparablePrice: status.officialComparablePrice || '',
    comparableCurrency: status.officialComparableCurrency || '',
    conversionRate: status.currencyConversionRate || '',
    warning: status.currencyWarning || '',
    diff: status.diff || '',
    diffRate: status.diffRate || '',
    alert: status.state || '',
    over20: status.over20 || '否',
    url: official?.officialUrl || '',
    title: official?.title || '',
    machineTranslatedTitle: official?.machineTranslatedTitle || '',
    image: official?.image || '',
    imageHash: official?.imageHash || official?.officialImageHash || '',
    mallId: official?.mallId || '',
    goodsId: official?.goodsId || ''
  };
}

function detailKey(detail = {}) {
  return [
    normalizeKey(detail.mallId),
    normalizeKey(detail.goodsId),
    normalizeSiteCode(detail.site),
    normalizeKey(detail.url),
    normalizeKey(detail.title),
    normalizeKey(detail.image)
  ].join('|');
}

function compactDetailLine(detail, valueKey = 'price') {
  const site = detail.site || '';
  const value = detail[valueKey] || '';
  if (!site) return value;
  return value ? `${site}: ${value}` : site;
}

function officialDetailsFromRow(row = {}) {
  if (Array.isArray(row.officialDetails)) return row.officialDetails.filter(Boolean);
  if (!row.officialPrice && !row.officialTitle && !row.officialImage && !row.officialSite) return [];
  return [{
    site: row.officialSite || '',
    price: row.officialPrice || '',
    currency: row.officialCurrency || '',
    comparablePrice: row.officialComparablePrice || '',
    comparableCurrency: row.officialComparableCurrency || '',
    conversionRate: row.currencyConversionRate || '',
    warning: row.currencyWarning || '',
    diff: row.priceDiff || '',
    diffRate: row.priceDiffRate || '',
    alert: row.priceAlert || '',
    over20: row.priceOver20 || '否',
    url: row.officialUrl || '',
    title: row.officialTitle || '',
    machineTranslatedTitle: row.officialMachineTranslatedTitle || '',
    image: row.officialImage || '',
    imageHash: row.officialImageHash || '',
    mallId: row.mallId || '',
    goodsId: row.goodsId || ''
  }];
}

function sortOfficialDetails(details) {
  const siteOrder = new Map(['US', 'GB', 'DE', 'EU'].map((site, index) => [site, index]));
  return [...details].sort((left, right) => {
    const leftSite = normalizeSiteCode(left.site);
    const rightSite = normalizeSiteCode(right.site);
    const leftRank = siteOrder.has(leftSite) ? siteOrder.get(leftSite) : 99;
    const rightRank = siteOrder.has(rightSite) ? siteOrder.get(rightSite) : 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(leftSite || left.site || '').localeCompare(String(rightSite || right.site || ''));
  });
}

function aggregateOfficialFields(row, extraDetails = []) {
  const details = [];
  const seen = new Set();
  for (const detail of [...officialDetailsFromRow(row), ...extraDetails].filter(Boolean)) {
    const key = detailKey(detail);
    if (seen.has(key)) continue;
    seen.add(key);
    details.push(detail);
  }
  const sortedDetails = sortOfficialDetails(details);
  if (!sortedDetails.length) return row;

  const sites = [...new Set(sortedDetails.map(detail => detail.site).filter(Boolean))];
  const first = sortedDetails[0];
  const worst = sortedDetails
    .filter(detail => detail.diffRate !== '' && Number.isFinite(Number(detail.diffRate)))
    .sort((left, right) => Number(right.diffRate) - Number(left.diffRate))[0] || first;
  const over20 = sortedDetails.some(detail => detail.over20 === '是') ? '是' : '否';
  const hasNormalSpread = sortedDetails.some(detail =>
    [NORMAL_PRICE_SPREAD_STATUS, '价格不一致', '价格一致'].includes(detail.alert)
  );
  const alert = over20 === '是'
    ? '前端超价20%'
    : hasNormalSpread
      ? NORMAL_PRICE_SPREAD_STATUS
      : (worst.alert || row.priceAlert || '');

  return {
    ...row,
    officialDetails: sortedDetails,
    officialImage: row.officialImage || first.image || '',
    image: row.image || row.lingxingImage || first.image || '',
    officialImageHash: row.officialImageHash || first.imageHash || '',
    mallId: row.mallId || first.mallId || '',
    goodsId: row.goodsId || first.goodsId || '',
    officialTitle: row.officialTitle || first.title || '',
    officialMachineTranslatedTitle: row.officialMachineTranslatedTitle || first.machineTranslatedTitle || '',
    officialPrice: sortedDetails.map(detail => compactDetailLine(detail, 'price')).filter(Boolean).join('\n'),
    officialSite: sites.join(' / '),
    officialCurrency: sortedDetails.map(detail => compactDetailLine(detail, 'currency')).filter(Boolean).join('\n'),
    officialComparablePrice: sortedDetails.map(detail => compactDetailLine(detail, 'comparablePrice')).filter(Boolean).join('\n'),
    officialComparableCurrency: sortedDetails.map(detail => compactDetailLine(detail, 'comparableCurrency')).filter(Boolean).join('\n'),
    currencyConversionRate: sortedDetails.map(detail => compactDetailLine(detail, 'conversionRate')).filter(Boolean).join('\n'),
    currencyWarning: sortedDetails.map(detail => compactDetailLine(detail, 'warning')).filter(Boolean).join('\n'),
    officialUrl: first.url || row.officialUrl || '',
    priceDiff: worst.diff || row.priceDiff || '',
    priceDiffRate: worst.diffRate || row.priceDiffRate || '',
    priceAlert: alert,
    priceOver20: over20
  };
}

function groupRowsBySpu(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeKey(row.platformSpu);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function idMatches(left, right, fields) {
  return fields.some(field => {
    const leftValue = normalizeKey(left?.[field]);
    const rightValue = normalizeKey(right?.[field]);
    return leftValue && rightValue && leftValue === rightValue;
  });
}

function findBaseRowForBackend(backend, baseRows) {
  if (!baseRows?.length) return null;
  return baseRows.find(row => idMatches(row, backend, ['skuCode', 'skuId', 'skcId'])) || baseRows[0];
}

function standardStoreForBackendRow(baseRows = []) {
  const candidates = baseRows
    .filter(row => row?.storeName && !/^XG[A-Z0-9_\s-]*\s*TEMU/i.test(String(row.storeName)))
    .map(row => ({
      storeName: row.storeName,
      area: row.area || regionGroupLabel(row),
      regionGroup: row.regionGroup || regionGroupLabel(row)
    }));
  const unique = new Map();
  for (const candidate of candidates) {
    const key = [normalizeKey(candidate.storeName), normalizeKey(candidate.area)].join('|');
    if (!key.replace(/\|/g, '')) continue;
    unique.set(key, candidate);
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function normalizeBackendStoreFromLingxing(backend, bySpu) {
  const spuKey = normalizeKey(backend.platformSpu);
  const standard = spuKey ? standardStoreForBackendRow(bySpu.get(spuKey) || []) : null;
  if (!standard) {
    const backendRegion = regionGroupLabel(backend);
    if (!canonicalStoreDisplayName(backend.storeName) || !backendRegion) return backend;
    const storeName = regionalStoreDisplayName(backend.storeName, backendRegion);
    return {
      ...backend,
      backendOriginalStoreName: backend.backendOriginalStoreName || backend.storeName || '',
      backendOriginalArea: backend.backendOriginalArea || backend.area || '',
      storeName,
      area: backendRegion,
      regionGroup: backendRegion
    };
  }
  return {
    ...backend,
    backendOriginalStoreName: backend.backendOriginalStoreName || backend.storeName || '',
    backendOriginalArea: backend.backendOriginalArea || backend.area || '',
    storeName: standard.storeName,
    area: standard.area,
    regionGroup: standard.regionGroup || regionGroupLabel(standard)
  };
}

function backendMergeKey(row) {
  return [
    normalizeKey(row.platformSpu),
    normalizeKey(row.skuId || row.skuCode || row.skcId),
    normalizeKey(row.site || row.area)
  ].join('|');
}

function backendOverlayKey(row) {
  return [
    normalizeKey(row.platformSpu),
    storeIdentityTokens(row)[0] || normalizeKey(row.storeName),
    normalizeKey(row.site || row.area || row.regionGroup)
  ].join('|');
}

function backendRowsForMode(rows, activeOnly) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (activeOnly && !isBackendActive(row)) continue;
    const key = backendMergeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function backendRowsForPrice(backendRows) {
  return backendRowsForMode(backendRows.filter(isBackendPriceActive), false)
    .map((row, index) => normalizeRowStoreRegion(applyBackendToLingxingRow(row, null, index)));
}

function applyBackendToLingxingRow(backend, base = null, index = 0) {
  const backendOnly = base ? '否' : '是';
  const row = {
    ...(base || {}),
    source: 'backend',
    backendOnly,
    backendMatchedLingxing: base ? '是' : '否',
    backendProductStatus: backend.backendProductStatus,
    backendDeclarePriceStatus: backend.backendDeclarePriceStatus,
    backendOperatingSites: backend.backendOperatingSites,
    backendPriceSite: backend.backendPriceSite,
    backendInventoryQty: backend.backendInventoryQty,
    backendCreatedAt: backend.backendCreatedAt,
    backendSourceFile: backend.backendSourceFile,
    image: base?.image || '',
    platformSpu: backend.platformSpu || base?.platformSpu || '',
    skuId: backend.skuId || base?.skuId || '',
    skcId: backend.skcId || base?.skcId || '',
    skuCode: backend.skuCode || base?.skuCode || '',
    skuName: base?.skuName || backend.skuName || backend.backendSpecText || '',
    status: backend.status || base?.status || '',
    statusCode: backend.statusCode || statusCode(backend.status || base?.status || ''),
    storeName: backend.storeName || base?.storeName || '',
    area: backend.area || base?.area || '',
    site: backend.site || base?.site || '',
    regionGroup: backend.regionGroup || rowRegionGroup(backend),
    title: backend.title || base?.title || '',
    backendTitleCn: backend.backendTitleCn || base?.backendTitleCn || '',
    backendTranslatedTitle: backend.backendTranslatedTitle || base?.backendTranslatedTitle || '',
    backendEnglishTitle: backend.backendEnglishTitle || base?.backendEnglishTitle || '',
    category: backend.category || base?.category || '',
    brand: base?.brand || backend.brand || '',
    lingxingDeclarePrice: backend.lingxingDeclarePrice || base?.lingxingDeclarePrice || '',
    lingxingDeclareCurrency: backend.lingxingDeclareCurrency || base?.lingxingDeclareCurrency || 'USD',
    lingxingActivityPrice: '',
    lingxingActivityCurrency: '',
    salesAmount: base?.salesAmount || '',
    orderCount: base?.orderCount || '',
    volume: base?.volume || '',
    salesProfit: base?.salesProfit || '',
    raw: backend.raw || base?.raw || {}
  };
  if (!row.skuId && !row.skuCode && !row.skcId) row.skuId = `backend-${index}`;
  return row;
}

function mergeBackendRowsIntoLingxingRows(lingxingRows, backendRows, { activeOnly = false } = {}) {
  const bySpu = groupRowsBySpu(lingxingRows);
  const selectedBackendRows = backendRowsForMode(backendRows, activeOnly)
    .map(row => normalizeBackendStoreFromLingxing(row, bySpu));
  if (!selectedBackendRows.length) {
    return {
      rows: lingxingRows,
      stats: {
        backend_rows: backendRows.length,
        backend_selected_rows: 0,
        backend_added_rows: 0,
        backend_overlaid_spus: 0
      }
    };
  }

  const overlayKeys = new Set(selectedBackendRows.map(backendOverlayKey).filter(key => key.replace(/\|/g, '')));
  const rows = lingxingRows.filter(row => !overlayKeys.has(backendOverlayKey(row)));
  let added = 0;
  const overlaidSpus = new Set();

  selectedBackendRows.forEach((backend, index) => {
    const baseRows = (bySpu.get(normalizeKey(backend.platformSpu)) || [])
      .filter(row => storeStrictlyCompatible(row, backend) || backendOverlayKey(row) === backendOverlayKey(backend));
    const base = findBaseRowForBackend(backend, baseRows);
    if (!base) added++;
    else overlaidSpus.add(normalizeKey(backend.platformSpu));
    rows.push(normalizeRowStoreRegion(applyBackendToLingxingRow(backend, base, index)));
  });

  return {
    rows,
    stats: {
      backend_rows: backendRows.length,
      backend_selected_rows: selectedBackendRows.length,
      backend_added_rows: added,
      backend_overlaid_spus: overlaidSpus.size
    }
  };
}

function readWarehouseDetailRows() {
  if (!fs.existsSync(WAREHOUSE_INVENTORY_XLSX)) return [];
  const workbook = XLSX.readFile(WAREHOUSE_INVENTORY_XLSX, { cellDates: false });
  const sheetName = workbook.SheetNames.find(name => name === '仓库明细') || '';
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false }).map(row => ({
    warehouseSource: pick(row, ['仓库来源', 'warehouseSource']),
    warehouseSku: pick(row, ['仓库SKU', 'warehouseSku']),
    warehouseCode: pick(row, ['仓库代码', 'warehouseCode']),
    warehouseName: pick(row, ['仓库名称', 'warehouseName']),
    countryCode: pick(row, ['国家', 'countryCode']),
    availableQty: pick(row, ['可用库存', 'availableQty']),
    inStockQty: pick(row, ['在库库存', 'inStockQty']),
    frozenQty: pick(row, ['冻结/待发库存', 'frozenQty']),
    onWayQty: pick(row, ['在途库存', 'onWayQty']),
    pendingQty: pick(row, ['待上架库存', 'pendingQty'])
  }));
}

function warehouseSiteCode(row = {}) {
  const countryCode = normalizeSiteCode(row.countryCode);
  if (countryCode) return countryCode;
  const values = [row.warehouseCode, row.warehouseName]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  for (const value of values) {
    const code = normalizeSiteCode(value);
    if (code && (EU_SITE_CODES.has(code) || GLOBAL_SITE_CODES.has(code) || code === 'EU')) return code;
  }
  const compact = values.join(' ').replace(/[^a-z0-9]+/gi, '').toUpperCase();
  if (!compact) return '';
  if (/^(UK|GB)/.test(compact) || /GBLON|GBLTN|UKTW|UKGF|UK0001/.test(compact)) return 'GB';
  if (/^(DE|DEU)/.test(compact) || /GERMANY|DEUTSCHLAND/.test(compact)) return 'DE';
  if (/^(US|USA|USEA|USWE|USTX|USKY|USWC|US0|NJ|LB)/.test(compact)) return 'US';
  if (/^(CA|CAN|ON)/.test(compact) || /TORONTO/.test(compact)) return 'CA';
  if (/^(AU|AUS|AUSY|AUME)/.test(compact) || /AUSTRALIA/.test(compact)) return 'AU';
  if (/^(JP|JPN)/.test(compact)) return 'JP';
  return '';
}

function warehouseDetailRegionGroup(row) {
  const code = warehouseSiteCode(row);
  if (!code) return '';
  if (EU_SITE_CODES.has(code) || code === 'EU') return '欧区';
  if (GLOBAL_SITE_CODES.has(code) || /^[A-Z]{2}$/.test(code)) return '美国/Global';
  return '';
}

function summarizeWarehouseDetails(rows) {
  const warehouses = new Set();
  const sources = new Set();
  const skus = new Set();
  const summary = {
    availableQty: 0,
    inStockQty: 0,
    frozenQty: 0,
    onWayQty: 0,
    pendingQty: 0
  };
  for (const row of rows) {
    sources.add(row.warehouseSource);
    skus.add(row.warehouseSku);
    warehouses.add([row.warehouseCode, row.warehouseName].filter(Boolean).join('/'));
    summary.availableQty += firstNumber(row.availableQty) || 0;
    summary.inStockQty += firstNumber(row.inStockQty) || 0;
    summary.frozenQty += firstNumber(row.frozenQty) || 0;
    summary.onWayQty += firstNumber(row.onWayQty) || 0;
    summary.pendingQty += firstNumber(row.pendingQty) || 0;
  }
  return {
    ...summary,
    warehouseSource: [...sources].filter(Boolean).join(','),
    warehouseSku: [...skus].filter(Boolean).join(','),
    warehouse: [...warehouses].filter(Boolean).join(',')
  };
}

function warehouseSummaryForBackend(backend, detailRows) {
  const skuKey = normalizeKey(backend.skuCode);
  const regionGroup = backend.regionGroup || backendRegionGroup(backend.site);
  const matches = detailRows.filter(row => normalizeKey(row.warehouseSku) === skuKey);
  const regionRows = matches.map(row => ({ row, group: warehouseDetailRegionGroup(row) }));
  const sameRegion = regionRows.filter(item => item.group === regionGroup).map(item => item.row);
  const otherRegion = regionRows.filter(item => item.group && item.group !== regionGroup).map(item => item.row);
  const unknownRegion = regionRows.filter(item => !item.group).map(item => item.row);
  return {
    same: summarizeWarehouseDetails(sameRegion),
    other: summarizeWarehouseDetails(otherRegion),
    unknown: summarizeWarehouseDetails(unknownRegion),
    all: summarizeWarehouseDetails(matches)
  };
}

function backendHasWarehouseStock(summary) {
  return Boolean(
    summary &&
    (
      firstNumber(summary.same?.availableQty) > 0 ||
      firstNumber(summary.other?.availableQty) > 0 ||
      firstNumber(summary.unknown?.availableQty) > 0 ||
      firstNumber(summary.all?.availableQty) > 0 ||
      firstNumber(summary.same?.inStockQty) > 0 ||
      firstNumber(summary.other?.inStockQty) > 0 ||
      firstNumber(summary.unknown?.inStockQty) > 0 ||
      firstNumber(summary.all?.inStockQty) > 0
    )
  );
}

function hasWarehouseDetail(summary) {
  return Boolean(summary?.warehouseSku);
}

function warehouseNumber(summary, field, fallback = 0) {
  return hasWarehouseDetail(summary) ? (firstNumber(summary[field]) || 0) : fallback;
}

function applyBackendToInventoryRow(backend, base = null, index = 0, detailRows = []) {
  const detailSummary = warehouseSummaryForBackend(backend, detailRows);
  const hasAnyDetail = hasWarehouseDetail(detailSummary.all);
  const sameAvailable = hasAnyDetail
    ? warehouseNumber(detailSummary.same, 'availableQty', 0)
    : firstNumber(base?.siteMatchedAvailableQty || base?.skuRegionAvailableQty || base?.availableQty) || 0;
  const otherAvailable = hasAnyDetail
    ? warehouseNumber(detailSummary.other, 'availableQty', 0)
    : firstNumber(base?.otherRegionAvailableQty) || 0;
  const unknownAvailable = hasAnyDetail
    ? warehouseNumber(detailSummary.unknown, 'availableQty', 0)
    : firstNumber(base?.unknownRegionAvailableQty) || 0;
  const sameInStock = hasAnyDetail
    ? warehouseNumber(detailSummary.same, 'inStockQty', 0)
    : firstNumber(base?.inStockQty) || 0;
  const sameFrozen = hasAnyDetail
    ? warehouseNumber(detailSummary.same, 'frozenQty', 0)
    : firstNumber(base?.frozenQty) || 0;
  const sameOnWay = hasAnyDetail
    ? warehouseNumber(detailSummary.same, 'onWayQty', 0)
    : firstNumber(base?.onWayQty) || 0;
  const samePending = hasAnyDetail
    ? warehouseNumber(detailSummary.same, 'pendingQty', 0)
    : firstNumber(base?.pendingQty) || 0;
  const row = {
    ...(base || {}),
    source: 'backend',
    backendOnly: base ? '否' : '是',
    backendMatchedLingxing: base ? '是' : '否',
    backendProductStatus: backend.backendProductStatus,
    backendDeclarePriceStatus: backend.backendDeclarePriceStatus,
    backendOperatingSites: backend.backendOperatingSites,
    backendPriceSite: backend.backendPriceSite,
    backendInventoryQty: backend.backendInventoryQty,
    backendCreatedAt: backend.backendCreatedAt,
    image: base?.image || '',
    platformSpu: backend.platformSpu || base?.platformSpu || '',
    skuId: backend.skuId || base?.skuId || '',
    skcId: backend.skcId || base?.skcId || '',
    skuCode: backend.skuCode || base?.skuCode || '',
    skuName: base?.skuName || backend.skuName || backend.backendSpecText || '',
    status: backend.status || base?.status || '',
    statusCode: backend.statusCode || statusCode(backend.status || base?.status || ''),
    storeName: backend.storeName || base?.storeName || '',
    area: backend.area || base?.area || '',
    site: backend.site || base?.site || '',
    regionGroup: backend.regionGroup || backendRegionGroup(backend.site),
    skuRegionListingCount: '1',
    skuRegionActiveListingCount: isBackendActive(backend) ? '1' : '0',
    skuRegionAvailableQty: String(sameAvailable),
    skuRegionAlertRepresentative: '是',
    skuRegionLingxingStatuses: `${backend.status || '空状态'}${backend.statusCode ? `(${backend.statusCode})` : ''}:1`,
    listingSkuCount: '1',
    listingSkuCodes: backend.skuCode || base?.listingSkuCodes || base?.skuCode || '',
    listingStockedSkuCodes: sameAvailable > 0 ? `${backend.skuCode || base?.skuCode}:${sameAvailable}` : '',
    listingPriceDetails: backend.lingxingDeclarePrice ? `${backend.skuCode || base?.skuCode || ''} 申报:${backend.lingxingDeclarePrice} USD` : '',
    listingSkuInventory: `${backend.skuCode || base?.skuCode || '空SKU'}:${sameAvailable}`,
    listingSkuDetails: [
      backend.backendSpecText,
      backend.title || base?.title,
      backend.skuCode ? `SKU:${backend.skuCode}` : '',
      backend.skuId ? `平台SKU:${backend.skuId}` : '',
      backend.status ? `状态:${backend.status}` : ''
    ].filter(Boolean).join(' | '),
    title: backend.title || base?.title || '',
    lingxingDeclarePrice: backend.lingxingDeclarePrice || base?.lingxingDeclarePrice || '',
    lingxingDeclareCurrency: 'USD',
    lingxingActivityPrice: '',
    lingxingActivityCurrency: '',
    inventoryMatchStatus: detailSummary.all.warehouseSku ? '后台SKU+仓库匹配' : base?.inventoryMatchStatus || '仓库未匹配',
    warehouseRegionMatchStatus: sameAvailable > 0 ? '同区匹配' : unknownAvailable > 0 ? '仓库地区待确认' : otherAvailable > 0 ? '其他区域有库存' : '无库存记录',
    warehouseSource: detailSummary.same.warehouseSource || detailSummary.unknown.warehouseSource || detailSummary.all.warehouseSource || base?.warehouseSource || '',
    warehouseSku: detailSummary.same.warehouseSku || detailSummary.unknown.warehouseSku || detailSummary.all.warehouseSku || base?.warehouseSku || '',
    warehouse: detailSummary.same.warehouse || detailSummary.unknown.warehouse || base?.warehouse || '',
    otherRegionWarehouse: detailSummary.other.warehouse || base?.otherRegionWarehouse || '',
    unknownRegionWarehouse: detailSummary.unknown.warehouse || base?.unknownRegionWarehouse || '',
    unknownRegionWarehouseSku: detailSummary.unknown.warehouseSku || base?.unknownRegionWarehouseSku || '',
    availableQty: String(sameAvailable),
    siteMatchedAvailableQty: String(sameAvailable),
    otherRegionAvailableQty: String(otherAvailable),
    unknownRegionAvailableQty: String(unknownAvailable),
    inStockQty: String(sameInStock),
    frozenQty: String(sameFrozen),
    onWayQty: String(sameOnWay),
    pendingQty: String(samePending)
  };
  row.storeRegion = rowStoreRegion(row);
  row.skuRegionKey = `${normalizeKey(row.platformSpu || row.skuCode)}::${row.regionGroup}`;
  if (!row.id) row.id = `inventory-backend-${row.platformSpu || 'spu'}-${row.skuId || row.skuCode || index}-${row.site || index}`;
  return row;
}

function rowSkuKeys(row) {
  return [row.skuCode, row.listingSkuCodes, row.listingSkuInventory, row.listingStockedSkuCodes]
    .flatMap(value => extractSkuCodes(value))
    .map(normalizeKey)
    .filter(Boolean);
}

function uniqueTextValues(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const textValue = String(value || '').trim();
    if (!textValue) continue;
    const key = normalizeKey(textValue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(textValue);
  }
  return out;
}

function uniqueJoined(values, separator = '；') {
  return uniqueTextValues(values).join(separator);
}

function sumUniqueNumericByKey(items, keyFn, valueFn) {
  const values = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const value = firstNumber(valueFn(item)) || 0;
    values.set(key, Math.max(values.get(key) || 0, value));
  }
  return [...values.values()].reduce((sum, value) => sum + value, 0);
}

function aggregateInventoryBackendRowsBySpu(rows) {
  const groups = new Map();
  const passthrough = [];
  for (const row of rows) {
    const spuKey = normalizeKey(row.platformSpu);
    if (!spuKey) {
      passthrough.push(row);
      continue;
    }
    if (!groups.has(spuKey)) groups.set(spuKey, []);
    groups.get(spuKey).push(row);
  }

  const aggregated = [...groups.values()].map(group => {
    if (group.length === 1) return group[0];
    const representative =
      group.find(row => isActiveStatus(row.status)) ||
      group.find(row => firstNumber(row.siteMatchedAvailableQty || row.skuRegionAvailableQty || row.availableQty) > 0) ||
      group[0];
    const regionGroups = uniqueTextValues(group.map(row => row.regionGroup || backendRegionGroup(row.site)));
    const siteValues = uniqueTextValues(group.flatMap(row => [row.site, row.area]));
    const skuValues = uniqueTextValues(group.flatMap(row => extractSkuCodes([
      row.skuCode,
      row.listingSkuCodes,
      row.listingSkuInventory,
      row.listingStockedSkuCodes,
      row.listingSkuDetails
    ].filter(Boolean).join(' '))));
    const statusValues = uniqueTextValues(group.map(row => row.status));
    const statusSummary = [...new Map(group.map(row => {
      const label = row.status || '空状态';
      const code = row.statusCode ? `(${row.statusCode})` : '';
      const key = `${label}${code}`;
      return [key, key];
    })).values()].map(label => {
      const count = group.filter(row => `${row.status || '空状态'}${row.statusCode ? `(${row.statusCode})` : ''}` === label).length;
      return `${label}:${count}`;
    }).join('；');
    const stockKey = row => `${normalizeKey(row.skuCode || row.listingSkuCodes)}::${row.regionGroup || backendRegionGroup(row.site)}`;
    const sameAvailable = sumUniqueNumericByKey(group, stockKey, row => row.siteMatchedAvailableQty || row.skuRegionAvailableQty || row.availableQty);
    const otherAvailable = sumUniqueNumericByKey(group, stockKey, row => row.otherRegionAvailableQty);
    const unknownAvailable = sumUniqueNumericByKey(group, stockKey, row => row.unknownRegionAvailableQty);
    const inStock = sumUniqueNumericByKey(group, stockKey, row => row.inStockQty);
    const frozen = sumUniqueNumericByKey(group, stockKey, row => row.frozenQty);
    const onWay = sumUniqueNumericByKey(group, stockKey, row => row.onWayQty);
    const pending = sumUniqueNumericByKey(group, stockKey, row => row.pendingQty);
    const activeCount = group.filter(row => isActiveStatus(row.status)).length;
    const stockedSkuCodes = group
      .flatMap(row => extractSkuCodes(row.listingStockedSkuCodes || (firstNumber(row.siteMatchedAvailableQty || row.skuRegionAvailableQty || row.availableQty) > 0 ? row.skuCode : '')))
      .filter(Boolean);

    return {
      ...representative,
      id: `inventory-spu-${representative.platformSpu}`,
      skuId: uniqueJoined(group.map(row => row.skuId), ','),
      skcId: uniqueJoined(group.map(row => row.skcId), ','),
      skuCode: skuValues[0] || representative.skuCode || '',
      skuName: uniqueJoined(group.map(row => row.skuName || row.backendSpecText), '；'),
      status: representative.status || statusValues[0] || '',
      statusCode: representative.statusCode || statusCode(representative.status || statusValues[0] || ''),
      area: siteValues.join(' / '),
      site: siteValues.join(','),
      regionGroup: regionGroups.length === 1 ? regionGroups[0] : '多区域',
      skuRegionKey: `${normalizeKey(representative.platformSpu)}::${regionGroups.join(',') || '*'}`,
      skuRegionListingCount: String(group.length),
      skuRegionActiveListingCount: String(activeCount),
      skuRegionAvailableQty: String(sameAvailable),
      skuRegionLingxingStatuses: statusSummary,
      listingSkuCount: String(skuValues.length),
      listingSkuCodes: skuValues.join('\n'),
      listingStockedSkuCodes: uniqueTextValues(stockedSkuCodes).map(sku => {
        const skuRows = group.filter(row => rowSkuKeys(row).includes(normalizeKey(sku)));
        const qty = sumUniqueNumericByKey(skuRows, row => `${normalizeKey(sku)}::${row.regionGroup || backendRegionGroup(row.site)}`, row => row.siteMatchedAvailableQty || row.skuRegionAvailableQty || row.availableQty);
        return `${sku}:${qty}`;
      }).join('\n'),
      listingPriceDetails: uniqueJoined(group.map(row => row.listingPriceDetails), '\n'),
      listingSkuInventory: skuValues.map(sku => {
        const skuRows = group.filter(row => rowSkuKeys(row).includes(normalizeKey(sku)));
        const qty = sumUniqueNumericByKey(skuRows, row => `${normalizeKey(sku)}::${row.regionGroup || backendRegionGroup(row.site)}`, row => row.siteMatchedAvailableQty || row.skuRegionAvailableQty || row.availableQty);
        return `${sku}:${qty}`;
      }).join('\n'),
      listingSkuDetails: uniqueJoined(group.map(row => row.listingSkuDetails), '\n'),
      lingxingDeclarePrice: uniqueJoined(group.map(row => row.lingxingDeclarePrice), '\n'),
      inventoryMatchStatus: group.some(row => row.inventoryMatchStatus === '后台SKU+仓库匹配') ? '后台SKU+仓库匹配' : representative.inventoryMatchStatus,
      warehouseRegionMatchStatus: sameAvailable > 0 ? '同区匹配' : unknownAvailable > 0 ? '仓库地区待确认' : otherAvailable > 0 ? '其他区域有库存' : representative.warehouseRegionMatchStatus,
      warehouseSource: uniqueJoined(group.map(row => row.warehouseSource), ','),
      warehouseSku: uniqueJoined(group.map(row => row.warehouseSku), ','),
      warehouse: uniqueJoined(group.map(row => row.warehouse), ','),
      otherRegionWarehouse: uniqueJoined(group.map(row => row.otherRegionWarehouse), ','),
      unknownRegionWarehouse: uniqueJoined(group.map(row => row.unknownRegionWarehouse), ','),
      unknownRegionWarehouseSku: uniqueJoined(group.map(row => row.unknownRegionWarehouseSku), ','),
      availableQty: String(sameAvailable),
      siteMatchedAvailableQty: String(sameAvailable),
      otherRegionAvailableQty: String(otherAvailable),
      unknownRegionAvailableQty: String(unknownAvailable),
      inStockQty: String(inStock),
      frozenQty: String(frozen),
      onWayQty: String(onWay),
      pendingQty: String(pending),
      backendMergedRowCount: String(group.length),
      backendMergedSites: siteValues.join(','),
      backendMergedStatuses: statusSummary
    };
  });

  return [...passthrough, ...aggregated];
}

function recomputeBackendInventoryAlerts(rows) {
  const activeSkuKeys = new Set();
  for (const row of rows) {
    if (!isActiveStatus(row.status)) continue;
    for (const skuKey of rowSkuKeys(row)) activeSkuKeys.add(skuKey);
  }

  return rows.map(row => {
    if (row.source !== 'backend') return row;
    const regionGroup = row.regionGroup || backendRegionGroup(row.site);
    const stockScope = regionGroup === '多区域' ? '多区域' : `${regionGroup}同区`;
    const available = firstNumber(row.siteMatchedAvailableQty || row.skuRegionAvailableQty || row.availableQty) || 0;
    const unknownRegionAvailable = firstNumber(row.unknownRegionAvailableQty) || 0;
    const active = isActiveStatus(row.status);
    const hasActiveSkuListing = rowSkuKeys(row).some(skuKey => activeSkuKeys.has(skuKey));
    let stockAction = '正常';
    let reason = `后台${row.status || '空状态'}，${stockScope}可用库存 ${available}`;
    let hasInventoryButOffShelf = '否';
    if (active && available <= 0) {
      if (unknownRegionAvailable > 0) {
        stockAction = '仓库地区待确认';
        reason = `后台显示该链接在${regionGroup}为在售状态，${stockScope}可用库存为0；仓库有 ${unknownRegionAvailable} 个可用库存但地区未识别，先确认仓库地区后再处理`;
      } else {
        stockAction = '有在卖但没可用库存';
        reason = `后台显示该链接在${regionGroup}为在售状态，但${stockScope}可用库存为0，需要及时下架或补库存`;
      }
    } else if (!active && available > 0 && !hasActiveSkuListing) {
      stockAction = '有库存但无在卖链接';
      hasInventoryButOffShelf = '是';
      reason = `后台显示该链接未在售，且${stockScope}可用库存 ${available}，没有同SKU正在售卖的链接，需要处理`;
    } else if (!active && available > 0 && hasActiveSkuListing) {
      reason = '后台显示该链接未在售，但同SKU已有其他链接在售，不单独提醒当前链接';
    } else if (!active && available <= 0 && unknownRegionAvailable > 0 && !hasActiveSkuListing) {
      stockAction = '仓库地区待确认';
      reason = `后台显示该链接未在售，${stockScope}可用库存为0；仓库有 ${unknownRegionAvailable} 个可用库存但地区未识别，不自动判定为有库存无在卖`;
    }
    return {
      ...row,
      stockAction,
      inventoryAlertReason: reason,
      hasInventoryButOffShelf
    };
  });
}

function mergeBackendRowsIntoInventoryRows(inventoryRows, backendRows, ownerIndex, detailRows = []) {
  const bySpu = groupRowsBySpu(inventoryRows);
  const selectedBackendRows = backendRowsForMode(backendRows, false)
    .map(row => normalizeBackendStoreFromLingxing(row, bySpu));
  if (!selectedBackendRows.length) {
    return {
      rows: inventoryRows,
      stats: {
        backend_rows: backendRows.length,
        backend_added_rows: 0,
        backend_overlaid_spus: 0
      }
    };
  }

  const backendSpus = new Set(selectedBackendRows.map(row => normalizeKey(row.platformSpu)).filter(Boolean));
  const rows = inventoryRows.filter(row => {
    const spuKey = normalizeKey(row.platformSpu);
    return !spuKey || !backendSpus.has(spuKey);
  });
  let added = 0;
  let skippedBackendRows = 0;
  const overlaidSpus = new Set();

  selectedBackendRows.forEach((backend, index) => {
    const baseRows = bySpu.get(normalizeKey(backend.platformSpu)) || [];
    const base = findBaseRowForBackend(backend, baseRows);
    const detailSummary = warehouseSummaryForBackend(backend, detailRows);
    if (!base && !isBackendActive(backend) && !backendHasWarehouseStock(detailSummary)) {
      skippedBackendRows++;
      return;
    }
    if (!base) added++;
    else overlaidSpus.add(normalizeKey(backend.platformSpu));
    const row = normalizeRowStoreRegion(applyBackendToInventoryRow(backend, base, index, detailRows));
    const ownerMatch = ownerMatchForSkuValues(
      [row.skuCode, row.listingSkuCodes, row.listingStockedSkuCodes, row.listingSkuInventory, row.listingSkuDetails],
      ownerIndex,
      [row.skuName, row.title, row.listingSkuDetails],
      row
    );
    row.owner = ownerMatch.owner;
    row.ownerStatus = ownerMatch.ownerStatus;
    row.ownerMatchType = ownerMatch.ownerMatchType;
    row.ownerMatchScore = ownerMatch.ownerMatchScore;
    row.ownerMatchText = ownerMatch.ownerMatchText;
    rows.push(row);
  });

  const aggregatedRows = aggregateInventoryBackendRowsBySpu(rows);
  return {
    rows: recomputeBackendInventoryAlerts(aggregatedRows),
    stats: {
      backend_rows: backendRows.length,
      backend_added_rows: added,
      backend_overlaid_spus: overlaidSpus.size,
      backend_skipped_inactive_no_stock_rows: skippedBackendRows,
      backend_spu_deduped_rows: rows.length - aggregatedRows.length
    }
  };
}

function fromLingxingPrice(row, official, matchStatus, index, ownerIndex) {
  const priceContext = {
    ...row,
    site: row.site || official?.site || '',
    area: row.area || official?.area || '',
    officialSite: official?.officialSite || row.officialSite || '',
    officialUrl: official?.officialUrl || row.officialUrl || ''
  };
  const ref = referencePrice(priceContext);
  const status = priceStatus({
    ...priceContext,
    officialPrice: official?.officialPrice || '',
    officialCurrency: official?.officialCurrency || '',
    officialSite: official?.officialSite || row.officialSite || ''
  });
  const ownerMatch = ownerMatchForSkuValues([row.skuCode], ownerIndex, [row.skuName, row.title], row);
  const imageSimilarity = official ? imageSimilarityForRows(row, official) : '';
  const baseRow = {
    id: `price-lx-${row.platformSpu || 'spu'}-${row.skcId || row.skuId || index}`,
    sourceSide: row.source === 'backend' ? 'TEMU后台' : '领星',
    image: row.image || official?.image || '',
    lingxingImage: row.image || '',
    officialImage: official?.image || '',
    lingxingImageHash: row.imageHash || row.lingxingImageHash || '',
    officialImageHash: official?.imageHash || official?.officialImageHash || '',
    imageSimilarity: imageSimilarity === '' ? '' : String(imageSimilarity),
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
    backendOnly: row.backendOnly || '',
    backendMatchedLingxing: row.backendMatchedLingxing || '',
    backendProductStatus: row.backendProductStatus || '',
    backendDeclarePriceStatus: row.backendDeclarePriceStatus || '',
    backendOperatingSites: row.backendOperatingSites || '',
    backendPriceSite: row.backendPriceSite || '',
    backendInventoryQty: row.backendInventoryQty || '',
    status: row.status,
    storeName: row.storeName,
    area: row.area,
    site: row.site || '',
    storeRegion: rowStoreRegion(row),
    mallId: official?.mallId || '',
    goodsId: official?.goodsId || '',
    title: row.title,
    backendTitleCn: row.backendTitleCn || '',
    backendTranslatedTitle: row.backendTranslatedTitle || '',
    backendEnglishTitle: row.backendEnglishTitle || '',
    backendMachineTranslatedTitle: row.backendMachineTranslatedTitle || '',
    officialTitle: official?.title || '',
    officialMachineTranslatedTitle: official?.machineTranslatedTitle || '',
    category: row.category,
    brand: row.brand,
    lingxingDeclarePrice: row.lingxingDeclarePrice,
    lingxingDeclareCurrency: row.lingxingDeclareCurrency,
    lingxingActivityPrice: row.lingxingActivityPrice,
    declareCostPrice: ref.comparisonValue === null ? '' : formatNumber(ref.comparisonValue),
    vatRate: String(ref.vatRate || 0),
    referencePrice: ref.value === null ? '' : String(ref.value),
    referencePriceType: ref.type,
    referenceCurrency: ref.currency,
    officialPrice: official?.officialPrice || '',
    officialSite: official?.officialSite || '',
    officialCurrency: status.officialCurrency || official?.officialCurrency || '',
    officialComparablePrice: status.officialComparablePrice || '',
    officialComparableCurrency: status.officialComparableCurrency || '',
    currencyConversionRate: status.currencyConversionRate || '',
    currencyWarning: status.currencyWarning || '',
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
  return official ? aggregateOfficialFields(baseRow, [officialDetailForPriceRow(row, official)]) : baseRow;
}

function fromOfficialPrice(official, index, ownerIndex) {
  const ownerMatch = ownerMatchForSkuValues([official.skuCode], ownerIndex, [official.skuName, official.title], official);
  return {
    id: `price-official-${official.mallId || 'mall'}-${official.goodsId || normalizeKey(official.title) || index}`,
    sourceSide: 'TEMU官方',
    image: official.image,
    lingxingImage: '',
    officialImage: official.image,
    lingxingImageHash: '',
    officialImageHash: official.imageHash || official.officialImageHash || '',
    imageSimilarity: '',
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
    officialMachineTranslatedTitle: official.machineTranslatedTitle || '',
    category: '',
    brand: '',
    lingxingDeclarePrice: '',
    lingxingDeclareCurrency: '',
    lingxingActivityPrice: '',
    declareCostPrice: '',
    vatRate: '',
    referencePrice: '',
    referencePriceType: '',
    referenceCurrency: '',
    officialPrice: official.officialPrice,
    officialSite: official.officialSite || official.site || '',
    officialCurrency: official.officialCurrency,
    officialComparablePrice: '',
    officialComparableCurrency: '',
    currencyConversionRate: '',
    currencyWarning: '',
    officialUrl: official.officialUrl,
    priceDiff: '',
    priceDiffRate: '',
    priceAlert: OFFICIAL_UNMATCHED_BACKEND_STATUS,
    priceOver20: '否',
    matchStatus: OFFICIAL_UNMATCHED_BACKEND_STATUS,
    salesAmount: '',
    orderCount: '',
    volume: '',
    salesProfit: ''
  };
}

function fromUploadedOfficialPrice(official, index) {
  return {
    id: `price-official-${official.mallId || 'mall'}-${official.goodsId || normalizeKey(official.title) || index}`,
    sourceSide: 'TEMU官方',
    image: official.image,
    lingxingImage: '',
    officialImage: official.image,
    lingxingImageHash: '',
    officialImageHash: official.imageHash || official.officialImageHash || '',
    imageSimilarity: '',
    platformSpu: '',
    skuId: '',
    skcId: '',
    skuCode: official.skuCode,
    skuName: official.skuName,
    owner: '',
    ownerStatus: '',
    ownerMatchType: '',
    ownerMatchScore: '',
    ownerMatchText: '',
    status: '',
    storeName: official.storeName,
    area: official.area,
    site: official.site || '',
    storeRegion: rowStoreRegion(official),
    mallId: official.mallId,
    goodsId: official.goodsId,
    title: '',
    officialTitle: official.title,
    officialMachineTranslatedTitle: official.machineTranslatedTitle || '',
    category: '',
    brand: '',
    lingxingDeclarePrice: '',
    lingxingDeclareCurrency: '',
    lingxingActivityPrice: '',
    declareCostPrice: '',
    vatRate: '',
    referencePrice: '',
    referencePriceType: '',
    referenceCurrency: '',
    officialPrice: official.officialPrice,
    officialSite: official.officialSite || official.site || '',
    officialCurrency: official.officialCurrency,
    officialComparablePrice: '',
    officialComparableCurrency: '',
    currencyConversionRate: '',
    currencyWarning: '',
    officialUrl: official.officialUrl,
    priceDiff: '',
    priceDiffRate: '',
    priceAlert: OFFICIAL_UNMATCHED_BACKEND_STATUS,
    priceOver20: '否',
    matchStatus: OFFICIAL_UNMATCHED_BACKEND_STATUS,
    salesAmount: '',
    orderCount: '',
    volume: '',
    salesProfit: ''
  };
}

function applyOfficialToPriceRow(row, official, matchStatus) {
  const priceContext = {
    ...row,
    site: row.site || official?.site || '',
    area: row.area || official?.area || '',
    officialSite: official?.officialSite || row.officialSite || '',
    officialUrl: official?.officialUrl || row.officialUrl || ''
  };
  const ref = referencePrice(priceContext);
  const status = priceStatus({
    ...priceContext,
    officialPrice: official?.officialPrice || '',
    officialCurrency: official?.officialCurrency || '',
    officialSite: official?.officialSite || row.officialSite || ''
  });
  const lingxingImage = row.lingxingImage || row.image || '';
  const officialImage = official?.image || '';
  const imageSimilarity = official ? imageSimilarityForRows(row, official) : '';
  const baseRow = {
    ...row,
    sourceSide: row.sourceSide || 'TEMU后台',
    image: lingxingImage || officialImage,
    lingxingImage,
    officialImage,
    lingxingImageHash: row.imageHash || row.lingxingImageHash || '',
    officialImageHash: official?.imageHash || official?.officialImageHash || '',
    imageSimilarity: imageSimilarity === '' ? '' : String(imageSimilarity),
    storeRegion: row.storeRegion || rowStoreRegion(row),
    mallId: official?.mallId || '',
    goodsId: official?.goodsId || '',
    officialTitle: official?.title || '',
    officialMachineTranslatedTitle: official?.machineTranslatedTitle || '',
    declareCostPrice: ref.comparisonValue === null ? '' : formatNumber(ref.comparisonValue),
    vatRate: String(ref.vatRate || 0),
    referencePrice: ref.value === null ? '' : String(ref.value),
    referencePriceType: ref.type,
    referenceCurrency: ref.currency,
    officialPrice: official?.officialPrice || '',
    officialSite: official?.officialSite || '',
    officialCurrency: status.officialCurrency || official?.officialCurrency || '',
    officialComparablePrice: status.officialComparablePrice || '',
    officialComparableCurrency: status.officialComparableCurrency || '',
    currencyConversionRate: status.currencyConversionRate || '',
    currencyWarning: status.currencyWarning || '',
    officialUrl: official?.officialUrl || '',
    priceDiff: status.diff,
    priceDiffRate: status.diffRate,
    priceAlert: status.state,
    priceOver20: status.over20,
    matchStatus
  };
  return official ? aggregateOfficialFields(baseRow, [officialDetailForPriceRow(row, official)]) : baseRow;
}

async function mergeOfficialRowsIntoPriceSnapshotAsync(snapshot, rawOfficialRows) {
  const officialRows = normalizeOfficial(rawOfficialRows);
  const sourceRows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const backendRows = sourceRows.filter(row =>
    row.sourceSide !== 'TEMU官方' &&
    row.matchStatus !== OFFICIAL_UNMATCHED_BACKEND_STATUS &&
    row.matchStatus !== '官方未匹配领星'
  );
  const cache = new Map();
  await hydrateImageHashes(officialRows, { cache });
  await hydrateImageHashes(backendRows, { cache });
  const translation = await translatePriceMatchingTitles({ officialRows, backendRows });
  return mergeOfficialRowsIntoPriceSnapshotFromRows(snapshot, officialRows, { translation });
}

function mergeOfficialRowsIntoPriceSnapshot(snapshot, rawOfficialRows) {
  return mergeOfficialRowsIntoPriceSnapshotFromRows(snapshot, normalizeOfficial(rawOfficialRows));
}

function mergeOfficialRowsIntoPriceSnapshotFromRows(snapshot, officialRows, options = {}) {
  const sourceRows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const backendRows = sourceRows.filter(row =>
    row.sourceSide !== 'TEMU官方' &&
    row.matchStatus !== OFFICIAL_UNMATCHED_BACKEND_STATUS &&
    row.matchStatus !== '官方未匹配领星'
  );
  const usedOfficial = new Set();

  const rows = backendRows.map(row => applyOfficialToPriceRow(row, null, BACKEND_UNMATCHED_OFFICIAL_STATUS));
  rows.forEach((row, index) => {
    if (PRICE_MATCH_STATUSES.has(row.matchStatus)) return;
    const match = bestOfficialMatchForRow(backendRows[index], officialRows.filter(official => !usedOfficial.has(official)), 'store-site');
    if (!match?.official) return;
    usedOfficial.add(match.official);
    rows[index] = applyOfficialToPriceRow(backendRows[index], match.official, match.matchStatus);
  });

  for (const official of officialRows) {
    if (usedOfficial.has(official)) continue;
    const rowMatch = bestRowMatchForOfficial(official, rows, 'store-site');
    if (rowMatch?.row) {
      usedOfficial.add(official);
      Object.assign(rowMatch.row, aggregateOfficialFields(
        {
          ...rowMatch.row,
          matchStatus: PRICE_MATCH_STATUSES.has(rowMatch.row.matchStatus) ? rowMatch.row.matchStatus : rowMatch.matchStatus
        },
        [officialDetailForPriceRow(rowMatch.row, official)]
      ));
    }
  }

  for (const [index, official] of officialRows.entries()) {
    if (usedOfficial.has(official)) continue;
    if (hasSameStoreBackendTitleMatch(official, backendRows, 'store-site')) continue;
    rows.push(fromUploadedOfficialPrice(official, index));
  }

  const stores = new Set(rows.map(row => row.storeRegion).filter(Boolean));
  const now = new Date().toISOString();
  const summary = {
    ...(snapshot?.summary || {}),
    temu_official_rows: officialRows.length,
    merged_rows: rows.length,
    matched_rows: priceMatchCount(rows),
    title_translation_enabled: options.translation?.enabled ? '是' : '否',
    title_translation_provider: options.translation?.provider || '',
    title_translation_target: options.translation?.target || '',
    title_translation_requested: options.translation?.requested || 0,
    title_translation_cache_hits: options.translation?.cacheHits || 0,
    title_translation_new_rows: options.translation?.translatedCount || 0,
    title_translation_failed_rows: options.translation?.failedCount || 0,
    unmatched_backend_rows: rows.filter(row => row.matchStatus === BACKEND_UNMATCHED_OFFICIAL_STATUS).length,
    unmatched_frontend_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
    unmatched_lingxing_rows: 0,
    unmatched_official_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
    price_alert_rows: rows.filter(row => row.priceOver20 === '是').length,
    price_diff_rows: rows.filter(row => row.priceDiff !== '' && Number(row.priceDiff) !== 0).length,
    store_count: stores.size
  };

  return {
    ...(snapshot || {}),
    generated_at: now,
    mode: 'price',
    sources: {
      ...(snapshot?.sources || {}),
      temu_official: {
        type: 'upload',
        row_count: officialRows.length,
        updated_at: now
      }
    },
    summary,
    rows
  };
}

function matchPriceRows(backendRows, officialRows, ownerIndex) {
  const usedOfficial = new Set();

  const rows = backendRows.map((row, index) => fromLingxingPrice(row, null, BACKEND_UNMATCHED_OFFICIAL_STATUS, index, ownerIndex));
  rows.forEach((row, index) => {
    if (PRICE_MATCH_STATUSES.has(row.matchStatus)) return;
    const match = bestOfficialMatchForRow(backendRows[index], officialRows.filter(official => !usedOfficial.has(official)), 'store-site');
    if (!match?.official) return;
    usedOfficial.add(match.official);
    rows[index] = fromLingxingPrice(backendRows[index], match.official, match.matchStatus, index, ownerIndex);
  });

  for (const official of officialRows) {
    if (usedOfficial.has(official)) continue;
    const rowMatch = bestRowMatchForOfficial(official, rows, 'store-site');
    if (rowMatch?.row) {
      usedOfficial.add(official);
      Object.assign(rowMatch.row, aggregateOfficialFields(
        {
          ...rowMatch.row,
          matchStatus: PRICE_MATCH_STATUSES.has(rowMatch.row.matchStatus) ? rowMatch.row.matchStatus : rowMatch.matchStatus
        },
        [officialDetailForPriceRow(rowMatch.row, official)]
      ));
    }
  }

  for (const [index, official] of officialRows.entries()) {
    if (usedOfficial.has(official)) continue;
    if (hasSameStoreBackendTitleMatch(official, backendRows, 'store-site')) continue;
    rows.push(fromOfficialPrice(official, index, ownerIndex));
  }

  return rows;
}

async function matchPriceRowsAsync(backendRows, officialRows, ownerIndex) {
  const translation = await translatePriceMatchingTitles({ officialRows, backendRows });
  return {
    rows: matchPriceRows(backendRows, officialRows, ownerIndex),
    translation
  };
}

async function buildPriceDataFromBackendAndOfficialRowsAsync(rawBackendRows = [], rawOfficialRows = [], options = {}) {
  const backendSourceFile = options.backendSourceFile || options.backendSource?.file || 'TEMU后台上传数据';
  const backendRows = normalizeBackendExport(rawBackendRows, backendSourceFile);
  const officialRows = normalizeOfficial(rawOfficialRows);
  const ownerIndex = options.ownerIndex || loadSkuOwnerIndex();
  const backendPriceRows = backendRowsForPrice(backendRows);
  const cache = new Map();
  await hydrateImageHashes(officialRows, { cache });
  await hydrateImageHashes(backendPriceRows, { cache });
  const matched = await matchPriceRowsAsync(backendPriceRows, officialRows, ownerIndex);
  const rows = matched.rows;
  const stores = new Set(rows.map(row => row.storeRegion).filter(Boolean));
  const now = new Date().toISOString();

  return {
    generated_at: now,
    mode: 'price',
    sources: {
      temu_backend: options.backendSource || {
        type: 'upload_rows',
        row_count: rawBackendRows.length,
        updated_at: now
      },
      temu_official: options.officialSource || {
        type: rawOfficialRows.length ? 'upload_rows' : 'empty',
        row_count: rawOfficialRows.length,
        updated_at: now
      },
      sku_owner_mapping: fileInfo(skuOwnerFile())
    },
    summary: {
      lingxing_rows: 0,
      lingxing_raw_rows: 0,
      excluded_store_rows: 0,
      excluded_void_status_rows: 0,
      temu_backend_rows: backendRows.length,
      temu_backend_price_rows: backendPriceRows.length,
      temu_backend_added_rows: backendPriceRows.length,
      temu_backend_overlaid_spus: 0,
      temu_official_rows: officialRows.length,
      merged_rows: rows.length,
      matched_rows: priceMatchCount(rows),
      title_translation_enabled: matched.translation?.enabled ? '是' : '否',
      title_translation_provider: matched.translation?.provider || '',
      title_translation_target: matched.translation?.target || '',
      title_translation_requested: matched.translation?.requested || 0,
      title_translation_cache_hits: matched.translation?.cacheHits || 0,
      title_translation_new_rows: matched.translation?.translatedCount || 0,
      title_translation_failed_rows: matched.translation?.failedCount || 0,
      unmatched_backend_rows: rows.filter(row => row.matchStatus === BACKEND_UNMATCHED_OFFICIAL_STATUS).length,
      unmatched_frontend_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
      unmatched_lingxing_rows: 0,
      unmatched_official_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
      price_alert_rows: rows.filter(row => row.priceOver20 === '是').length,
      price_diff_rows: rows.filter(row => row.priceDiff !== '' && Number(row.priceDiff) !== 0).length,
      store_count: stores.size
    },
    rows
  };
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
  const unknownRegionAvailableQty = firstNumber(row.unknownRegionAvailableQty) || 0;
  if (availableQty <= 0 && unknownRegionAvailableQty > 0) return '仓库地区待确认';
  if (activeCount > 0 && availableQty <= 0) return '有在卖但没可用库存';
  if (activeCount <= 0 && availableQty > 0) return '有库存但无在卖链接';
  return '正常';
}

function stockCheckType(row) {
  if (row.stockAction === '库存源异常') return '异常';
  if (row.stockAction === '有在卖但没可用库存') return '强提醒';
  if (row.stockAction === '有库存但无在卖链接') return '需处理';
  if (row.stockAction === '公司有库存但TEMU无在卖') return '需处理';
  if (row.stockAction === '仓库地区待确认') return '需核对';
  return '正常';
}

function loadPriceData() {
  const officialFile = newest(TEMU_OFFICIAL_FILES);
  const ownerFile = skuOwnerFile();
  const backendFile = findBackendExportFile();
  const key = cacheKey([
    { file: officialFile, mtime: fileMtime(officialFile) },
    { file: ownerFile, mtime: fileMtime(ownerFile) },
    { file: backendFile, mtime: fileMtime(backendFile) }
  ]);
  if (priceDataCache?.key === key) return priceDataCache.data;

  const official = readOfficial();
  const backend = readBackendExport();
  const ownerIndex = loadSkuOwnerIndex();
  const backendPriceRows = backendRowsForPrice(backend.rows);
  const rows = matchPriceRows(backendPriceRows, official.rows, ownerIndex);
  const stores = new Set(rows.map(row => row.storeRegion).filter(Boolean));

  const data = {
    generated_at: new Date().toISOString(),
    mode: 'price',
    sources: {
      temu_backend: backend.source,
      temu_official: official.source,
      sku_owner_mapping: fileInfo(skuOwnerFile())
    },
    summary: {
      lingxing_rows: 0,
      lingxing_raw_rows: 0,
      excluded_store_rows: 0,
      excluded_void_status_rows: 0,
      temu_backend_rows: backend.rows.length,
      temu_backend_price_rows: backendPriceRows.length,
      temu_backend_added_rows: backendPriceRows.length,
      temu_backend_overlaid_spus: 0,
      temu_official_rows: official.rows.length,
      merged_rows: rows.length,
      matched_rows: priceMatchCount(rows),
      unmatched_backend_rows: rows.filter(row => row.matchStatus === BACKEND_UNMATCHED_OFFICIAL_STATUS).length,
      unmatched_frontend_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
      unmatched_lingxing_rows: 0,
      unmatched_official_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
      price_alert_rows: rows.filter(row => row.priceOver20 === '是').length,
      price_diff_rows: rows.filter(row => row.priceDiff !== '' && Number(row.priceDiff) !== 0).length,
      store_count: stores.size
    },
    rows
  };
  priceDataCache = { key, data };
  return data;
}

async function loadPriceDataAsync() {
  const officialFile = newest(TEMU_OFFICIAL_FILES);
  const ownerFile = skuOwnerFile();
  const backendFile = findBackendExportFile();
  const key = cacheKey([
    { file: officialFile, mtime: fileMtime(officialFile) },
    { file: ownerFile, mtime: fileMtime(ownerFile) },
    { file: backendFile, mtime: fileMtime(backendFile) },
    { file: process.env.PRICE_TITLE_TRANSLATION_CACHE_FILE || path.join(DATA_DIR, 'translation-cache.json'), mtime: fileMtime(process.env.PRICE_TITLE_TRANSLATION_CACHE_FILE || path.join(DATA_DIR, 'translation-cache.json')) }
  ]);
  if (priceDataCache?.key === key) return priceDataCache.data;

  const official = readOfficial();
  const backend = readBackendExport();
  const ownerIndex = loadSkuOwnerIndex();
  const backendPriceRows = backendRowsForPrice(backend.rows);
  const matched = await matchPriceRowsAsync(backendPriceRows, official.rows, ownerIndex);
  const rows = matched.rows;
  const stores = new Set(rows.map(row => row.storeRegion).filter(Boolean));

  const data = {
    generated_at: new Date().toISOString(),
    mode: 'price',
    sources: {
      temu_backend: backend.source,
      temu_official: official.source,
      sku_owner_mapping: fileInfo(skuOwnerFile())
    },
    summary: {
      lingxing_rows: 0,
      lingxing_raw_rows: 0,
      excluded_store_rows: 0,
      excluded_void_status_rows: 0,
      temu_backend_rows: backend.rows.length,
      temu_backend_price_rows: backendPriceRows.length,
      temu_backend_added_rows: backendPriceRows.length,
      temu_backend_overlaid_spus: 0,
      temu_official_rows: official.rows.length,
      merged_rows: rows.length,
      matched_rows: priceMatchCount(rows),
      title_translation_enabled: matched.translation?.enabled ? '是' : '否',
      title_translation_provider: matched.translation?.provider || '',
      title_translation_target: matched.translation?.target || '',
      title_translation_requested: matched.translation?.requested || 0,
      title_translation_cache_hits: matched.translation?.cacheHits || 0,
      title_translation_new_rows: matched.translation?.translatedCount || 0,
      title_translation_failed_rows: matched.translation?.failedCount || 0,
      unmatched_backend_rows: rows.filter(row => row.matchStatus === BACKEND_UNMATCHED_OFFICIAL_STATUS).length,
      unmatched_frontend_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
      unmatched_lingxing_rows: 0,
      unmatched_official_rows: rows.filter(row => row.matchStatus === OFFICIAL_UNMATCHED_BACKEND_STATUS).length,
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
  const backendFile = findBackendExportFile();
  const key = cacheKey([
    { file: WAREHOUSE_INVENTORY_CSV, mtime: fileMtime(WAREHOUSE_INVENTORY_CSV) },
    { file: WAREHOUSE_INVENTORY_XLSX, mtime: fileMtime(WAREHOUSE_INVENTORY_XLSX) },
    { file: LINGXING_INVENTORY_CSV, mtime: fileMtime(LINGXING_INVENTORY_CSV) },
    { file: ownerFile, mtime: fileMtime(ownerFile) },
    { file: backendFile, mtime: fileMtime(backendFile) }
  ]);
  if (inventoryDataCache?.key === key) return inventoryDataCache.data;

  const ownerIndex = loadSkuOwnerIndex();
  const backend = readBackendExport();
  const inventoryRows = normalizeInventory(readSheet(WAREHOUSE_INVENTORY_CSV), ownerIndex);
  const mergedInventory = mergeBackendRowsIntoInventoryRows(inventoryRows, backend.rows, ownerIndex, readWarehouseDetailRows());
  const filteredInventory = filterLingxingRows(mergedInventory.rows);
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
      temu_backend: backend.source,
      sku_owner_mapping: fileInfo(skuOwnerFile())
    },
    summary: {
      inventory_rows: inventory.rows.length,
      inventory_raw_rows: inventory.stats.raw_rows,
      excluded_store_rows: inventory.stats.excluded_store_rows,
      excluded_void_status_rows: inventory.stats.excluded_void_status_rows,
      temu_backend_rows: mergedInventory.stats.backend_rows,
      temu_backend_added_rows: mergedInventory.stats.backend_added_rows,
      temu_backend_overlaid_spus: mergedInventory.stats.backend_overlaid_spus,
      inventory_alert_rows: inventory.rows.filter(row => stockCheckType(row) === '强提醒' || stockCheckType(row) === '异常').length,
      has_inventory_but_off_shelf_rows: inventory.rows.filter(row => row.hasInventoryButOffShelf === '是').length,
      action_required_rows: inventory.rows.filter(row => stockCheckType(row) === '需处理').length,
      no_active_listing_with_stock_rows: inventory.rows.filter(row => row.stockAction === '有库存但无在卖链接').length,
      active_listing_no_available_stock_rows: inventory.rows.filter(row => row.stockAction === '有在卖但没可用库存').length,
      other_region_stock_rows: inventory.rows.filter(row => row.warehouseRegionMatchStatus === '其他区域有库存').length,
      unknown_region_stock_rows: inventory.rows.filter(row => row.warehouseRegionMatchStatus === '仓库地区待确认' || row.stockAction === '仓库地区待确认').length,
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
  buildPriceDataFromBackendAndOfficialRowsAsync,
  buildSkuOwnerIndexFromFile,
  fileInfo,
  loadDashboardData,
  loadInventoryData,
  loadPriceData,
  loadPriceDataAsync,
  mergeOfficialRowsIntoPriceSnapshot,
  mergeOfficialRowsIntoPriceSnapshotAsync,
  normalizeBackendExport,
  normalizeOfficial,
  normalizeKey,
  normalizeText,
  ownerMatchForSkuValues,
  skuOwnerFile,
  csvParse
};

