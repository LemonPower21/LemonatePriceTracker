/**
 * ============================================================================
 *  LEMONATE - live price lookup by ISIN for Google Sheets
 * ============================================================================
 *
 *  Works with any instrument that has an ISIN: bonds (BTP, corporate,
 *  Eurobonds), stocks, ETFs/ETCs, funds, certificates.
 *
 *  USAGE (use ";" instead of "," if your spreadsheet locale requires it)
 *    =LEMONATE(A2)                 Price for the ISIN in A2 (returns 100 if not found)
 *    =LEMONATE(A2, N2)             Returns N2 when the price cannot be found
 *    =LEMONATE(A2, N2, "BORSA")    Force one source: "AUTO" (default), "BORSA" or "YAHOO"
 *    =LEMONATE_INFO(A2, TRUE)      Diagnostics: price, currency, source, price type,
 *                                  price date, name and status/error message
 *
 *  HELPERS (run them from the Apps Script editor, then check View > Logs)
 *    testLemonate()                Looks up a few sample ISINs and logs the outcome
 *    clearLemonateCache()          Invalidates every cached price
 *
 *  HOW IT WORKS
 *    1. The ISIN is validated (format + ISO 6166 check digit).
 *    2. Sources are tried in this order ("AUTO" mode):
 *         - ISINs starting with IT or XS (Italian instruments and Eurobonds):
 *           Borsa Italiana first, then Yahoo Finance.
 *         - Every other ISIN: Yahoo Finance first, then Borsa Italiana.
 *       Borsa Italiana pages are probed in parallel for MOT, EuroMOT, EuroTLX,
 *       ExtraMOT, stocks, ETFs and certificates. The page that works is
 *       remembered for 6 hours, so later refreshes need a single request.
 *    3. Borsa Italiana: "Prezzo di riferimento" (reference price). If the page
 *       has none, "Ultimo contratto" (last trade) and then "Prezzo ufficiale"
 *       (official price) are used. Bond prices are quoted as % of par value.
 *    4. Yahoo Finance: last market price, or the previous close if the market
 *       price is missing. Prices are in the listing currency (e.g. "GBp" = pence).
 *    5. Results are cached for 10 minutes, failures for 2 minutes.
 *
 *  NOTES
 *    - Google Sheets only re-runs a custom function when the sheet recalculates
 *      (file opened, a precedent cell changed, formula re-entered). It does not
 *      refresh on a timer.
 *    - Custom functions are limited to 30 seconds per call and UrlFetchApp has a
 *      daily quota, which is why remembering the working source matters.
 *    - Prices come from public web pages and are provided "as is".
 */

var LEMONATE_CONFIG = {
  PRICE_CACHE_SECONDS: 600,         // successful lookups
  FAILURE_CACHE_SECONDS: 120,       // failed lookups (avoids hammering the sources)
  MAPPING_CACHE_SECONDS: 21600,     // remembered source per ISIN (6 hours = CacheService maximum)
  DEFAULT_FALLBACK: 100,            // returned when no fallback argument is given
  TIME_BUDGET_MS: 22000,            // stop trying new sources after this (hard limit is 30 s)
  CACHE_VERSION_PROPERTY: 'LEMONATE_CACHE_VERSION',
  BORSA_BASE_URL: 'https://www.borsaitaliana.it',
  YAHOO_SEARCH_URL: 'https://query2.finance.yahoo.com/v1/finance/search',
  YAHOO_CHART_URL: 'https://query1.finance.yahoo.com/v8/finance/chart/',
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

/**
 * Borsa Italiana instrument pages. {ISIN} is replaced with the ISIN.
 * Group 1 (bonds) is probed first, group 2 (everything else) only if group 1 finds nothing.
 */
var LEMONATE_BORSA_PAGES = [
  { key: 'MOT_BTP',  group: 1, label: 'MOT government bonds',        path: '/borsa/obbligazioni/mot/btp/scheda/{ISIN}.html?lang=it' },
  { key: 'MOT_EUR',  group: 1, label: 'MOT bonds in EUR',            path: '/borsa/obbligazioni/mot/obbligazioni-in-euro/scheda/{ISIN}.html?lang=it' },
  { key: 'EUROMOT',  group: 1, label: 'EuroMOT Eurobonds',           path: '/borsa/obbligazioni/mot/euro-obbligazioni/scheda/{ISIN}-MOTX.html?lang=it' },
  { key: 'EUROTLX',  group: 1, label: 'EuroTLX',                     path: '/borsa/obbligazioni/eurotlx/scheda/{ISIN}-ETLX.html?lang=it' },
  { key: 'STOCK',    group: 2, label: 'Euronext Milan stocks',       path: '/borsa/azioni/scheda/{ISIN}.html?lang=it' },
  { key: 'ETF',      group: 2, label: 'ETFplus ETFs/ETCs',           path: '/borsa/etf/scheda/{ISIN}.html?lang=it' },
  { key: 'CERT',     group: 2, label: 'SeDeX certificates/warrants', path: '/borsa/cw-e-certificates/scheda/{ISIN}-SEDX.html?lang=it' },
  { key: 'EXTRAMOT', group: 2, label: 'ExtraMOT',                    path: '/borsa/obbligazioni/extramot/obbligazioni/scheda/{ISIN}-XMOT.html?lang=it' }
];

/** Price labels searched in the Borsa Italiana page text, in priority order. */
var LEMONATE_BORSA_FIELDS = [
  { name: 'Reference price', label: 'Prezzo\\s+di\\s+riferimento' },
  { name: 'Last trade',      label: 'Ultimo\\s+(?:contratto|prezzo)' },
  { name: 'Official price',  label: 'Prezzo\\s+ufficiale' }
];


/* ============================================================================
 *  PUBLIC FUNCTIONS (usable as spreadsheet formulas)
 * ============================================================================ */

/**
 * Returns the latest price of a security given its ISIN code.
 * Checks Borsa Italiana ("Prezzo di riferimento") and Yahoo Finance, caches results
 * for 10 minutes and returns the fallback value when no price can be found.
 *
 * @param {string} isin The ISIN code of the security (e.g. A2).
 * @param {number|string} fallbackValue Value or cell returned when the price is not found (e.g. N2). Defaults to 100.
 * @param {string} source Optional. "AUTO" (default), "BORSA" or "YAHOO".
 * @return {number|string} The price as a number, or the fallback value.
 * @customfunction
 */
function LEMONATE(isin, fallbackValue, source) {
  assertSingleCell_(isin, 'LEMONATE');
  var fallback = (fallbackValue !== undefined) ? fallbackValue : LEMONATE_CONFIG.DEFAULT_FALLBACK;
  if (isEmpty_(isin)) return fallback;

  var result = lookup_(isin, source);
  if (result.ok) return result.price;

  Logger.log('LEMONATE ' + result.isin + ': ' + result.message + ' -> returning the fallback value.');
  return fallback;
}

/**
 * Diagnostic version of LEMONATE: shows where a price comes from, or why none was found.
 * Columns: ISIN, Price, Currency, Source, Price type, Price date, Name, Status.
 *
 * @param {string} isin The ISIN code of the security (e.g. A2).
 * @param {boolean} includeHeader Optional. TRUE adds a header row.
 * @param {string} source Optional. "AUTO" (default), "BORSA" or "YAHOO".
 * @return {Array<Array<string|number>>} One row of details (plus a header row if requested).
 * @customfunction
 */
function LEMONATE_INFO(isin, includeHeader, source) {
  assertSingleCell_(isin, 'LEMONATE_INFO');
  var header = ['ISIN', 'Price', 'Currency', 'Source', 'Price type', 'Price date', 'Name', 'Status'];
  var row;

  if (isEmpty_(isin)) {
    row = ['', '', '', '', '', '', '', 'No ISIN provided'];
  } else {
    var r = lookup_(isin, source);
    row = [
      r.isin,
      r.ok ? r.price : '',
      r.currency || '',
      r.source || '',
      r.field || '',
      r.priceDate || '',
      r.name || '',
      r.ok ? (r.fromCache ? 'OK (cached)' : 'OK') : r.message
    ];
  }
  return includeHeader ? [header, row] : [row];
}

/**
 * Invalidates every cached price and remembered source.
 * Run it from the Apps Script editor, then force the sheet to recalculate
 * (for example by re-entering a formula or reopening the file).
 */
function clearLemonateCache() {
  var props = getProps_();
  var current = parseInt(props.getProperty(LEMONATE_CONFIG.CACHE_VERSION_PROPERTY) || '1', 10) || 1;
  props.setProperty(LEMONATE_CONFIG.CACHE_VERSION_PROPERTY, String(current + 1));
  Logger.log('LEMONATE cache cleared (cache version is now ' + (current + 1) + ').');
}

/**
 * Looks up a few sample ISINs and logs the outcome. Run it from the Apps Script editor.
 * Replace the sample list with your own ISINs to test them.
 */
function testLemonate() {
  var sample = [
    'IT0003934657',   // Italian government bond (BTP)
    'IT0005438004',   // Italian government bond (BTP)
    'XS2241390983',   // Eurobond on EuroMOT
    'IT0003128367',   // Stock (Enel)
    'US0378331005',   // Stock (Apple)
    'IE00B4L5Y983',   // ETF (iShares Core MSCI World)
    'IT000000000X'    // Invalid on purpose: shows the validation message
  ];
  for (var i = 0; i < sample.length; i++) {
    var r = lookup_(sample[i], 'AUTO');
    if (r.ok) {
      Logger.log(r.isin + ' -> ' + r.price + ' ' + (r.currency || '') + ' | ' + r.field + ' | ' + r.source +
                 (r.priceDate ? ' | ' + r.priceDate : '') + (r.fromCache ? ' | cached' : ''));
    } else {
      Logger.log(r.isin + ' -> NOT FOUND | ' + r.message);
    }
  }
}


/* ============================================================================
 *  LOOKUP ENGINE
 * ============================================================================ */

/**
 * Validates the ISIN, reads/writes the cache and runs the source chain.
 * Always returns an object: {ok, isin, price, currency, source, field, priceDate, name, message, ...}.
 */
function lookup_(rawIsin, rawSource) {
  var source = normalizeSource_(rawSource);
  var isin = normalizeIsin_(rawIsin);

  var problem = validateIsin_(isin);
  if (problem) return failure_(isin, problem);

  var cacheKey = cacheKey_('price:' + source, isin);
  var cached = cacheGet_(cacheKey);
  if (cached) {
    cached.fromCache = true;
    return cached;
  }

  var ctx = { trace: [], deadline: Date.now() + LEMONATE_CONFIG.TIME_BUDGET_MS, yahooBlocked: false };
  var result = resolve_(isin, source, ctx);
  if (!result) {
    result = failure_(isin, ctx.trace.length ? ctx.trace.join(' | ') : 'Price not found');
  }

  cachePut_(cacheKey, result, result.ok ? LEMONATE_CONFIG.PRICE_CACHE_SECONDS : LEMONATE_CONFIG.FAILURE_CACHE_SECONDS);
  return result;
}

/** Runs the source chain: remembered source first, then the full chain. */
function resolve_(isin, source, ctx) {
  var result = null;
  var mapKey = cacheKey_('map', isin);
  var mapping = cacheGet_(mapKey);

  // 1) Try the source that worked last time (one request instead of a full search).
  if (mapping && sourceAllowed_(source, mapping.src)) {
    if (mapping.src === 'BORSA') {
      result = fetchFromBorsa_(isin, ctx, mapping.key);
    } else {
      result = fetchFromYahoo_(isin, ctx, mapping.ticker);
    }
    if (!result) ctx.trace = [];   // discard notes of the quick attempt
  }

  // 2) Full chain.
  if (!result) {
    var order = sourceOrder_(isin, source);
    for (var i = 0; i < order.length; i++) {
      if (Date.now() > ctx.deadline) {
        ctx.trace.push('Time budget exceeded (custom functions are limited to 30 seconds)');
        break;
      }
      if (order[i] === 'YAHOO' && ctx.yahooBlocked) continue;
      result = (order[i] === 'BORSA') ? fetchFromBorsa_(isin, ctx, null) : fetchFromYahoo_(isin, ctx, null);
      if (result) break;
    }
  }

  if (result) {
    cachePut_(mapKey, result.mapping, LEMONATE_CONFIG.MAPPING_CACHE_SECONDS);
    delete result.mapping;
  }
  return result;
}

function sourceOrder_(isin, source) {
  if (source === 'BORSA') return ['BORSA'];
  if (source === 'YAHOO') return ['YAHOO'];
  // IT = Italian instruments, XS = Eurobonds: usually listed on Borsa Italiana.
  return /^(IT|XS)/.test(isin) ? ['BORSA', 'YAHOO'] : ['YAHOO', 'BORSA'];
}

function sourceAllowed_(source, mappedSource) {
  return source === 'AUTO' || source === mappedSource;
}


/* ============================================================================
 *  SOURCE 1: BORSA ITALIANA
 * ============================================================================ */

/**
 * Probes the Borsa Italiana instrument pages in parallel (bonds first, then the rest).
 * If onlyKey is given, only that page is requested.
 */
function fetchFromBorsa_(isin, ctx, onlyKey) {
  var groups = [[], []];
  for (var i = 0; i < LEMONATE_BORSA_PAGES.length; i++) {
    var page = LEMONATE_BORSA_PAGES[i];
    if (onlyKey && page.key !== onlyKey) continue;
    groups[onlyKey ? 0 : page.group - 1].push(page);
  }

  var unexpectedCodes = [];
  for (var g = 0; g < groups.length; g++) {
    var pages = groups[g];
    if (!pages.length) continue;
    if (Date.now() > ctx.deadline) {
      ctx.trace.push('Borsa Italiana: time budget exceeded');
      return null;
    }

    var requests = [];
    for (var p = 0; p < pages.length; p++) {
      requests.push(buildRequest_(LEMONATE_CONFIG.BORSA_BASE_URL + pages[p].path.replace('{ISIN}', isin)));
    }

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      ctx.trace.push('Borsa Italiana: network error (' + e.message + ')');
      continue;
    }

    for (var k = 0; k < responses.length; k++) {
      var code = responses[k].getResponseCode();
      if (code !== 200) {
        if (code !== 404 && unexpectedCodes.indexOf(code) === -1) unexpectedCodes.push(code);
        continue;
      }
      var parsed = parseBorsaPage_(responses[k].getContentText(), isin);
      if (parsed) {
        parsed.source = 'Borsa Italiana - ' + pages[k].label;
        parsed.mapping = { src: 'BORSA', key: pages[k].key };
        return success_(isin, parsed);
      }
    }
  }

  ctx.trace.push('Borsa Italiana: no price found for this ISIN' +
                 (unexpectedCodes.length ? ' (unexpected HTTP status ' + unexpectedCodes.join(', ') + ')' : ''));
  return null;
}

/**
 * Extracts the price from a Borsa Italiana page. Returns null unless the page belongs to
 * the requested ISIN and contains one of the known price labels followed by a number.
 */
function parseBorsaPage_(html, isin) {
  if (!html || html.indexOf(isin) === -1) return null;   // wrong page, error page or redirect
  var text = htmlToText_(html);

  var number = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:,\\d+)?)';
  for (var i = 0; i < LEMONATE_BORSA_FIELDS.length; i++) {
    var field = LEMONATE_BORSA_FIELDS[i];
    var re = new RegExp(field.label + '\\s*[:|]?\\s*(?:(?:EUR|USD|GBP|CHF|JPY)\\s*)?' + number + '(?![\\d,.\\/])', 'i');
    var m = re.exec(text);
    if (!m) continue;

    var price = parseItalianNumber_(m[1]);
    if (price === null || price <= 0) continue;

    var currencyMatch = /Valuta\s+di\s+Negoziazione\s*\/\s*Liquidazione\s+([A-Z]{3})/.exec(text);
    var dateMatch = /Data\s+di\s+riferimento\s+(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
    return {
      price: price,
      field: field.name,
      currency: currencyMatch ? currencyMatch[1] : '',
      priceDate: (dateMatch && i === 0) ? dateMatch[3] + '-' + dateMatch[2] + '-' + dateMatch[1] : ''
    };
  }
  return null;
}

/** Turns an HTML page into plain, single-spaced text (scripts, styles and tags removed). */
function htmlToText_(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/** Converts an Italian formatted number ("1.234,56" or "101,25") into a float, or null. */
function parseItalianNumber_(str) {
  var s = String(str).trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)$/.test(s)) return null;
  var value = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return isFinite(value) ? value : null;
}


/* ============================================================================
 *  SOURCE 2: YAHOO FINANCE
 * ============================================================================ */

/**
 * Resolves the ISIN to a Yahoo ticker (unless one is already known) and reads its price.
 */
function fetchFromYahoo_(isin, ctx, knownTicker) {
  var symbols = knownTicker ? [knownTicker] : yahooSearchSymbols_(isin, ctx);
  var max = Math.min(symbols.length, 3);   // never try more than 3 candidates

  for (var i = 0; i < max; i++) {
    if (ctx.yahooBlocked || Date.now() > ctx.deadline) break;
    var quote = yahooQuote_(symbols[i], ctx);
    if (quote) {
      quote.source = 'Yahoo Finance (' + symbols[i] + ')';
      quote.mapping = { src: 'YAHOO', ticker: symbols[i] };
      return success_(isin, quote);
    }
  }
  return null;
}

/** Searches Yahoo Finance by ISIN and returns the candidate ticker symbols. */
function yahooSearchSymbols_(isin, ctx) {
  var url = LEMONATE_CONFIG.YAHOO_SEARCH_URL + '?q=' + encodeURIComponent(isin) +
            '&quotesCount=6&newsCount=0&listsCount=0&enableFuzzyQuery=false';
  var res = httpGet_(url, ctx);
  if (!res) return [];
  if (res.code === 429) {
    ctx.yahooBlocked = true;
    ctx.trace.push('Yahoo Finance: rate limit reached (HTTP 429), try again in a few minutes');
    return [];
  }
  if (res.code !== 200) {
    ctx.trace.push('Yahoo Finance search: unexpected HTTP status ' + res.code);
    return [];
  }

  var data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    ctx.trace.push('Yahoo Finance search: unreadable response');
    return [];
  }

  var ignoredTypes = { INDEX: 1, CURRENCY: 1, CRYPTOCURRENCY: 1, FUTURE: 1, OPTION: 1 };
  var quotes = data.quotes || [];
  var symbols = [];
  for (var i = 0; i < quotes.length; i++) {
    var q = quotes[i];
    if (q && q.symbol && !ignoredTypes[String(q.quoteType).toUpperCase()]) symbols.push(q.symbol);
  }
  if (!symbols.length) ctx.trace.push('Yahoo Finance: no instrument found for this ISIN');
  return symbols;
}

/** Reads the latest price of one Yahoo ticker. Returns null if unavailable. */
function yahooQuote_(symbol, ctx) {
  var url = LEMONATE_CONFIG.YAHOO_CHART_URL + encodeURIComponent(symbol) + '?range=1d&interval=1d';
  var res = httpGet_(url, ctx);
  if (!res) return null;
  if (res.code === 429) {
    ctx.yahooBlocked = true;
    ctx.trace.push('Yahoo Finance: rate limit reached (HTTP 429), try again in a few minutes');
    return null;
  }
  if (res.code !== 200) {
    ctx.trace.push('Yahoo Finance ' + symbol + ': unexpected HTTP status ' + res.code);
    return null;
  }

  var data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    ctx.trace.push('Yahoo Finance ' + symbol + ': unreadable response');
    return null;
  }

  var result = data && data.chart && data.chart.result && data.chart.result[0];
  var meta = result && result.meta;
  if (!meta) {
    ctx.trace.push('Yahoo Finance ' + symbol + ': no market data');
    return null;
  }

  var candidates = [
    { key: 'regularMarketPrice', name: 'Last price' },
    { key: 'previousClose',      name: 'Previous close' },
    { key: 'chartPreviousClose', name: 'Previous close' }
  ];
  for (var i = 0; i < candidates.length; i++) {
    var v = meta[candidates[i].key];
    if (typeof v === 'number' && isFinite(v) && v > 0) {
      var isLast = candidates[i].key === 'regularMarketPrice';
      return {
        price: v,
        field: candidates[i].name,
        currency: meta.currency || '',
        name: meta.longName || meta.shortName || '',
        priceDate: (isLast && meta.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : ''
      };
    }
  }
  ctx.trace.push('Yahoo Finance ' + symbol + ': no valid price');
  return null;
}


/* ============================================================================
 *  ISIN HELPERS
 * ============================================================================ */

function normalizeIsin_(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[\s-]/g, '').toUpperCase();
}

/** Returns an error message, or '' if the ISIN is valid (format + ISO 6166 check digit). */
function validateIsin_(isin) {
  if (!isin) return 'No ISIN provided';
  if (isin.length !== 12) return 'Invalid ISIN "' + isin + '": it must be exactly 12 characters long';
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) {
    return 'Invalid ISIN "' + isin + '": expected 2 letters, 9 letters/digits and 1 check digit';
  }
  if (!isinChecksumOk_(isin)) return 'Invalid ISIN "' + isin + '": the check digit does not match (possible typo)';
  return '';
}

/** ISO 6166 check: letters become 2-digit numbers (A=10 ... Z=35), then the Luhn algorithm applies. */
function isinChecksumOk_(isin) {
  var digits = '';
  for (var i = 0; i < isin.length; i++) {
    var code = isin.charCodeAt(i);
    digits += (code >= 65 && code <= 90) ? String(code - 55) : isin.charAt(i);
  }
  var sum = 0;
  var doubleIt = false;
  for (var j = digits.length - 1; j >= 0; j--) {
    var d = parseInt(digits.charAt(j), 10);
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}


/* ============================================================================
 *  GENERAL HELPERS
 * ============================================================================ */

function isEmpty_(value) {
  return value === undefined || value === null || String(value).replace(/\s/g, '') === '';
}

function assertSingleCell_(value, functionName) {
  if (Array.isArray(value)) {
    throw new Error(functionName + ' expects a single ISIN cell, not a range. Enter the formula in one cell and fill it down.');
  }
}

function normalizeSource_(source) {
  if (source === undefined || source === null || String(source).trim() === '') return 'AUTO';
  var s = String(source).trim().toUpperCase();
  if (s === 'AUTO' || s === 'BORSA' || s === 'YAHOO') return s;
  throw new Error('Invalid source "' + source + '". Use "AUTO", "BORSA" or "YAHOO".');
}

function success_(isin, props) {
  return {
    ok: true,
    isin: isin,
    price: props.price,
    currency: props.currency || '',
    source: props.source || '',
    field: props.field || '',
    priceDate: props.priceDate || '',
    name: props.name || '',
    mapping: props.mapping,
    message: 'OK',
    retrievedAt: new Date().toISOString()
  };
}

function failure_(isin, message) {
  return { ok: false, isin: isin, message: message };
}

function buildRequest_(url) {
  return {
    url: url,
    method: 'get',
    headers: {
      'User-Agent': LEMONATE_CONFIG.USER_AGENT,
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
    },
    muteHttpExceptions: true,
    followRedirects: true
  };
}

/** Single GET request. Returns {code, body}, or null on network errors (noted in ctx.trace). */
function httpGet_(url, ctx) {
  try {
    var response = UrlFetchApp.fetch(url, buildRequest_(url));
    return { code: response.getResponseCode(), body: response.getContentText() };
  } catch (e) {
    ctx.trace.push('Network error: ' + e.message);
    return null;
  }
}


/* ============================================================================
 *  CACHE
 * ============================================================================ */

function getCache_() {
  return CacheService.getDocumentCache() || CacheService.getScriptCache();
}

function getProps_() {
  return PropertiesService.getDocumentProperties() || PropertiesService.getScriptProperties();
}

/** The cache version changes when clearLemonateCache() runs, which orphans every old entry. */
function cacheVersion_() {
  try {
    return getProps_().getProperty(LEMONATE_CONFIG.CACHE_VERSION_PROPERTY) || '1';
  } catch (e) {
    return '1';
  }
}

function cacheKey_(type, isin) {
  return 'LEMONATE:v' + cacheVersion_() + ':' + type + ':' + isin;
}

function cacheGet_(key) {
  try {
    var raw = getCache_().get(key);
    return raw === null ? null : JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function cachePut_(key, value, seconds) {
  try {
    getCache_().put(key, JSON.stringify(value), seconds);
  } catch (e) {
    // The cache is an optimisation only: ignore write errors.
  }
}
