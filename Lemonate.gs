/**
 * Returns the "Prezzo di riferimento" of a bond given its ISIN code.
 * Checks Yahoo Finance first, then Borsa Italiana. Caches results for 10 minutes.
 * If not found, returns the fallback cell/value (e.g. N2).
 * 
 * @param {string} isin The ISIN code of the bond (e.g. A2).
 * @param {number|string} fallbackValue The value or cell reference to return if price is not found (e.g. N2).
 * @return {number|string} The price as a float, or the fallback value.
 * @customfunction
 */
function LEMONATE(isin, fallbackValue) {
  if (!isin) return fallbackValue !== undefined ? fallbackValue : 100;
  
  var cleanIsin = isin.toString().trim().toUpperCase();
  var cache = CacheService.getDocumentCache();
  var cachedPrice = cache.get(cleanIsin);
  
  // Se il prezzo è già in cache (aggiornato di recente), restituiscilo subito
  if (cachedPrice !== null) {
    return parseFloat(cachedPrice);
  }
  
  // Altrimenti, esegui il recupero da Yahoo / Borsa Italiana
  var price = fetchBondPrice(cleanIsin);
  
  if (price !== null) {
    // Salva il prezzo in cache per 10 minuti (600 secondi)
    cache.put(cleanIsin, price.toString(), 600);
    return price;
  }
  
  // Se non trovato, restituisce il fallback
  return fallbackValue !== undefined ? fallbackValue : 100;
}

/**
 * Helper function to fetch the price from Yahoo Finance or Borsa Italiana.
 */
function fetchBondPrice(cleanIsin) {
  // --- ATTEMPT 1: Yahoo Finance API ---
  try {
    var searchUrl = "https://query2.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(cleanIsin);
    var options = {
      "method": "get",
      "headers": { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      "muteHttpExceptions": true
    };
    
    var searchRes = UrlFetchApp.fetch(searchUrl, options);
    var searchData = JSON.parse(searchRes.getContentText());
    
    if (searchData.quotes && searchData.quotes.length > 0) {
      var ticker = searchData.quotes[0].symbol;
      var chartUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker);
      var chartRes = UrlFetchApp.fetch(chartUrl, options);
      var chartData = JSON.parse(chartRes.getContentText());
      
      if (chartData.chart && chartData.chart.result && chartData.chart.result.length > 0) {
        var meta = chartData.chart.result[0].meta;
        var price = meta.regularMarketPrice || meta.chartPreviousClose || meta.previousClose;
        if (price !== undefined && price !== null && !isNaN(price)) {
          return parseFloat(price);
        }
      }
    }
  } catch (e) {
    // Continue to fallback
  }
  
  // --- ATTEMPT 2: Borsa Italiana (Targeting "Prezzo di riferimento") ---
  try {
    var borsaUrl = "https://www.borsaitaliana.it/borsa/obbligazioni/eurotlx/scheda/" + encodeURIComponent(cleanIsin) + "-ETLX.html?lang=it";
    var borsaOptions = {
      "method": "get",
      "headers": {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "it-IT,it;q=0.9"
      },
      "muteHttpExceptions": true,
      "followRedirects": true
    };
    
    var response = UrlFetchApp.fetch(borsaUrl, borsaOptions);
    var html = response.getContentText();
    
    if (response.getResponseCode() === 200 && html) {
      var matchRiferimento = html.match(/Prezzo\s*di\s*riferimento[\s\S]*?<span[^>]*class="t-text\s+-right"[^>]*>([\d\.,]+)<\/span>/i) ||
                             html.match(/Prezzo\s*di\s*riferimento[^<]*<[^>]*>([\d\.,]+)</i);

      if (matchRiferimento && matchRiferimento[1]) {
        var parsedRef = convertToFloat(matchRiferimento[1]);
        if (typeof parsedRef === "number") return parsedRef;
      }
      
      var tableMatches = html.match(/>\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*</g);
      if (tableMatches && tableMatches.length > 0) {
        var cleanMatch = tableMatches[0].replace(/>|<|\s/g, '');
        var parsedTable = convertToFloat(cleanMatch);
        if (typeof parsedTable === "number") return parsedTable;
      }
    }
  } catch (e) {
    // Continue
  }
  
  return null;
}

/**
 * Converts an Italian formatted number string into a standard float.
 */
function convertToFloat(str) {
  var cleanStr = str.toString().trim();
  cleanStr = cleanStr.replace(/\./g, '').replace(',', '.');
  var val = parseFloat(cleanStr);
  return isNaN(val) ? null : val;
}