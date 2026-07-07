const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CACHE_FILE = process.env.PRICE_TITLE_TRANSLATION_CACHE_FILE ||
  path.join(DATA_DIR, 'translation-cache.json');
const DEFAULT_PROVIDER = 'libretranslate';
const DEFAULT_TARGET_LANGUAGE = 'en';
const DEFAULT_BATCH_SIZE = 50;
const PUBLIC_GOOGLE_CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = Number(process.env.TRANSLATION_FETCH_TIMEOUT_MS || 12000);
const LOCAL_KEYWORD_CACHE_NAMESPACE = 'local-keyword-v2';
const LOCAL_KEYWORD_DICTIONARY = [
  ['人造竹子', 'artificial bamboo'],
  ['假竹', 'fake bamboo artificial bamboo'],
  ['竹子', 'bamboo'],
  ['竹', 'bamboo'],
  ['人造', 'artificial faux fake'],
  ['假植物', 'artificial plant faux plant'],
  ['植物', 'plant'],
  ['隐私屏障', 'privacy screen privacy fence'],
  ['庭院', 'patio yard garden'],
  ['露台', 'patio terrace'],
  ['花园', 'garden'],
  ['户外', 'outdoor'],
  ['室内', 'indoor'],
  ['装饰', 'decor decoration decorative'],
  ['墙饰', 'wall decor wall art'],
  ['飞鸟', 'bird birds'],
  ['鸟', 'bird'],
  ['雕塑', 'sculpture statue'],
  ['金属', 'metal'],
  ['树脂', 'resin'],
  ['金色', 'gold golden'],
  ['银杏', 'ginkgo'],
  ['地垫', 'mat rug floor mat'],
  ['门垫', 'doormat door mat'],
  ['排水', 'drainage drain'],
  ['防滑', 'non slip anti slip'],
  ['商业', 'commercial'],
  ['厨房', 'kitchen'],
  ['浴室', 'bathroom'],
  ['泳池', 'pool swimming pool'],
  ['车库', 'garage'],
  ['橡胶', 'rubber'],
  ['PVC', 'pvc'],
  ['走廊', 'hallway corridor runner'],
  ['地毯', 'carpet rug runner'],
  ['可水洗', 'washable'],
  ['灰色', 'gray grey'],
  ['书架', 'bookshelf bookcase shelf'],
  ['置物架', 'shelf rack storage rack'],
  ['收纳', 'storage organizer'],
  ['展示架', 'display stand display rack'],
  ['展示柜', 'display cabinet'],
  ['柜', 'cabinet'],
  ['桌面', 'desktop tabletop'],
  ['纸张', 'paper'],
  ['剪贴簿', 'scrapbook'],
  ['组织者', 'organizer'],
  ['托盘', 'tray'],
  ['烛台', 'candle holder candelabra candlestick'],
  ['蜡烛', 'candle'],
  ['水晶', 'crystal'],
  ['蛋糕架', 'cake stand'],
  ['香槟墙', 'champagne wall'],
  ['酒架', 'wine rack'],
  ['花瓶', 'vase'],
  ['花盆', 'pot planter'],
  ['仙人掌', 'cactus'],
  ['亚克力', 'acrylic'],
  ['透明', 'clear transparent'],
  ['哑铃', 'dumbbell'],
  ['转换杆', 'converter bar connecting rod'],
  ['举重', 'weight lifting'],
  ['滑轮', 'pulley'],
  ['健身', 'fitness gym workout'],
  ['训练', 'training'],
  ['高尔夫', 'golf'],
  ['推杆', 'putting putter'],
  ['钓鱼', 'fishing'],
  ['渔网', 'fishing net landing net'],
  ['干草网', 'hay net slow feeder'],
  ['马匹', 'horse'],
  ['山羊', 'goat'],
  ['尼龙', 'nylon'],
  ['喂食', 'feeding feeder'],
  ['帐篷', 'tent'],
  ['地钉', 'stake peg'],
  ['螺旋钻头', 'auger drill bit'],
  ['钻头', 'drill bit'],
  ['高速钢', 'high speed steel hss'],
  ['直柄', 'straight shank'],
  ['石膏板', 'drywall plasterboard'],
  ['木工', 'woodworking'],
  ['电动工具', 'power tool'],
  ['射箭', 'archery'],
  ['靶', 'target'],
  ['泡沫', 'foam'],
  ['弓', 'bow'],
  ['后院', 'backyard'],
  ['箭头', 'arrow'],
  ['拉取器', 'puller'],
  ['披萨石', 'pizza stone'],
  ['生态瓶', 'terrarium'],
  ['多肉', 'succulent'],
  ['马桶', 'toilet'],
  ['扶手', 'grab bar handrail safety rail'],
  ['安全', 'safety'],
  ['老人', 'elderly senior'],
  ['轮式', 'wheeled rolling'],
  ['屏风', 'room divider privacy screen'],
  ['支架', 'stand bracket holder rack'],
  ['壁挂', 'wall mounted hanging'],
  ['路由器', 'router'],
  ['线缆', 'cable'],
  ['马克杯', 'mug cup'],
  ['杯垫', 'coaster'],
  ['石板', 'slate'],
  ['天然', 'natural'],
  ['武士刀', 'katana sword'],
  ['剑架', 'sword stand sword rack'],
  ['木质', 'wooden wood'],
  ['黑色', 'black'],
  ['白色', 'white'],
  ['玫瑰金', 'rose gold'],
  ['加厚', 'thick heavy duty'],
  ['重型', 'heavy duty'],
  ['可调节', 'adjustable'],
  ['折叠', 'folding foldable'],
  ['可伸缩', 'telescopic retractable expandable'],
  ['双面', 'double sided'],
  ['A型', 'a frame'],
  ['广告', 'advertising'],
  ['菜单', 'menu'],
  ['户外活动', 'outdoor event'],
  ['防水', 'waterproof'],
  ['耐候', 'weather resistant'],
  ['厘米', 'cm'],
  ['英寸', 'inch'],
  ['件套', 'set'],
  ['片装', 'pack pieces'],
  ['株装', 'pack plants']
];
const LOCAL_EUROPEAN_DICTIONARY = [
  [/\bedelstahl\b/gi, 'stainless steel'],
  [/\bklapp[a-z]*\b/gi, 'folding foldable'],
  [/\barbeitstisch\b|\barbeitsstation\b/gi, 'work table workstation'],
  [/\bküche[nr]?\b|\bkueche[nr]?\b/gi, 'kitchen'],
  [/\bcatering\b/gi, 'catering'],
  [/\bbank\b/gi, 'bench'],
  [/\bgewerblich[a-z]*\b/gi, 'commercial'],
  [/\brednerpult\b|\bpult\b/gi, 'lectern podium'],
  [/\brädern\b|\braedern\b|\brad\b|\bräder\b|\braeder\b/gi, 'wheels rolling'],
  [/\bvortr[aä]g[a-z]*\b|\bvortraeg[a-z]*\b/gi, 'lecture presentation speech'],
  [/\bstauraum\b/gi, 'storage space'],
  [/\bkirche[n]?\b/gi, 'church'],
  [/\bbüro[s]?\b|\bbuero[s]?\b/gi, 'office'],
  [/\bschule[n]?\b/gi, 'school'],
  [/\bkonferenz[a-z]*\b/gi, 'conference meeting'],
  [/\brestaurant[s]?\b/gi, 'restaurant'],
  [/\bschuhschrank\b/gi, 'shoe cabinet'],
  [/\beingang[a-z]*\b|\beingangshalle\b/gi, 'entryway hallway'],
  [/\bschrank\b/gi, 'cabinet wardrobe'],
  [/\bteppich\b/gi, 'carpet rug'],
  [/\bkunstrasen\b|\bkünstlich[a-z]*\s+rasen\b|\bkuenstlich[a-z]*\s+rasen\b/gi, 'artificial grass turf'],
  [/\brolle\b/gi, 'roll'],
  [/\bgroß[a-z]*\b|\bgross[a-z]*\b/gi, 'large big'],
  [/\bgarten\b/gi, 'garden'],
  [/\bholz\b|\bholz[a-z]*\b/gi, 'wood wooden'],
  [/\bmetall\b|\bmetal\b/gi, 'metal'],
  [/\bregal\b|\bregale\b/gi, 'shelf rack'],
  [/\baufbewahrung\b/gi, 'storage organizer'],
  [/\bstraßenschwelle\b|\bstrassenschwelle\b|\bgummischwelle\b|\bgeschwindigkeitsbegrenzung\b/gi, 'speed bump rubber curb ramp threshold'],
  [/\bkabelbrücke\b|\bkabelbruecke\b|\bkabelkanal\b/gi, 'cable bridge cable channel cable protector'],
  [/\bdartboard\b|\bdartscheibe\b/gi, 'dartboard'],
  [/\bstativ\b/gi, 'stand tripod'],
  [/\bhöhenverstellbar\b|\bhoehenverstellbar\b|\bverstellbar\b/gi, 'adjustable height adjustable'],
  [/\bstabil[a-z]*\b/gi, 'stable heavy duty'],
  [/\bwand\b|\bwand[a-z]*\b/gi, 'wall'],
  [/\bständer\b|\bstaender\b/gi, 'stand holder'],
  [/\bpflanze[n]?\b|\bkünstliche\s+pflanze[n]?\b|\bkuenstliche\s+pflanze[n]?\b/gi, 'artificial plant'],
  [/\bfür\b|\bfuer\b/gi, 'for'],
  [/\bund\b/gi, 'and'],
  [/\bmit\b/gi, 'with'],
  [/\bohne\b/gi, 'without'],
  [/\bpour\b/gi, 'for'],
  [/\bavec\b/gi, 'with'],
  [/\bsans\b/gi, 'without'],
  [/\btapis\b/gi, 'carpet rug'],
  [/\bcuisine\b/gi, 'kitchen'],
  [/\bjardin\b/gi, 'garden'],
  [/\bmeuble\b/gi, 'cabinet furniture'],
  [/\bchaussure[s]?\b/gi, 'shoe'],
  [/\bmesa\b|\btable\b/gi, 'table'],
  [/\bsilla\b/gi, 'chair'],
  [/\bestante\b|\bestantería\b|\bestanteria\b/gi, 'shelf rack'],
  [/\balfombra\b/gi, 'carpet rug'],
  [/\bcocina\b/gi, 'kitchen'],
  [/\bjard[ií]n\b/gi, 'garden'],
  [/\btavolo\b/gi, 'table'],
  [/\bcucina\b/gi, 'kitchen'],
  [/\btappeto\b/gi, 'carpet rug'],
  [/\bgiardino\b/gi, 'garden']
];

let memoryCache = null;

function text(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return text(value).replace(/\s+/g, ' ').toLowerCase();
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/u.test(text(value));
}

function hasLatinDiacritics(value) {
  return /[À-ž]/u.test(text(value));
}

function hasEuropeanLanguageMarkers(value) {
  const source = normalizeText(value);
  if (!source) return false;
  if (hasLatinDiacritics(source)) return true;
  return /\b(fuer|für|und|mit|ohne|edelstahl|arbeitstisch|arbeitsstation|kueche|küche|schuhschrank|eingangshalle|kunstrasen|teppich|garten|aufbewahrung|schrank|pour|avec|sans|tapis|cuisine|jardin|meuble|chaussures|mesa|silla|estante|alfombra|cocina|jardin|tavolo|cucina|tappeto|giardino)\b/i.test(source);
}

function shouldTranslate(value, targetLanguage) {
  const source = text(value);
  if (!source) return false;
  const target = normalizeLanguage(targetLanguage);
  if (target.startsWith('en')) return hasCjk(source) || hasEuropeanLanguageMarkers(source);
  if (target.startsWith('zh')) return !hasCjk(source);
  return true;
}

function normalizeLanguage(value) {
  return text(value || DEFAULT_TARGET_LANGUAGE).toLowerCase();
}

function providerName() {
  const configured = text(process.env.PRICE_TITLE_TRANSLATION_PROVIDER || process.env.TRANSLATION_PROVIDER);
  if (configured) return configured.toLowerCase();
  if (microsoftTranslatorConfig().key) return 'microsoft';
  if (googleTranslateApiKey()) return 'google';
  return DEFAULT_PROVIDER;
}

function targetLanguage() {
  return normalizeLanguage(process.env.PRICE_TITLE_TRANSLATION_TARGET || process.env.TRANSLATION_TARGET || DEFAULT_TARGET_LANGUAGE);
}

function translationEnabled() {
  const provider = providerName();
  return provider && !['off', 'none', 'disabled', 'false', '0'].includes(provider);
}

function cacheKey(provider, target, value) {
  const providerKey = ['local-keyword', 'local'].includes(String(provider || '').toLowerCase())
    ? LOCAL_KEYWORD_CACHE_NAMESPACE
    : provider;
  const hash = createHash('sha1').update(`${providerKey}|${target}|${normalizeText(value)}`).digest('hex');
  return `${providerKey}:${target}:${hash}`;
}

function readCache() {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    memoryCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    memoryCache = {};
  }
  if (!memoryCache.items || typeof memoryCache.items !== 'object') memoryCache.items = {};
  return memoryCache;
}

function writeCache() {
  if (!memoryCache) return;
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    version: 1,
    updated_at: new Date().toISOString(),
    items: memoryCache.items || {}
  }, null, 2), 'utf8');
}

function uniqueTexts(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const source = text(value);
    const key = normalizeText(source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function decodeHtmlEntities(value) {
  return text(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function withTimeout(options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || FETCH_TIMEOUT_MS));
  return { controller, timeout };
}

function localEuropeanKeywordTranslate(value) {
  const source = text(value);
  if (!source || !hasEuropeanLanguageMarkers(source)) return '';
  const words = [];
  for (const [pattern, translated] of LOCAL_EUROPEAN_DICTIONARY) {
    if (pattern.test(source)) words.push(translated);
  }
  const numbers = source.match(/\d+(?:[.,]\d+)?\s*(?:x|×|X)?\s*\d*(?:[.,]\d+)?\s*(?:cm|m|inch|in|zoll)?/gi) || [];
  return [...new Set([...words, ...numbers])].join(' ').trim();
}

function localKeywordTranslate(value) {
  const source = text(value);
  if (!source) return '';
  if (!hasCjk(source)) return localEuropeanKeywordTranslate(source);
  const words = [];
  for (const [keyword, translated] of LOCAL_KEYWORD_DICTIONARY) {
    if (source.includes(keyword)) words.push(translated);
  }
  const numbers = source.match(/\d+(?:[.,]\d+)?\s*(?:x|×|X)?\s*\d*(?:[.,]\d+)?\s*(?:cm|厘米|m|米|英寸|inch|in)?/gi) || [];
  const colorWords = [];
  if (/灰|灰色/.test(source)) colorWords.push('gray grey');
  if (/黑|黑色/.test(source)) colorWords.push('black');
  if (/白|白色/.test(source)) colorWords.push('white');
  if (/金|金色/.test(source)) colorWords.push('gold golden');
  const translated = [...new Set([...words, ...colorWords, ...numbers.map(item => item.replace(/厘米/g, 'cm').replace(/米/g, 'm').replace(/英寸/g, 'inch'))])]
    .join(' ');
  return translated.trim();
}

function microsoftTranslatorConfig() {
  const key = text(
    process.env.MICROSOFT_TRANSLATOR_KEY ||
    process.env.AZURE_TRANSLATOR_KEY ||
    process.env.TRANSLATOR_TEXT_KEY
  );
  const region = text(
    process.env.MICROSOFT_TRANSLATOR_REGION ||
    process.env.AZURE_TRANSLATOR_REGION ||
    process.env.TRANSLATOR_TEXT_REGION
  );
  const endpoint = text(
    process.env.MICROSOFT_TRANSLATOR_ENDPOINT ||
    process.env.AZURE_TRANSLATOR_ENDPOINT ||
    'https://api.cognitive.microsofttranslator.com'
  ).replace(/\/+$/g, '');
  return { key, region, endpoint };
}

function libreTranslateConfig() {
  const url = text(
    process.env.LIBRETRANSLATE_URL ||
    process.env.LIBRE_TRANSLATE_URL ||
    process.env.LT_URL ||
    'http://127.0.0.1:5000'
  ).replace(/\/+$/g, '');
  const apiKey = text(
    process.env.LIBRETRANSLATE_API_KEY ||
    process.env.LIBRE_TRANSLATE_API_KEY ||
    process.env.LT_API_KEY
  );
  return { url, apiKey };
}

async function translateWithLibreTranslate(texts, target) {
  const { url, apiKey } = libreTranslateConfig();
  if (!url) throw new Error('Missing LIBRETRANSLATE_URL');
  const timeoutGuard = withTimeout();
  try {
    const body = {
      q: texts,
      source: 'auto',
      target,
      format: 'text'
    };
    if (apiKey) body.api_key = apiKey;
    const response = await fetch(`${url}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutGuard.controller.signal
    });
    if (!response.ok) throw new Error(`LibreTranslate failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const translated = data?.translatedText;
    if (Array.isArray(translated)) return translated.map(item => decodeHtmlEntities(item));
    if (texts.length === 1) return [decodeHtmlEntities(translated)];
    throw new Error('LibreTranslate returned an unexpected response shape');
  } finally {
    clearTimeout(timeoutGuard.timeout);
  }
}

async function translateWithMicrosoft(texts, target) {
  const { key, region, endpoint } = microsoftTranslatorConfig();
  if (!key) throw new Error('Missing MICROSOFT_TRANSLATOR_KEY/AZURE_TRANSLATOR_KEY');
  const url = `${endpoint}/translate?api-version=3.0&to=${encodeURIComponent(target)}`;
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': key
  };
  if (region) headers['Ocp-Apim-Subscription-Region'] = region;
  const timeoutGuard = withTimeout();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(texts.map(value => ({ Text: value }))),
      signal: timeoutGuard.controller.signal
    });
    if (!response.ok) throw new Error(`Microsoft Translator failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.map(item => text(item?.translations?.[0]?.text));
  } finally {
    clearTimeout(timeoutGuard.timeout);
  }
}

function googleTranslateApiKey() {
  return text(
    process.env.GOOGLE_TRANSLATE_API_KEY ||
    process.env.GOOGLE_CLOUD_TRANSLATE_API_KEY ||
    process.env.TRANSLATE_API_KEY
  );
}

async function translateWithGoogleCloud(texts, target) {
  const key = googleTranslateApiKey();
  if (!key) throw new Error('Missing GOOGLE_TRANSLATE_API_KEY/GOOGLE_CLOUD_TRANSLATE_API_KEY');
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`;
  const timeoutGuard = withTimeout();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, target, format: 'text' }),
      signal: timeoutGuard.controller.signal
    });
    if (!response.ok) throw new Error(`Google Cloud Translation failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return (data?.data?.translations || []).map(item => decodeHtmlEntities(item?.translatedText));
  } finally {
    clearTimeout(timeoutGuard.timeout);
  }
}

async function translateWithGooglePublicOne(value, target) {
  const url = 'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(value)}`;
  const timeoutGuard = withTimeout();
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 TEMU-dashboard-title-matcher'
      },
      signal: timeoutGuard.controller.signal
    });
    if (!response.ok) throw new Error(`Google public translate failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return text((data?.[0] || []).map(part => part?.[0] || '').join(''));
  } finally {
    clearTimeout(timeoutGuard.timeout);
  }
}

async function mapLimit(values, limit, fn) {
  const out = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const current = nextIndex++;
      out[current] = await fn(values[current], current);
    }
  });
  await Promise.all(workers);
  return out;
}

async function translateWithGooglePublic(texts, target) {
  return mapLimit(texts, PUBLIC_GOOGLE_CONCURRENCY, value => translateWithGooglePublicOne(value, target));
}

async function translateBatch(texts, provider, target) {
  if (provider === 'local-keyword' || provider === 'local') return texts.map(localKeywordTranslate);
  if (provider === 'libretranslate' || provider === 'libre' || provider === 'argos-api') return translateWithLibreTranslate(texts, target);
  if (provider === 'microsoft' || provider === 'azure') return translateWithMicrosoft(texts, target);
  if (provider === 'google' || provider === 'google-cloud') return translateWithGoogleCloud(texts, target);
  if (provider === 'google-public' || provider === 'google_free' || provider === 'google-free') {
    return translateWithGooglePublic(texts, target);
  }
  throw new Error(`Unsupported translation provider: ${provider}`);
}

function translatedValue(cache, provider, target, value) {
  const item = cache.items[cacheKey(provider, target, value)];
  return text(item?.translated);
}

function localFirstEnabled(provider, target) {
  if (!target.startsWith('en')) return false;
  if (provider === 'local-keyword' || provider === 'local') return true;
  const configured = text(process.env.PRICE_TITLE_TRANSLATION_LOCAL_FIRST);
  return !['0', 'false', 'no', 'off'].includes(configured.toLowerCase());
}

function applyLocalKeywordTranslations(candidates, result, cache, target) {
  let count = 0;
  for (const value of candidates) {
    if (result.has(value)) continue;
    const local = localKeywordTranslate(value);
    if (!local) continue;
    result.set(value, local);
    cache.items[cacheKey('local-keyword', target, value)] = {
      source: value,
      translated: local,
      provider: 'local-keyword',
      target,
      updated_at: new Date().toISOString()
    };
    count += 1;
  }
  return count;
}

async function translateTexts(values, options = {}) {
  const provider = text(options.provider || providerName());
  const target = normalizeLanguage(options.target || targetLanguage());
  const cache = readCache();
  const maxTexts = Number(process.env.PRICE_TITLE_TRANSLATION_MAX_TEXTS || 2000);
  const candidates = uniqueTexts(values)
    .filter(value => shouldTranslate(value, target))
    .slice(0, Number.isFinite(maxTexts) && maxTexts > 0 ? maxTexts : 2000);
  const result = new Map();
  let cacheHits = 0;
  let translatedCount = 0;
  let failedCount = 0;

  let missing = [];
  for (const value of candidates) {
    const cached = translatedValue(cache, provider, target, value);
    if (cached) {
      result.set(value, cached);
      cacheHits += 1;
    } else {
      missing.push(value);
    }
  }

  const providerIsLocal = provider === 'local-keyword' || provider === 'local';
  const useLocalFirst = localFirstEnabled(provider, target);
  if (useLocalFirst) {
    translatedCount += applyLocalKeywordTranslations(candidates, result, cache, target);
    missing = missing.filter(value => !result.has(value));
  }

  if (!providerIsLocal) {
    let providerBatchFailures = 0;
    const maxProviderBatchFailures = Number(process.env.PRICE_TITLE_TRANSLATION_MAX_BATCH_FAILURES || 1);
    for (const batch of chunk(missing, Number(process.env.PRICE_TITLE_TRANSLATION_BATCH_SIZE || DEFAULT_BATCH_SIZE))) {
      try {
        const translated = await translateBatch(batch, provider, target);
        batch.forEach((source, index) => {
          const value = text(translated[index]);
          if (!value) return;
          cache.items[cacheKey(provider, target, source)] = {
            source,
            translated: value,
            provider,
            target,
            updated_at: new Date().toISOString()
          };
          result.set(source, value);
          translatedCount += 1;
        });
      } catch (error) {
        providerBatchFailures += 1;
        console.warn(`[TRANSLATE] ${provider} failed for ${batch.length} titles: ${error.message}`);
        if (providerBatchFailures >= maxProviderBatchFailures) {
          console.warn(`[TRANSLATE] ${provider} disabled for this run after ${providerBatchFailures} failed batch(es); using local keyword fallback`);
          break;
        }
      }
    }
  }

  if (target.startsWith('en') && !useLocalFirst) {
    translatedCount += applyLocalKeywordTranslations(candidates, result, cache, target);
  }
  failedCount = candidates.filter(value => !result.has(value)).length;

  if (translatedCount > 0) writeCache();
  return {
    provider,
    target,
    requested: candidates.length,
    cacheHits,
    translatedCount,
    failedCount,
    map: result
  };
}

function addUnique(list, value) {
  const source = text(value);
  if (!source) return list || [];
  const out = Array.isArray(list) ? [...list] : [];
  if (!out.some(item => normalizeText(item) === normalizeText(source))) out.push(source);
  return out;
}

async function translatePriceMatchingTitles({ officialRows = [], backendRows = [] } = {}) {
  if (!translationEnabled()) {
    return {
      enabled: false,
      provider: providerName(),
      target: targetLanguage(),
      requested: 0,
      cacheHits: 0,
      translatedCount: 0,
      failedCount: 0
    };
  }

  const values = [
    ...officialRows.flatMap(row => [row.title, ...(row.altTitles || []), ...(row.translatedTitles || [])]),
    ...backendRows.flatMap(row => [row.title, row.backendTitleCn, row.backendTranslatedTitle, row.backendEnglishTitle])
  ];
  const translated = await translateTexts(values);

  for (const row of officialRows) {
    for (const value of [row.title, ...(row.altTitles || []), ...(row.translatedTitles || [])]) {
      const translatedTitle = translated.map.get(text(value));
      if (!translatedTitle) continue;
      row.altTitles = addUnique(row.altTitles, translatedTitle);
      row.translatedTitles = addUnique(row.translatedTitles, translatedTitle);
      row.machineTranslatedTitle = translatedTitle;
    }
  }

  for (const row of backendRows) {
    for (const value of [row.title, row.backendTitleCn, row.backendTranslatedTitle, row.backendEnglishTitle]) {
      const translatedTitle = translated.map.get(text(value));
      if (!translatedTitle) continue;
      row.backendMachineTranslatedTitle = translatedTitle;
      break;
    }
  }

  return {
    enabled: true,
    provider: translated.provider,
    target: translated.target,
    requested: translated.requested,
    cacheHits: translated.cacheHits,
    translatedCount: translated.translatedCount,
    failedCount: translated.failedCount
  };
}

module.exports = {
  hasCjk,
  translatePriceMatchingTitles,
  translateTexts
};
