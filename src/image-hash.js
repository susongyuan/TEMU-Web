const sharp = require('sharp');

const HASH_SIZE = 8;
const HASH_BITS = HASH_SIZE * HASH_SIZE;
const MAX_IMAGE_BYTES = Number(process.env.IMAGE_HASH_MAX_BYTES || 6 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(process.env.IMAGE_HASH_FETCH_TIMEOUT_MS || 8000);
const IMAGE_HASH_CONCURRENCY = Math.max(1, Number(process.env.IMAGE_HASH_CONCURRENCY || 8));

function firstStringValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringValue(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'src', 'image', 'image_url', 'imageUrl', 'img', 'img_url', 'imgUrl', 'main_image', 'mainImage', 'thumbnail', 'thumb', 'cover', 'href']) {
      const found = firstStringValue(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = firstStringValue(item);
      if (found) return found;
    }
    return '';
  }
  return String(value || '').trim();
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractImageUrl(value) {
  let text = htmlDecode(firstStringValue(value)).trim();
  if (!text) return '';
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text);
      const found = extractImageUrl(parsed);
      if (found) return found;
    } catch {
      // Fall through to string parsing.
    }
  }

  const srcMatch = text.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  if (srcMatch) text = srcMatch[1].trim();
  const urlMatch = text.match(/https?:\/\/[^\s"',，；;<>]+/i) || text.match(/\/\/[^\s"',，；;<>]+/i);
  if (urlMatch) text = urlMatch[0];
  else text = text.split(/[；;,，\n\r]+/).map(item => item.trim()).filter(Boolean)[0] || '';

  text = text.replace(/^["']|["']$/g, '').trim();
  if (text.startsWith('//')) text = `https:${text}`;
  return /^https?:\/\//i.test(text) ? text : '';
}

function normalizedImageUrl(value) {
  const url = extractImageUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/g, '').toLowerCase();
  } catch {
    return url.trim().replace(/[?#].*$/g, '').replace(/\/+$/g, '').toLowerCase();
  }
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

function urlFingerprintSimilarity(left, right, diceSimilarity) {
  const leftUrl = normalizedImageUrl(left);
  const rightUrl = normalizedImageUrl(right);
  if (!leftUrl || !rightUrl) return 0;
  if (leftUrl === rightUrl) return 100;

  const leftBase = imageBasename(leftUrl);
  const rightBase = imageBasename(rightUrl);
  if (leftBase && rightBase && leftBase === rightBase && leftBase.length >= 8) return 100;

  const leftTokens = imageIdTokens(leftUrl);
  const rightTokens = imageIdTokens(rightUrl);
  const tokenHit = leftTokens.find(token => rightTokens.includes(token));
  if (tokenHit) return tokenHit.length >= 16 ? 98 : 94;

  const score = typeof diceSimilarity === 'function' ? diceSimilarity(leftUrl, rightUrl) : 0;
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

function hexToBits(hex) {
  return String(hex || '')
    .replace(/[^0-9a-f]/gi, '')
    .split('')
    .flatMap(char => Number.parseInt(char, 16).toString(2).padStart(4, '0').split(''));
}

function hammingDistance(leftHash, rightHash) {
  const left = hexToBits(leftHash);
  const right = hexToBits(rightHash);
  if (left.length !== HASH_BITS || right.length !== HASH_BITS) return null;
  let distance = 0;
  for (let index = 0; index < HASH_BITS; index += 1) {
    if (left[index] !== right[index]) distance += 1;
  }
  return distance;
}

function imageHashSimilarity(leftHash, rightHash) {
  const distance = hammingDistance(leftHash, rightHash);
  if (distance === null) return 0;
  return Math.round((1 - distance / HASH_BITS) * 100);
}

function bitsToHex(bits) {
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4).join(''), 2).toString(16);
  }
  return hex;
}

async function averageHashFromBuffer(buffer) {
  const pixels = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
  const values = [...pixels];
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return bitsToHex(values.map(value => value >= avg ? 1 : 0));
}

async function fetchImageResource(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://www.temu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const reader = response.body?.getReader();
    if (!reader) return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error('image too large');
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchImageBuffer(url) {
  const resource = await fetchImageResource(url);
  return resource.buffer;
}

async function hashImageUrl(url, cache = new Map()) {
  const normalized = normalizedImageUrl(url);
  if (!normalized) return { url: '', hash: '', error: 'empty image url' };
  if (cache.has(normalized)) return cache.get(normalized);

  const promise = (async () => {
    try {
      const buffer = await fetchImageBuffer(url);
      return { url, hash: await averageHashFromBuffer(buffer), error: '' };
    } catch (error) {
      return { url, hash: '', error: error.message || 'image hash failed' };
    }
  })();
  cache.set(normalized, promise);
  const result = await promise;
  cache.set(normalized, result);
  return result;
}

async function hydrateImageHash(row, cache = new Map()) {
  if (!row || typeof row !== 'object') return row;
  const url = extractImageUrl(
    row.image ||
    row.officialImage ||
    row.lingxingImage ||
    row['图片'] ||
    row['图片链接'] ||
    row['图片URL'] ||
    row['前端图片'] ||
    row['前端图片链接'] ||
    row['前端图片URL'] ||
    row['TEMU图片'] ||
    row['TEMU图片链接'] ||
    row['TEMU图片URL'] ||
    row['官方图片'] ||
    row['官方图片链接'] ||
    row['官方图片URL'] ||
    row.image_url ||
    row.imageUrl ||
    row.img ||
    row.img_url ||
    row.imgUrl ||
    row['主图'] ||
    row.main_image ||
    row.mainImage ||
    row.thumbnail ||
    row.thumb ||
    row.cover
  );
  if (url) row.image = url;
  if (row.imageHash || !url) return row;
  const result = await hashImageUrl(url, cache);
  row.imageHash = result.hash || '';
  row.imageHashError = result.error || '';
  return row;
}

async function hydrateImageHashes(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const cache = options.cache || new Map();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(IMAGE_HASH_CONCURRENCY, Math.max(1, list.length)) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await hydrateImageHash(list[index], cache);
    }
  });
  await Promise.all(workers);
  return list;
}

module.exports = {
  extractImageUrl,
  fetchImageBuffer,
  fetchImageResource,
  hydrateImageHash,
  hydrateImageHashes,
  imageHashSimilarity,
  normalizedImageUrl,
  urlFingerprintSimilarity
};
