import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Serve static frontend files with cache-control headers to prevent caching issues
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache for ETF data
let etfDataCache = null;
let lastFetchTime = null;
let isFetching = false;

// Helper to parse values with suffixes like K, M, B
const parseV = v => {
  if (!v || v === '0' || v === '-' || v === '' || v === '--') return 0;
  // Remove commas, spaces, plus signs
  v = v.replace(/,/g, '').replace(/\+/g, '').trim();
  const m = v.match(/^([+-]?[\d.]+)([KMB])?$/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') return num * 1000;
  if (suffix === 'M') return num * 1000000;
  if (suffix === 'B') return num * 1000000000;
  return num;
};

// CDP CoinGlass scraper
async function scrapeCoinGlass(path, forceRefresh = false) {
  // 1. Find the TradingView or CoinGlass tab
  const tabsResponse = await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(5000) });
  const tabs = await tabsResponse.json();
  let tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com' + path));
  let navigated = false;

  if (!tab) {
    // Fallback: use TradingView chart tab, navigate temporarily
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
    if (!tab) throw new Error('No suitable tab found. Is TradingView open with a chart?');
    navigated = true;
  }
  const savedUrl = navigated ? tab.url : null;

  // 2. Open WebSocket to target tab
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let _mid = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = _mid++;
    ws.send(JSON.stringify({ id, method, params }));
    const t = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 40000);
    
    const handler = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === id) {
        clearTimeout(t);
        ws.off('message', handler);
        if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.on('message', handler);
  });

  try {
    await cdp('Page.enable');

    // Try immediate scrape from already loaded tab (only if NOT forcing a refresh)
    if (!navigated && !forceRefresh) {
      console.log('Checking if existing tab already has decrypted CoinGlass tables...');
      const immediateResult = await cdp('Runtime.evaluate', {
        expression: `
          (() => {
            var tables = document.querySelectorAll('table');
            for (var i = 0; i < tables.length; i++) {
              var ths = Array.from(tables[i].querySelectorAll('th')).map(function(t){ return t.innerText.trim(); });
              if (ths.includes('IBIT') && ths.includes('GBTC') && ths.includes('Total')) {
                var sibling = tables[i].parentElement && tables[i].parentElement.nextElementSibling;
                var sibTable = sibling && sibling.querySelector('table');
                if (sibTable) {
                  var rows = Array.from(sibTable.querySelectorAll('tr'))
                    .map(function(tr){ 
                      return Array.from(tr.querySelectorAll('td')).map(function(td){ 
                        return td.innerText.trim().replace(/\\s+/g,' '); 
                      }); 
                    })
                    .filter(function(r){ return r[0] && r[0].length > 0; });
                  if (rows.length > 0) { 
                    var cards = document.querySelectorAll('.MuiCard-root');
                    var kpis = {};
                    for (var j = 0; j < cards.length; j++) {
                      var text = cards[j].innerText.trim();
                      var parts = text.split('\\n');
                      if (parts[0] === 'Total Net Inflow') {
                        kpis.totalNetInflow = { usd: parts[1], btc: parts[2], time: parts[3] };
                      } else if (parts[0] === 'Daily Total Net Inflow') {
                        kpis.dailyTotalNetInflow = { usd: parts[1], btc: parts[2], time: parts[3] };
                      } else if (parts[0] === 'Daily Trading Volume') {
                        kpis.dailyTradingVolume = { usd: parts[1], time: parts[2] };
                      } else if (parts[0] === 'Total Net Assets') {
                        kpis.totalNetAssets = { usd: parts[1], time: parts[2] };
                      }
                    }
                    return JSON.stringify({ hdrs: ths, rows: rows.slice(0, 30), kpis: kpis }); 
                  }
                }
              }
            }
            return null;
          })()
        `,
        returnByValue: true
      });

      const immediateRaw = immediateResult?.result?.value;
      if (immediateRaw) {
        const parsed = JSON.parse(immediateRaw);
        console.log('Instant scrape succeeded! Rows:', parsed.rows.length);
        const formatted = parsed.rows.map(r => {
          const obj = { date: r[0] };
          parsed.hdrs.forEach((h, idx) => {
            if (idx > 0) {
              obj[h] = parseV(r[idx]);
            }
          });
          return obj;
        });

        return {
          hdrs: parsed.hdrs,
          rows: parsed.rows,
          formatted,
          kpis: parsed.kpis,
          timestamp: new Date().toISOString()
        };
      }
      console.log('Decrypted table not found on tab, doing standard reload scrape...');
    }

    if (navigated) {
      console.log(`Navigating tab to https://www.coinglass.com${path}...`);
      await cdp('Page.navigate', { url: 'https://www.coinglass.com' + path });
    } else {
      console.log('Reloading existing CoinGlass tab...');
      await cdp('Page.reload', {});
    }

    // 3. Poll DOM until data appears (decrypted async, requires 5-30s)
    console.log('Polling DOM for decrypted CoinGlass tables...');
    const result = await cdp('Runtime.evaluate', {
      expression: `
        new Promise(function(resolve) {
          var start = Date.now();
          function check() {
            var tables = document.querySelectorAll('table');
            for (var i = 0; i < tables.length; i++) {
              var ths = Array.from(tables[i].querySelectorAll('th')).map(function(t){ return t.innerText.trim(); });
              // Check if table contains IBIT, GBTC, and Total
              if (ths.includes('IBIT') && ths.includes('GBTC') && ths.includes('Total')) {
                var sibling = tables[i].parentElement && tables[i].parentElement.nextElementSibling;
                var sibTable = sibling && sibling.querySelector('table');
                if (sibTable) {
                  var rows = Array.from(sibTable.querySelectorAll('tr'))
                    .map(function(tr){ 
                      return Array.from(tr.querySelectorAll('td')).map(function(td){ 
                        return td.innerText.trim().replace(/\\s+/g,' '); 
                      }); 
                    })
                    .filter(function(r){ return r[0] && r[0].length > 0; });
                  if (rows.length > 0) { 
                    var cards = document.querySelectorAll('.MuiCard-root');
                    var kpis = {};
                    for (var j = 0; j < cards.length; j++) {
                      var text = cards[j].innerText.trim();
                      var parts = text.split('\\n');
                      if (parts[0] === 'Total Net Inflow') {
                        kpis.totalNetInflow = { usd: parts[1], btc: parts[2], time: parts[3] };
                      } else if (parts[0] === 'Daily Total Net Inflow') {
                        kpis.dailyTotalNetInflow = { usd: parts[1], btc: parts[2], time: parts[3] };
                      } else if (parts[0] === 'Daily Trading Volume') {
                        kpis.dailyTradingVolume = { usd: parts[1], time: parts[2] };
                      } else if (parts[0] === 'Total Net Assets') {
                        kpis.totalNetAssets = { usd: parts[1], time: parts[2] };
                      }
                    }
                    resolve(JSON.stringify({ hdrs: ths, rows: rows.slice(0, 30), kpis: kpis })); 
                    return; 
                  }
                }
              }
            }
            if (Date.now() - start < 45000) { 
              setTimeout(check, 2000); 
            } else { 
              resolve(JSON.stringify({ error: 'timeout waiting for decryption' })); 
            }
          }
          setTimeout(check, 6000); // initial wait for JS loading
        })
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const raw = result?.result?.value;
    if (!raw) throw new Error('Evaluation returned empty result.');
    
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error('Scrape failed: ' + parsed.error);

    const { hdrs, rows } = parsed;
    console.log('Successfully scraped data. Row count:', rows.length);

    // Format rows to objects
    const formatted = rows.map(r => {
      const obj = { date: r[0] };
      hdrs.forEach((h, idx) => {
        if (idx > 0) {
          obj[h] = parseV(r[idx]);
        }
      });
      return obj;
    });

    return {
      hdrs,
      rows,
      formatted,
      kpis: parsed.kpis,
      timestamp: new Date().toISOString()
    };

  } finally {
    if (navigated && savedUrl) {
      console.log(`Navigating back to saved URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('Failed to navigate back:', e));
    }
    ws.close();
  }
}

// Heatmap cache variables
let heatmapDataCache = null;
let lastHeatmapFetchTime = null;
let isFetchingHeatmap = false;

// Dedicated Liquidation Heatmap Scraper using React Fiber ECharts extraction
async function scrapeHeatMap(forceRefresh = false) {
  let tabs = null;
  let retries = 3;

  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch TradingView/Chrome tab list from port 9222. Is the browser debug port responsive?');
      console.log(`[DevTools Retry] Port 9222 unresponsive. Retrying list fetch in 2s... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/pro/futures/LiquidationHeatMap') || t.url?.includes('error-view')));
  let navigated = false;

  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
      if (!tab) throw new Error('No suitable tab found. Is TradingView open with a chart?');
      navigated = true;
    } else {
      navigated = true;
    }
  }
  const savedUrl = navigated ? tab.url : null;

  let ws = null;
  retries = 3;
  while (retries > 0) {
    try {
      ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        const connTimeout = setTimeout(() => rej(new Error('WebSocket connection timeout')), 4000);
        ws.on('open', () => { clearTimeout(connTimeout); res(); });
        ws.on('error', (err) => { clearTimeout(connTimeout); rej(err); });
      });
      break;
    } catch (e) {
      retries--;
      if (ws) {
        try { ws.close(); } catch (err) {}
        ws = null;
      }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket after 3 retries: ${e.message}`);
      console.log(`[DevTools Retry] WebSocket connection failed. Retrying in 2s... (${retries} retries left). Error: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  let _mid = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = _mid++;
    ws.send(JSON.stringify({ id, method, params }));
    const t = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 40000);
    const handler = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === id) {
        clearTimeout(t);
        ws.off('message', handler);
        if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.on('message', handler);
  });

  try {
    await cdp('Page.enable');

    const fiberExpression = `
      (() => {
        try {
          const el = document.querySelector('.echarts-for-react');
          if (!el) return null;
          
          const keys = Object.keys(el);
          const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
          if (!fiberKey) return null;
          
          let fiber = el[fiberKey];
          let option = null;
          while (fiber) {
            if (fiber.memoizedProps && fiber.memoizedProps.option) {
              option = fiber.memoizedProps.option;
              break;
            }
            fiber = fiber.return;
          }
          
          if (!option) return null;
          
          return JSON.stringify({
            xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null,
            yAxis: option.yAxis ? (Array.isArray(option.yAxis) ? option.yAxis[0].data : option.yAxis.data) : null,
            series: option.series ? option.series.map(s => ({
              name: s.name,
              type: s.type,
              data: s.data
            })) : null,
            visualMap: option.visualMap ? { min: option.visualMap.min, max: option.visualMap.max } : null
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    if (!navigated && !forceRefresh) {
      console.log('Attempting instant heatmap scrape...');
      const immediateResult = await cdp('Runtime.evaluate', {
        expression: fiberExpression,
        returnByValue: true
      });
      const immediateVal = immediateResult?.result?.value;
      if (immediateVal) {
        const parsed = JSON.parse(immediateVal);
        if (!parsed.error && parsed.series && parsed.series.length > 0) {
          console.log('Instant heatmap scrape succeeded!');
          return {
            data: parsed,
            timestamp: new Date().toISOString()
          };
        }
      }
    }

    if (navigated) {
      console.log('Navigating to LiquidationHeatMap...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap' });
    } else {
      console.log('Reloading LiquidationHeatMap page...');
      await cdp('Page.reload', {});
    }

    console.log('Polling for heatmap canvas container rendering...');
    const result = await cdp('Runtime.evaluate', {
      expression: `
        new Promise(function(resolve) {
          var start = Date.now();
          function check() {
            var el = document.querySelector('.echarts-for-react');
            if (el) {
              var keys = Object.keys(el);
              var fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
              if (fiberKey) {
                var fiber = el[fiberKey];
                var option = null;
                while (fiber) {
                  if (fiber.memoizedProps && fiber.memoizedProps.option) {
                    option = fiber.memoizedProps.option;
                    break;
                  }
                  fiber = fiber.return;
                }
                if (option && option.series && option.series.length > 0) {
                  resolve(JSON.stringify({
                    xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null,
                    yAxis: option.yAxis ? (Array.isArray(option.yAxis) ? option.yAxis[0].data : option.yAxis.data) : null,
                    series: option.series.map(s => ({
                      name: s.name,
                      type: s.type,
                      data: s.data
                    })),
                    visualMap: option.visualMap ? { min: option.visualMap.min, max: option.visualMap.max } : null
                  }));
                  return;
                }
              }
            }
            if (Date.now() - start < 45000) {
              setTimeout(check, 2000);
            } else {
              resolve(JSON.stringify({ error: 'timeout waiting for chart render' }));
            }
          }
          setTimeout(check, 4000);
        })
      `,
      awaitPromise: true,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('Failed to evaluate heatmap data from DOM');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('Scrape failed: ' + parsed.error);

    return {
      data: parsed,
      timestamp: new Date().toISOString()
    };

  } finally {
    if (navigated && savedUrl) {
      console.log(`Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('Failed to navigate back:', e));
    }
    ws.close();
  }
}

// REST API for fetching HeatMap data (with cache)
app.get('/api/heatmap-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (heatmapDataCache && !forceRefresh && lastHeatmapFetchTime && (Date.now() - lastHeatmapFetchTime < 180000)) {
    return res.json({ success: true, source: 'cache', data: heatmapDataCache });
  }

  if (isFetchingHeatmap) {
    return res.status(409).json({ success: false, error: 'A heatmap scrape is already in progress, please wait.' });
  }

  isFetchingHeatmap = true;
  try {
    console.log('Starting CoinGlass Heatmap scrape...');
    const result = await scrapeHeatMap(forceRefresh);
    heatmapDataCache = result;
    lastHeatmapFetchTime = Date.now();
    res.json({ success: true, source: 'live', data: result });
  } catch (error) {
    console.error('Heatmap scrape error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    isFetchingHeatmap = false;
  }
});

// REST API for fetching ETF data (with cache)
app.get('/api/etf-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  let btcPrice = 65000; // default fallback
  try {
    const tickerResp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const tickerData = await tickerResp.json();
    btcPrice = parseFloat(tickerData.price) || 65000;
  } catch (e) {
    console.error('Failed to fetch BTC price from Binance, using default fallback:', e.message);
  }

  // Return cached data if available and fresh (less than 1 hour old)
  if (etfDataCache && !forceRefresh && lastFetchTime && (Date.now() - lastFetchTime < 3600000)) {
    return res.json({ success: true, source: 'cache', data: etfDataCache, btcPrice });
  }

  if (isFetching) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isFetching = true;
  try {
    console.log('Starting CoinGlass scrape...');
    const result = await scrapeCoinGlass('/etf/bitcoin', forceRefresh);
    etfDataCache = result;
    lastFetchTime = Date.now();
    res.json({ success: true, source: 'live', data: result, btcPrice });
  } catch (error) {
    console.error('Scrape error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    isFetching = false;
  }
});



app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`WattVision Dashboard listening at http://localhost:${PORT}`);
  console.log(`Make sure TradingView is running with remote debugging`);
  console.log(`on port 9222 before triggering a refresh.`);
  console.log(`==================================================`);
});
