import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());

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
    // Fallback 1: Try TradingView chart tab
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
    if (!tab) {
      // Fallback 2: Try any active http/https tab
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found. Please make sure a web page is open in TradingView or Chrome.');
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
    // Fallback 1: Try any coinglass tab
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      // Fallback 2: Try TradingView chart tab
      tab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
    }
    if (!tab) {
      // Fallback 3: Try any active http/https tab
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found. Please make sure a web page is open in TradingView or Chrome.');
    navigated = true;
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

// ─── JSON Database Persistence ──────────────────────────────
const TRADES_FILE = path.join(__dirname, 'trades.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function loadTrades() {
  if (!fs.existsSync(TRADES_FILE)) {
    fs.writeFileSync(TRADES_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const data = fs.readFileSync(TRADES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading trades file:', e);
    return [];
  }
}

function saveTrades(trades) {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (e) {
    console.error('Error saving trades file:', e);
  }
}

function loadSettings() {
  const defaultSettings = {
    capital: 1000,
    riskPercent: 1.0,
    minRR: 1.5,
    maxActive: 1,
    minDist: 0.3,
    maxDist: 8.0,
    autoTradeEnabled: true,
    telegramBotToken: '',
    telegramChatId: ''
  };
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
    return defaultSettings;
  }
  try {
    const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch (e) {
    console.error('Error reading settings file:', e);
    return defaultSettings;
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Error saving settings file:', e);
  }
}

// ─── Trade Log REST API Endpoints ────────────────────────────
app.get('/api/trades', (req, res) => {
  const trades = loadTrades();
  res.json({ success: true, data: trades });
});

app.post('/api/trades/add', (req, res) => {
  const trade = req.body;
  if (!trade || !trade.direction || !trade.entry || !trade.tp || !trade.sl || !trade.capital || !trade.riskPercent) {
    return res.status(400).json({ success: false, error: 'Incomplete trade data' });
  }

  const trades = loadTrades();
  trades.push({
    id: trade.id || 'T' + Date.now(),
    time: trade.time || new Date().toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction: trade.direction,
    entry: parseFloat(trade.entry),
    tp: parseFloat(trade.tp),
    sl: parseFloat(trade.sl),
    capital: parseFloat(trade.capital),
    riskPercent: parseFloat(trade.riskPercent),
    riskUsd: parseFloat(trade.riskUsd),
    positionSizeUsd: parseFloat(trade.positionSizeUsd),
    tpDistance: parseFloat(trade.tpDistance),
    slDistance: parseFloat(trade.slDistance),
    status: trade.status || 'ACTIVE',
    pnl: parseFloat(trade.pnl || 0),
    initialTpVolume: trade.initialTpVolume ? parseFloat(trade.initialTpVolume) : null,
    note: trade.note || ''
  });

  saveTrades(trades);
  res.json({ success: true });

  // Send Telegram Alert for new manual trade
  sendTelegramAlert(
    `🔔 <b>New Trade Logged (Manual)</b>\n` +
    `Type: <b>${trade.direction}</b>\n` +
    `Entry: <code>$${parseFloat(trade.entry).toFixed(2)}</code>\n` +
    `TP: <code>$${parseFloat(trade.tp).toFixed(2)}</code>\n` +
    `SL: <code>$${parseFloat(trade.sl).toFixed(2)}</code>\n` +
    `Size: <code>$${parseFloat(trade.positionSizeUsd).toFixed(0)}</code>\n` +
    `Note: ${trade.note || 'Manual Entry'}`
  );
});

app.post('/api/trades/cut', (req, res) => {
  const { id, closePrice } = req.body;
  if (!id || !closePrice) {
    return res.status(400).json({ success: false, error: 'Missing trade ID or close price' });
  }

  const trades = loadTrades();
  const trade = trades.find(t => t.id === id);
  if (trade && trade.status === 'ACTIVE') {
    trade.status = 'CUT_LOSS';
    const diff = trade.direction === 'LONG' ? (closePrice - trade.entry) : (trade.entry - closePrice);
    trade.pnl = parseFloat((trade.positionSizeUsd * (diff / trade.entry)).toFixed(2));
    trade.closePrice = parseFloat(closePrice);
    trade.note = trade.note ? `${trade.note} (Manual Cut)` : 'Manual Cut';
    saveTrades(trades);
    res.json({ success: true });

    // Send Telegram Alert for manual cut
    sendTelegramAlert(
      `⚠️ <b>Trade Closed (Manual Cut)</b>\n` +
      `Type: <b>${trade.direction}</b>\n` +
      `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
      `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
      `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
      `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
      `Close: <code>$${parseFloat(closePrice).toFixed(2)}</code>\n` +
      `PnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</code> (${trade.pnl >= 0 ? '+' : ''}Bs. ${(trade.pnl * 6.96).toFixed(2)})\n` +
      `Note: ${trade.note}`
    );
  }
  res.status(404).json({ success: false, error: 'Active trade not found' });
});

app.post('/api/trades/delete', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing trade ID' });
  }

  let trades = loadTrades();
  trades = trades.filter(t => t.id !== id);
  saveTrades(trades);
  res.json({ success: true });
});

app.post('/api/trades/clear', (req, res) => {
  saveTrades([]);
  res.json({ success: true });
});

// Settings REST API Endpoints
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({ success: true, data: settings });
});

app.post('/api/settings', (req, res) => {
  const newSettings = req.body;
  if (!newSettings) {
    return res.status(400).json({ success: false, error: 'Invalid settings object' });
  }

  const current = loadSettings();
  const parseNum = (val, fallback) => {
    if (val === undefined || val === null || val === '') return fallback;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? fallback : parsed;
  };
  const parseIntNum = (val, fallback) => {
    if (val === undefined || val === null || val === '') return fallback;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? fallback : parsed;
  };

  const updated = {
    capital: parseNum(newSettings.capital, current.capital),
    riskPercent: parseNum(newSettings.riskPercent, current.riskPercent),
    minRR: parseNum(newSettings.minRR, current.minRR),
    maxActive: parseIntNum(newSettings.maxActive, current.maxActive),
    minDist: parseNum(newSettings.minDist, current.minDist),
    maxDist: parseNum(newSettings.maxDist, current.maxDist),
    autoTradeEnabled: newSettings.autoTradeEnabled !== undefined ? !!newSettings.autoTradeEnabled : current.autoTradeEnabled,
    telegramBotToken: newSettings.telegramBotToken !== undefined ? String(newSettings.telegramBotToken).trim() : current.telegramBotToken,
    telegramChatId: newSettings.telegramChatId !== undefined ? String(newSettings.telegramChatId).trim() : current.telegramChatId
  };

  saveSettings(updated);
  res.json({ success: true, data: updated });
});

// Telegram Notification Helper
async function sendTelegramAlert(message) {
  const settings = loadSettings();
  const token = settings.telegramBotToken;
  const chatId = settings.telegramChatId;

  if (!token || !chatId) {
    console.log('[Telegram Alert] Token or Chat ID not configured, skipping alert.');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const resObj = await response.json();
    if (!resObj.ok) {
      console.error('[Telegram Alert] Error sending alert:', resObj.description);
    } else {
      console.log('[Telegram Alert] Alert sent successfully.');
    }
  } catch (error) {
    console.error('[Telegram Alert] Failed to send telegram notification:', error.message);
  }
}

// Telegram Test Send Endpoint
app.post('/api/telegram/test', async (req, res) => {
  const { token, chatId } = req.body;
  if (!token || !chatId) {
    return res.status(400).json({ success: false, error: 'Missing token or chat ID' });
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🔔 <b>JDA Trade Monitor</b>\nTelegram Notification Test: Successful! Connections verified.',
        parse_mode: 'HTML'
      })
    });
    const resObj = await response.json();
    if (resObj.ok) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: resObj.description });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Server-Side Bot Logic ──────────────────────────────────
function evaluateActiveTradesBackend(heatmapData) {
  const cs = heatmapData.series.find(s => s.type === 'candlestick');
  if (!cs || !cs.data || cs.data.length === 0) return;

  const lastCandle = cs.data[cs.data.length - 1];
  const lastClose = parseFloat(lastCandle[1]);
  const lastLow = parseFloat(lastCandle[2]);
  const lastHigh = parseFloat(lastCandle[3]);

  if (isNaN(lastClose) || isNaN(lastLow) || isNaN(lastHigh)) return;

  const trades = loadTrades();
  let updated = false;

  trades.forEach(trade => {
    if (trade.status !== 'ACTIVE') return;

    if (trade.direction === 'LONG') {
      // 1. Check Stop Loss Hit
      if (lastLow <= trade.sl) {
        trade.status = 'HIT_SL';
        trade.pnl = -trade.riskUsd;
        trade.closePrice = trade.sl;
        trade.note = `Wick Hit SL ($${lastLow.toFixed(2)})`;
        updated = true;
        sendTelegramAlert(
          `🚨 <b>Trade Closed (Hit SL)</b>\n` +
          `Type: <b>LONG</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `SL Hit: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `PnL: <code>-$${trade.riskUsd.toFixed(2)}</code> (-Bs. ${(trade.riskUsd * 6.96).toFixed(2)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
      // 2. Check Take Profit Hit
      if (lastHigh >= trade.tp) {
        trade.status = 'HIT_TP';
        const profit = trade.positionSizeUsd * (trade.tpDistance / 100);
        trade.pnl = profit;
        trade.closePrice = trade.tp;
        trade.note = `Wick Hit TP ($${lastHigh.toFixed(2)})`;
        updated = true;
        sendTelegramAlert(
          `🎉 <b>Trade Closed (Hit TP)</b>\n` +
          `Type: <b>LONG</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `TP Hit: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `PnL: <code>+$${profit.toFixed(2)}</code> (+Bs. ${(profit * 6.96).toFixed(2)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
    } else { // SHORT
      // 1. Check Stop Loss Hit
      if (lastHigh >= trade.sl) {
        trade.status = 'HIT_SL';
        trade.pnl = -trade.riskUsd;
        trade.closePrice = trade.sl;
        trade.note = `Wick Hit SL ($${lastHigh.toFixed(2)})`;
        updated = true;
        sendTelegramAlert(
          `🚨 <b>Trade Closed (Hit SL)</b>\n` +
          `Type: <b>SHORT</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `SL Hit: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `PnL: <code>-$${trade.riskUsd.toFixed(2)}</code> (-Bs. ${(trade.riskUsd * 6.96).toFixed(2)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
      // 2. Check Take Profit Hit
      if (lastLow <= trade.tp) {
        trade.status = 'HIT_TP';
        const profit = trade.positionSizeUsd * (trade.tpDistance / 100);
        trade.pnl = profit;
        trade.closePrice = trade.tp;
        trade.note = `Wick Hit TP ($${lastLow.toFixed(2)})`;
        updated = true;
        sendTelegramAlert(
          `🎉 <b>Trade Closed (Hit TP)</b>\n` +
          `Type: <b>SHORT</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `TP Hit: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `PnL: <code>+$${profit.toFixed(2)}</code> (+Bs. ${(profit * 6.96).toFixed(2)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
    }

    // 3. Check Pool Shrinkage
    const yAxisData = heatmapData.yAxis || [];
    let closestYIdx = -1, minDiff = Infinity;
    yAxisData.forEach((priceStr, idx) => {
      const diff = Math.abs(parseFloat(priceStr) - trade.tp);
      if (diff < minDiff) { minDiff = diff; closestYIdx = idx; }
    });

    let currentTpVolume = 0;
    const hs = heatmapData.series.find(s => s.type === 'heatmap');
    if (hs && hs.data && closestYIdx !== -1) {
      hs.data.forEach(item => {
        const v = Array.isArray(item) ? item : (item.value || []);
        if (parseInt(v[1], 10) === closestYIdx) currentTpVolume += parseFloat(v[2] || 0);
      });
    }

    if (trade.initialTpVolume && currentTpVolume < trade.initialTpVolume * 0.5) {
      trade.status = 'CUT_LOSS';
      const diff = trade.direction === 'LONG' ? (lastClose - trade.entry) : (trade.entry - lastClose);
      const profit = trade.positionSizeUsd * (diff / trade.entry);
      trade.pnl = profit;
      trade.closePrice = lastClose;
      trade.note = 'Auto (Pool -50%)';
      updated = true;
      sendTelegramAlert(
        `⚠️ <b>Trade Closed (Auto-Cut: Pool -50%)</b>\n` +
        `Type: <b>${trade.direction}</b>\n` +
        `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
        `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
        `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
        `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
        `Close: <code>$${lastClose.toFixed(2)}</code>\n` +
        `PnL: <code>${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}</code> (${profit >= 0 ? '+' : ''}Bs. ${(profit * 6.96).toFixed(2)})\n` +
        `Note: ${trade.note}`
      );
      return;
    }

    // 4. Update current floating PnL
    const diff = trade.direction === 'LONG' ? (lastClose - trade.entry) : (trade.entry - lastClose);
    const floatingPnl = parseFloat((trade.positionSizeUsd * (diff / trade.entry)).toFixed(2));
    if (trade.pnl !== floatingPnl) {
      trade.pnl = floatingPnl;
      updated = true;
    }
  });

  if (updated) {
    saveTrades(trades);
  }
}

function autoTradeStrategyBackend(heatmapData) {
  const settings = loadSettings();
  if (!settings.autoTradeEnabled) return;

  const cs = heatmapData.series.find(s => s.type === 'candlestick');
  if (!cs || !cs.data || cs.data.length === 0) return;
  const lastCandle = cs.data[cs.data.length - 1];
  const currentPrice = parseFloat(lastCandle[1]);
  if (isNaN(currentPrice)) return;

  const trades = loadTrades();
  const activeTrades = trades.filter(t => t.status === 'ACTIVE');
  if (activeTrades.length >= settings.maxActive) return;

  const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');
  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) return;

  const yAxisData = heatmapData.yAxis || [];
  const volumeByY = {};
  heatmapSeries.data.forEach(item => {
    const v = Array.isArray(item) ? item : (item.value || []);
    const yIdx = parseInt(v[1], 10);
    const val = parseFloat(v[2] || 0);
    if (!isNaN(yIdx)) {
      volumeByY[yIdx] = (volumeByY[yIdx] || 0) + val;
    }
  });

  const candidates = [];
  yAxisData.forEach((priceStr, idx) => {
    const p = parseFloat(priceStr);
    if (isNaN(p) || p === currentPrice) return;

    const diffPercent = Math.abs(((p - currentPrice) / currentPrice) * 100);
    if (diffPercent < settings.minDist || diffPercent > settings.maxDist) return;

    // Check if swept by recent visible wicks
    let swept = false;
    cs.data.forEach(c => {
      const lo = parseFloat(c[2]), hi = parseFloat(c[3]);
      if (p >= lo && p <= hi) swept = true;
    });
    if (swept) return;

    // Check if matches any existing trade TP
    const isTargeted = trades.some(t => Math.abs(t.tp - p) / p < 0.0025);
    if (isTargeted) return;

    const volume = volumeByY[idx] || 0;
    if (volume <= 0) return;

    const score = volume / diffPercent;
    candidates.push({
      price: p,
      yIdx: idx,
      distance: diffPercent,
      leverage: volume,
      score: score
    });
  });

  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  const direction = best.price > currentPrice ? 'LONG' : 'SHORT';
  const entry = currentPrice;
  const tp = best.price;

  const tpDistance = best.distance;
  const slDistance = tpDistance / settings.minRR;
  const sl = direction === 'LONG' ? (entry * (1 - slDistance / 100)) : (entry * (1 + slDistance / 100));

  // Cooldown check (last 30 minutes in same direction with similar TP)
  const isCooldown = trades.some(t => {
    if (t.direction !== direction) return false;
    const timeDiffMs = Date.now() - new Date(t.time).getTime();
    if (isNaN(timeDiffMs) || timeDiffMs > 1800000) return false;
    const tpDiff = Math.abs(t.tp - tp) / tp;
    return tpDiff < 0.0025;
  });
  if (isCooldown) return;

  const riskUsd = settings.capital * (settings.riskPercent / 100);
  const positionSizeUsd = riskUsd / (slDistance / 100);

  let initialTpVolume = null;
  if (volumeByY[best.yIdx] > 0) initialTpVolume = volumeByY[best.yIdx];

  const rr = (tpDistance / slDistance).toFixed(1);
  const newTrade = {
    id: 'T' + Date.now(),
    time: new Date().toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction,
    entry: parseFloat(entry.toFixed(2)),
    tp: parseFloat(tp.toFixed(2)),
    sl: parseFloat(sl.toFixed(2)),
    capital: settings.capital,
    riskPercent: settings.riskPercent,
    riskUsd,
    positionSizeUsd,
    tpDistance,
    slDistance,
    status: 'ACTIVE',
    pnl: 0,
    initialTpVolume,
    note: `Bot (Pool $${best.leverage.toFixed(0)})`
  };

  trades.push(newTrade);
  saveTrades(trades);
  console.log(`[Backend Bot] Executed ${direction} Entry:${entry.toFixed(2)} TP:${tp.toFixed(2)} SL:${sl.toFixed(2)}`);

  // Send Telegram Alert for bot trade
  sendTelegramAlert(
    `🔔 <b>New Trade Executed (Bot)</b>\n` +
    `Type: <b>${direction}</b>\n` +
    `Entry: <code>$${entry.toFixed(2)}</code>\n` +
    `TP: <code>$${tp.toFixed(2)}</code> (Risk R: 1:${rr})\n` +
    `SL: <code>$${sl.toFixed(2)}</code>\n` +
    `Size: <code>$${positionSizeUsd.toFixed(0)}</code> (Risk: $${riskUsd.toFixed(2)})\n` +
    `Note: ${newTrade.note}`
  );
}

// ─── Background 24/7 Bot Loop Worker ────────────────────────
async function runBotCycle() {
  if (isFetchingHeatmap) {
    console.log('[Background Bot] Scrape already in progress, skipping background cycle.');
    return;
  }

  isFetchingHeatmap = true;
  try {
    console.log('[Background Bot] Running scheduled scraper and trade evaluation cycle...');
    const result = await scrapeHeatMap(true); // force refresh to get latest data from CoinGlass!
    heatmapDataCache = result;
    lastHeatmapFetchTime = Date.now();

    // Run evaluations and strategy
    evaluateActiveTradesBackend(result.data);
    autoTradeStrategyBackend(result.data);

    console.log('[Background Bot] Cycle completed successfully.');
  } catch (error) {
    console.error('[Background Bot] Cycle error:', error.message);
  } finally {
    isFetchingHeatmap = false;
  }
}

async function startBackgroundBot() {
  console.log('Background bot cycle scheduler started. Running every 3 minutes.');
  
  // Run once immediately on startup
  setTimeout(async () => {
    await runBotCycle();
  }, 5000); // 5 seconds grace period after boot

  setInterval(async () => {
    await runBotCycle();
  }, 180000); // 3 minutes
}

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`JDA Trade Monitor Dashboard listening at http://localhost:${PORT}`);
  console.log(`Make sure TradingView is running with remote debugging`);
  console.log(`on port 9222 before triggering a refresh.`);
  console.log(`==================================================`);

  // Start background bot 24/7 worker
  startBackgroundBot().catch(e => console.error('Failed to start background bot:', e));
});
