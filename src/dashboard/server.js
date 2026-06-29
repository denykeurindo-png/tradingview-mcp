import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Binance Endpoint Fallback Helper ─────────────────────────────────────────
const BINANCE_SPOT_BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api-gcp.binance.com'
];

const BINANCE_FUTURES_BASES = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
  'https://fapi-gcp.binance.com'
];

async function fetchBinance(url, options = {}) {
  if (typeof url === 'string' && url.includes('binance.com')) {
    const isFutures = url.includes('fapi.binance.com');
    const bases = isFutures ? BINANCE_FUTURES_BASES : BINANCE_SPOT_BASES;
    const urlObj = new URL(url);
    const pathAndQuery = urlObj.pathname + urlObj.search;
    
    let lastError = null;
    for (const base of bases) {
      try {
        const targetUrl = `${base}${pathAndQuery}`;
        let timeoutId;
        const fetchOpts = { ...options };
        
        if (!fetchOpts.signal) {
          const controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), 4000);
          fetchOpts.signal = controller.signal;
        }
        
        const res = await globalThis.fetch(targetUrl, fetchOpts);
        if (timeoutId) clearTimeout(timeoutId);
        
        if (res.ok && res.status === 200) {
          return res;
        }
        throw new Error(`HTTP status ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`All Binance base endpoints failed for URL: ${url}`);
  }
  return globalThis.fetch(url, options);
}

// ─── Live WebSocket Stream for Whale Trades & Liquidations ──────────────────
let recentWhaleTrades = [];
let totalWsMessagesReceived = 0;
let wsConnected = false;
let liquidations = [];

function addLiquidation(event) {
  liquidations.push(event);
  // Keep only the last 15 minutes of liquidations to save memory
  const cutoff = Date.now() - 15 * 60 * 1000;
  liquidations = liquidations.filter(liq => liq.timestamp >= cutoff);
}

function getRecentLiquidationsUsd(side, windowMinutes = 5) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  let totalUsd = 0;
  for (let i = liquidations.length - 1; i >= 0; i--) {
    const liq = liquidations[i];
    if (liq.timestamp < cutoff) break;
    if (liq.side === side) {
      totalUsd += liq.usd;
    }
  }
  return totalUsd;
}

function startWhaleWebSocket() {
  const wsUrl = 'wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@forceOrder';
  console.log(`[Binance WS] Connecting to ${wsUrl}...`);
  
  let ws = new WebSocket(wsUrl);
  let pingInterval;
  
  ws.on('open', () => {
    console.log('[Binance WS] Connected successfully.');
    wsConnected = true;
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 180000);
  });
  
  ws.on('message', (rawData) => {
    totalWsMessagesReceived++;
    try {
      const parsed = JSON.parse(rawData);
      const stream = parsed.stream;
      const t = parsed.data || parsed;
      
      if (stream === 'btcusdt@aggTrade') {
        const price = parseFloat(t.p);
        const qty = parseFloat(t.q);
        const tradeUsd = price * qty;
        
        if (tradeUsd >= 500000) {
          recentWhaleTrades.push({
            time: parseInt(t.T, 10) || Date.now(),
            usd: tradeUsd,
            isBuyerMaker: t.m
          });
          
          // Keep memory footprint small, prune instantly
          const cutoff = Date.now() - 15 * 60 * 1000;
          recentWhaleTrades = recentWhaleTrades.filter(trade => trade.time >= cutoff);
        }
      } else if (stream === 'btcusdt@forceOrder') {
        const order = t.o;
        if (order) {
          const price = parseFloat(order.p || 0);
          const qty = parseFloat(order.q || 0);
          const side = order.S; // BUY=short liq, SELL=long liq
          const usd = price * qty;
          addLiquidation({ timestamp: Date.now(), price, qty, usd, side });
          if (usd >= 100000) {
            console.log(`[Binance WS] ⚡ LIQUIDATION: ${side} $${(usd / 1e3).toFixed(1)}k at $${price.toFixed(2)}`);
          }
        }
      }
    } catch (e) {
      console.error('[Binance WS] Message parse error:', e.message);
    }
  });
  
  ws.on('error', (err) => {
    console.error('[Binance WS] Error:', err.message);
  });
  
  ws.on('close', (code, reason) => {
    console.log(`[Binance WS] Connection closed (code: ${code}). Reconnecting in 5 seconds...`);
    wsConnected = false;
    clearInterval(pingInterval);
    setTimeout(startWhaleWebSocket, 5000);
  });
}

startWhaleWebSocket();

const app = express();
const PORT = process.env.PORT || 4000;

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ limit: '150mb', extended: true }));

// ─── Session-based Authentication ────────────────────────────────────────────
const sessions = new Map(); // token → { username, expires }
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  return Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

function validateSession(req) {
  const cookies = parseCookies(req);
  const token = cookies['jda_session'];
  if (!token) return false;
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function checkCredentials(username, password) {
  const settings = loadSettings();
  const allowedUser = settings.authUsername || 'admin';
  const allowedPass = settings.authPassword || 'admin123';
  return username === allowedUser && password === allowedPass;
}

// Login endpoint (public — no auth required)
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || !checkCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_DURATION });
  res.cookie('jda_session', token, {
    httpOnly: true,
    maxAge: SESSION_DURATION,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ ok: true });
});

// Logout endpoint
app.get('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['jda_session'];
  if (token) sessions.delete(token);
  res.clearCookie('jda_session', { path: '/' });
  res.redirect('/login');
});

// Auth middleware — sessions for browser, Basic Auth for API/backward compat
const basicAuth = (req, res, next) => {
  const PUBLIC_PATHS = ['/login', '/auth/login', '/auth/logout', '/api/tradingview/webhook', '/api/jda-trades/webhook', '/api/heatmap-data/update'];
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '?'))) {
    return next();
  }

  // 1. Check session cookie
  if (validateSession(req)) return next();

  // 2. Fall back to Basic Auth header (for API clients / curl)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const [user, pass] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
      if (checkCredentials(user, pass)) return next();
    } catch (e) {
      console.error('[Auth Error]', e.message);
    }
  }

  // 3. Browser → redirect to login page
  const accepts = req.headers.accept || '';
  if (accepts.includes('text/html')) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }

  res.status(401).json({ error: 'Unauthorized' });
};

app.use(basicAuth);

// Dynamic VPS route middleware to hide settings menu and block settings page access
app.use((req, res, next) => {
  const urlPath = req.path;
  const isHtml = urlPath === '/' || urlPath === '/cockpit' || urlPath === '/cockpit2' || urlPath.endsWith('.html') || urlPath === '/settings';
  
  if (isHtml) {
    const settings = loadSettings();
    const isVps = settings.disableScraper || process.env.DISABLE_SCRAPER === 'true';
    
    if (isVps) {
      if (urlPath.includes('settings')) {
        return res.redirect('/index.html');
      }
      
      let filename = urlPath;
      if (filename === '/') filename = 'index.html';
      if (filename === '/cockpit') filename = 'cockpit.html';
      if (filename === '/cockpit2') filename = 'cockpit2.html';
      if (filename.startsWith('/')) filename = filename.substring(1);
      
      const filePath = path.join(__dirname, 'public', filename);
      if (fs.existsSync(filePath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        let html = fs.readFileSync(filePath, 'utf8');
        const styleTag = '<style>li:has(a[href="settings.html"]), a[href="settings.html"] { display: none !important; }</style>';
        html = html.replace('</head>', `${styleTag}</head>`);
        return res.send(html);
      }
    }
  }
  next();
});

// Login page route
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Cockpit page route fallback
app.get('/cockpit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cockpit.html'));
});

app.get('/cockpit2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cockpit2.html'));
});


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

// ETF Alert state tracking (anti-spam: only send when state changes)
let lastEtfAlertState = null; // 'stable' | 'outflow' | 'vampire' | 'outflow+vampire'

// Build ETF alert messages from scraped data (mirrors frontend renderAlerts logic)
function buildEtfAlerts(result, btcPrice) {
  if (!result || !result.formatted || result.formatted.length === 0) return null;
  const latest = result.formatted[0];
  const total = latest.Total ?? 0;
  const gbtc = latest.GBTC ?? 0;
  const alerts = [];
  let stateKey = 'stable';

  // 1. Net outflow alert (same condition as frontend: total < 0)
  if (total < 0) {
    const totalUsd = total * btcPrice;
    const totalBtcStr = Math.abs(total) >= 1000 ? (Math.abs(total)/1000).toFixed(2)+'K' : Math.abs(total).toFixed(2);
    const totalUsdStr = Math.abs(totalUsd) >= 1e9 ? (Math.abs(totalUsd)/1e9).toFixed(2)+'B' : Math.abs(totalUsd) >= 1e6 ? (Math.abs(totalUsd)/1e6).toFixed(2)+'M' : Math.abs(totalUsd).toFixed(2);
    alerts.push(`🔴 <b>Capital Outflow Detected</b>\nNet daily outflow: -${totalBtcStr} BTC\nEquiv: -$${totalUsdStr}`);
    stateKey = 'outflow';
  }

  // 2. Grayscale massive outflow (same condition as frontend: gbtc < -200)
  if (gbtc < -200) {
    const gbtcUsd = gbtc * btcPrice;
    const gbtcBtcStr = Math.abs(gbtc) >= 1000 ? (Math.abs(gbtc)/1000).toFixed(2)+'K' : Math.abs(gbtc).toFixed(2);
    const gbtcUsdStr = Math.abs(gbtcUsd) >= 1e9 ? (Math.abs(gbtcUsd)/1e9).toFixed(2)+'B' : Math.abs(gbtcUsd) >= 1e6 ? (Math.abs(gbtcUsd)/1e6).toFixed(2)+'M' : Math.abs(gbtcUsd).toFixed(2);
    alerts.push(`⚠️ <b>GBTC Vampire Drain</b>\nGrayscale outflow: -${gbtcBtcStr} BTC\nEquiv: -$${gbtcUsdStr}`);
    stateKey = stateKey === 'outflow' ? 'outflow+vampire' : 'vampire';
  }

  // 3. Stable flows (no alerts)
  if (alerts.length === 0) {
    alerts.push(`✅ <b>ETF Stable Flows</b>\nNo active capital drain alerts.\nBTC Price: $${btcPrice.toLocaleString()}`);
  }

  return { alerts, stateKey, total, gbtc };
}

// Page-specific scraping locks
let isEtfScrapingBusy = false;
let isHeatmapScrapingBusy = false;

// Serial queue/mutex for Chrome remote debugging (CDP) interactions
let cdpMutex = Promise.resolve();

async function runWithCdpLock(fn) {
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    throw new Error('Scraper is disabled on this instance.');
  }

  const currentLock = cdpMutex;
  let resolveLock;
  cdpMutex = new Promise((resolve) => {
    resolveLock = resolve;
  });
  
  try {
    await currentLock;
  } catch (e) {
    // Ignore errors from previous queue item
  }
  
  try {
    return await fn();
  } finally {
    // Allow 2 seconds for Chrome tab states/URLs to stabilize before releasing the lock
    setTimeout(resolveLock, 2000);
  }
}

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
  // 1. Find the CoinGlass tab
  const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(5000) });
  const tabs = await tabsResponse.json();
  let tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com' + path));
  let navigated = false;

  if (!tab) {
    // Fallback: Try any active http/https tab
    tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    if (!tab) throw new Error('No suitable tab found. Please make sure a web page is open in Chrome.');
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

    const dataObj = {
      hdrs,
      rows,
      formatted,
      kpis: parsed.kpis,
      timestamp: new Date().toISOString()
    };
    pushToVps('/api/etf-data/update', { data: dataObj }).catch(console.error);
    return dataObj;

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

// Heatmap 3D cache
let heatmap3DCache = null;
let lastHeatmap3DFetchTime = null;
let sweepPrediction3DCache = null;

// Cache variables for Combined Order Book
let orderBookDataCache = null;
let lastOrderBookFetchTime = null;
let isOrderBookScrapingBusy = false;

// Cache variables for Depth Delta, Coinbase Premium, and Whale Orders
let depthDeltaCache = null;
let lastDepthDeltaFetchTime = null;
let isDepthDeltaScrapingBusy = false;

let cbPremiumCache = null;
let lastCbPremiumFetchTime = null;
let isCbPremiumScrapingBusy = false;

let whaleOrdersCache = null;
let lastWhaleOrdersFetchTime = null;
let isWhaleOrdersScrapingBusy = false;

let whaleRetailDeltaCache = null;
let lastWhaleRetailDeltaFetchTime = null;
let isWhaleRetailDeltaScrapingBusy = false;

let topTraderLsCache = null;
let lastTopTraderLsFetchTime = null;
let isTopTraderLsScrapingBusy = false;

// Cache variables for CoinGlass TV (CVD, OI, Funding Rate, Price)
let coinglassTvCache = null;
let lastCoinglassTvFetchTime = null;
let isCoinglassTvScrapingBusy = false;

// Last strategy phase reported to Telegram to prevent duplicate alerts
let lastTelegramPhase = null;

// ─── Cache Disk Persistence ──────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function saveCacheToDisk(filename, data) {
  try {
    const filePath = path.join(CACHE_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[Cache] Successfully persisted ${filename} to disk.`);
  } catch (err) {
    console.error(`[Cache Error] Failed to save ${filename} to disk:`, err.message);
  }
}

function loadCacheFromDisk(filename) {
  try {
    const filePath = path.join(CACHE_DIR, filename);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      console.log(`[Cache] Successfully loaded ${filename} from disk.`);
      return parsed;
    }
  } catch (err) {
    console.error(`[Cache Error] Failed to load ${filename} from disk:`, err.message);
  }
  return null;
}

// Load caches on startup
etfDataCache = loadCacheFromDisk('etf_cache.json');
if (etfDataCache) {
  lastFetchTime = Date.now();
}

heatmapDataCache = loadCacheFromDisk('heatmap24h_cache.json');
if (heatmapDataCache) {
  lastHeatmapFetchTime = Date.now();
}

heatmap3DCache = loadCacheFromDisk('heatmap3d_cache.json');
if (heatmap3DCache) {
  lastHeatmap3DFetchTime = Date.now();
}

orderBookDataCache = loadCacheFromDisk('orderbook_cache.json');
if (orderBookDataCache) {
  lastOrderBookFetchTime = Date.now();
}

depthDeltaCache = loadCacheFromDisk('depth_delta_cache.json');
if (depthDeltaCache) {
  lastDepthDeltaFetchTime = Date.now();
}

cbPremiumCache = loadCacheFromDisk('cb_premium_cache.json');
if (cbPremiumCache) {
  lastCbPremiumFetchTime = Date.now();
}

whaleOrdersCache = loadCacheFromDisk('whale_orders_cache.json');
if (whaleOrdersCache) {
  lastWhaleOrdersFetchTime = Date.now();
}

whaleRetailDeltaCache = loadCacheFromDisk('whale_retail_delta_cache.json');
if (whaleRetailDeltaCache) {
  lastWhaleRetailDeltaFetchTime = Date.now();
}

topTraderLsCache = loadCacheFromDisk('top_trader_ls_cache.json');
if (topTraderLsCache) {
  lastTopTraderLsFetchTime = Date.now();
}

coinglassTvCache = loadCacheFromDisk('coinglass_tv_cache.json');
if (coinglassTvCache) {
  lastCoinglassTvFetchTime = Date.now();
}




// ─── Heatmap 3D Scraper ──────────────────────────────────────────────────────
// Uses the existing CoinGlass tab; navigates to heatmap and selects "3 day" period.
let heatmap3DTabId = null;
async function scrapeHeatMap3D() {
  const listResp = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(5000) });
  const tabs = await listResp.json();

  // Use existing CoinGlass LiquidationHeatMap tab specifically to avoid hijacking other tabs
  let tab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('coinglass.com/pro/futures/LiquidationHeatMap')) || null;
  let navigated = false;

  if (!tab) {
    // Fallback 1: Try any other CoinGlass tab
    tab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('coinglass.com')) || null;
    if (!tab) {
      // Fallback 2: Try any active http/https tab
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found for 3D scrape. Please make sure a web page is open in Chrome/TradingView.');
    navigated = true;
  }
  const savedUrl = navigated ? tab.url : null;

  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
  });

  let msgId = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = msgId++;
    const t = setTimeout(() => rej(new Error('CDP timeout: ' + method)), 35000);
    const handler = raw => {
      const msg = JSON.parse(raw);
      if (msg.id === id) { clearTimeout(t); ws.off('message', handler); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      else ws.once('message', handler);
    };
    ws.once('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await cdp('Runtime.enable');
    await cdp('Page.enable');

    // Navigate to LiquidationHeatMap (may be on ETF page after restoration)
    const curUrl = await cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    const isOnHeatmap = (curUrl?.result?.value || '').includes('LiquidationHeatMap');

    if (!isOnHeatmap) {
      console.log('[Heatmap3D] Navigating to LiquidationHeatMap...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap' });
      await new Promise(r => setTimeout(r, 15000)); // full React render
    } else {
      console.log('[Heatmap3D] Already on LiquidationHeatMap page. Bypassing reload.');
      await new Promise(r => setTimeout(r, 2000));
    }

    // Use CDP Input.dispatchMouseEvent for real OS-level events
    async function cdpClick(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await new Promise(r => setTimeout(r, 80));
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await new Promise(r => setTimeout(r, 80));
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }

    // Switch to 3D period using robust JS event-based clicks (works on both mobile/collapsed dropdowns and wide layouts)
    const triggerClickExpr = `
      function triggerEvents(el) {
        var names = ['mouseenter', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'];
        names.forEach(function(n) {
          if (n === 'focus') el.focus();
          else el.dispatchEvent(new MouseEvent(n, { bubbles: true, cancelable: true, view: window }));
        });
      }
    `;

    // Switch to 3D period using robust JS event-based clicks and polling
    console.log('[Heatmap3D] Attempting robust period selection to 3D...');
    const clickResultVal = await cdp('Runtime.evaluate', {
      expression: `
        new Promise(function(resolve) {
          var start = Date.now();
          
          function triggerEvents(el) {
            var names = ['mouseenter', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'];
            names.forEach(function(n) {
              if (n === 'focus') el.focus();
              else el.dispatchEvent(new MouseEvent(n, { bubbles: true, cancelable: true, view: window }));
            });
          }

          function poll() {
            var dropdownBtn = document.querySelector('button.MuiSelect-button, button[role="combobox"]');
            if (dropdownBtn) {
              var txt = (dropdownBtn.innerText || dropdownBtn.textContent || '').trim();
              if (txt.includes('3 day')) {
                resolve(JSON.stringify({ success: true, text: txt, note: 'already-selected' }));
                return;
              }
            }

            if (dropdownBtn) {
              triggerEvents(dropdownBtn);
              
              var menuStart = Date.now();
              function pollMenu() {
                if (Date.now() - start > 15000) {
                  resolve(JSON.stringify({ success: false, error: 'timeout waiting for 3d menu item' }));
                  return;
                }
                
                var options = Array.from(document.querySelectorAll('li.MuiOption-root'));
                for (var i = 0; i < options.length; i++) {
                  var optTxt = (options[i].innerText || options[i].textContent || '').trim();
                  if (optTxt.includes('3 day')) {
                    triggerEvents(options[i]);
                    resolve(JSON.stringify({ success: true, text: optTxt, note: 'dropdown-clicked' }));
                    return;
                  }
                }
                
                if (Date.now() - menuStart < 8000) {
                  setTimeout(pollMenu, 200);
                } else {
                  triggerEvents(dropdownBtn);
                  setTimeout(pollMenu, 1000);
                }
              }
              setTimeout(pollMenu, 100);
              return;
            }

            if (Date.now() - start < 15000) {
              setTimeout(poll, 500);
            } else {
              resolve(JSON.stringify({ success: false, error: 'timeout waiting for dropdown button' }));
            }
          }
          
          poll();
        })
      `,
      awaitPromise: true,
      returnByValue: true
    });

    let clickResult = 'no-3day-button-found';
    try {
      const resVal = JSON.parse(clickResultVal?.result?.value || '{}');
      if (resVal.success) {
        clickResult = (resVal.note === 'already-selected' ? 'already-selected-3d' : 'dropdown-js-click') + ' "' + resVal.text + '"';
        console.log(`[Heatmap3D] Period select succeeded (${resVal.note}): ${resVal.text}`);
      } else {
        console.warn('[Heatmap3D] Robust selection failed:', resVal.error);
      }
    } catch(e) {
      console.error('[Heatmap3D] Error parsing select result:', e.message);
    }
    console.log('[Heatmap3D] Period select result:', clickResult);
    
    // Wait up to 45s for chart to update to 3D period.
    // Validate by time SPAN (first→last xAxis), not bar count — 24H also has 288 bars.
    // 3D must span at least 48 hours to be genuine 3-day data.
    let chartUpdated = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await cdp('Runtime.evaluate', {
        expression: `(function(){
          var el=document.querySelector('.echarts-for-react');
          if(!el) return JSON.stringify({len:0,spanHours:0});
          var keys=Object.keys(el),fk=keys.find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactContainer$'));
          if(!fk) return JSON.stringify({len:0,spanHours:0});
          var f=el[fk],opt=null;
          while(f){if(f.memoizedProps&&f.memoizedProps.option){opt=f.memoizedProps.option;break;}f=f.return;}
          if(!opt||!opt.xAxis) return JSON.stringify({len:0,spanHours:0});
          var xa=Array.isArray(opt.xAxis)?opt.xAxis[0].data:opt.xAxis.data;
          if(!xa||xa.length<2) return JSON.stringify({len:xa?xa.length:0,spanHours:0});
          var t0=new Date(xa[0]).getTime(), t1=new Date(xa[xa.length-1]).getTime();
          var spanHours=isNaN(t0)||isNaN(t1)?0:((t1-t0)/3600000);
          return JSON.stringify({len:xa.length,spanHours:Math.round(spanHours)});
        })()`,
        returnByValue: true
      });
      let info = { len: 0, spanHours: 0 };
      try { info = JSON.parse(check?.result?.value || '{}'); } catch(e) {}
      if (info.spanHours >= 48) {
        console.log('[Heatmap3D] Chart confirmed 3D after', (attempt+1)*3, 's. bars:', info.len, 'span:', info.spanHours + 'h');
        chartUpdated = true;
        break;
      }
      console.log('[Heatmap3D] Waiting for 3D... attempt', attempt+1, 'bars:', info.len, 'span:', info.spanHours + 'h (need ≥48h)');
    }
    if (!chartUpdated) console.log('[Heatmap3D] Period did not switch to 3D (time span <48h) — scraping skipped.');

    // Scrape chart data
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
                  if (fiber.memoizedProps && fiber.memoizedProps.option) { option = fiber.memoizedProps.option; break; }
                  fiber = fiber.return;
                }
                if (option && option.series && option.series.length > 0) {
                  var xa = option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null;
                  if (xa && xa.length > 150) {
                    resolve(JSON.stringify({
                      xAxis: xa,
                      yAxis: option.yAxis ? (Array.isArray(option.yAxis) ? option.yAxis[0].data : option.yAxis.data) : null,
                      series: option.series.map(s => {
                        if (s.type === 'heatmap' && Array.isArray(s.data)) {
                          return {
                            name: s.name,
                            type: s.type,
                            data: s.data.filter(item => {
                              const val = Array.isArray(item) ? item[2] : (item && item.value ? item.value[2] : null);
                              return val !== null && val !== undefined && val > 0;
                            })
                          };
                        }
                        return { name: s.name, type: s.type, data: s.data };
                      }),
                      visualMap: option.visualMap ? { min: option.visualMap.min, max: option.visualMap.max } : null
                    }));
                    return;
                  }
                }
              }
            }
            if (Date.now() - start < 45000) setTimeout(check, 2000);
            else resolve(JSON.stringify({ error: 'timeout waiting for 3D chart data' }));
          }
          setTimeout(check, 1000);
        })
      `,
      awaitPromise: true,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('No 3D data returned');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('3D scrape: ' + parsed.error);

    const dataObj = { data: parsed, timestamp: new Date().toISOString(), period: chartUpdated ? '3d' : '24h-fallback' };
    pushToVps('/api/heatmap-data/update', { period: dataObj.period === '3d' ? '3d' : '24h', data: dataObj.data || dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Heatmap3D] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Heatmap3D] Failed to navigate back:', e));
    }
    ws.close();
  }
}

async function scrapeDepthDelta() {
  let tabs = null;
  let retries = 3;
  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list from port 9222.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/pro/depth-delta') || t.url?.includes('coinglass.com/depth-delta')));
  let navigated = false;
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found.');
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
      if (ws) { try { ws.close(); } catch (err) {} ws = null; }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket: ${e.message}`);
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
          const charts = document.querySelectorAll('.echarts-for-react');
          if (charts.length === 0) return null;
          
          const results = Array.from(charts).map((el, index) => {
            const keys = Object.keys(el);
            const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
            if (!fiberKey) return { index, error: 'No fiber key' };
            
            let fiber = el[fiberKey];
            let option = null;
            while (fiber) {
              if (fiber.memoizedProps && fiber.memoizedProps.option) {
                option = fiber.memoizedProps.option;
                break;
              }
              fiber = fiber.return;
            }
            if (!option) return { index, error: 'No option' };
            
            return {
              index,
              xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null,
              series: option.series ? option.series.map(s => ({
                name: s.name,
                type: s.type,
                data: s.data
              })) : null
            };
          });
          return JSON.stringify(results);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    if (navigated) {
      console.log('[Scraper] Navigating to Depth Delta...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/depth-delta' });
      await new Promise(r => setTimeout(r, 15000));
    }

    console.log('[Scraper] Polling Depth Delta ECharts data...');
    const result = await cdp('Runtime.evaluate', {
      expression: fiberExpression,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('No depth delta data returned');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('Depth Delta: ' + parsed.error);

    const dataObj = { data: parsed, timestamp: new Date().toISOString() };
    pushToVps('/api/depth-delta/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Scraper] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Scraper] Failed to navigate back:', e));
    }
    ws.close();
  }
}

async function scrapeCoinbasePremium() {
  let tabs = null;
  let retries = 3;
  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/pro/i/coinbase-bitcoin-premium-index') || t.url?.includes('coinglass.com/pro/futures/CoinbasePremium')));
  let navigated = false;
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found.');
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
      if (ws) { try { ws.close(); } catch (err) {} ws = null; }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket: ${e.message}`);
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
          const charts = document.querySelectorAll('.echarts-for-react');
          if (charts.length === 0) return null;
          
          const results = Array.from(charts).map((el, index) => {
            const keys = Object.keys(el);
            const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
            if (!fiberKey) return { index, error: 'No fiber key' };
            
            let fiber = el[fiberKey];
            let option = null;
            while (fiber) {
              if (fiber.memoizedProps && fiber.memoizedProps.option) {
                option = fiber.memoizedProps.option;
                break;
              }
              fiber = fiber.return;
            }
            if (!option) return { index, error: 'No option' };
            
            return {
              index,
              xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null,
              series: option.series ? option.series.map(s => ({
                name: s.name,
                type: s.type,
                data: s.data
              })) : null
            };
          });
          return JSON.stringify(results);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    if (navigated) {
      console.log('[Scraper] Navigating to Coinbase Premium Index...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/i/coinbase-bitcoin-premium-index' });
      await new Promise(r => setTimeout(r, 15000));
    }

    console.log('[Scraper] Polling Coinbase Premium ECharts data...');
    const result = await cdp('Runtime.evaluate', {
      expression: fiberExpression,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('No coinbase premium data returned');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('Coinbase Premium: ' + parsed.error);

    const dataObj = { data: parsed, timestamp: new Date().toISOString() };
    pushToVps('/api/coinbase-premium/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Scraper] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Scraper] Failed to navigate back:', e));
    }
    ws.close();
  }
}

async function scrapeWhaleRetailDelta() {
  let tabs = null;
  let retries = 3;
  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/pro/i/whale-vs-retail-delta') || t.url?.includes('whale-vs-retail-delta')));
  let navigated = false;
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found for Whale vs Retail Delta.');
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
      if (ws) { try { ws.close(); } catch (err) {} ws = null; }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket: ${e.message}`);
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
          const charts = document.querySelectorAll('.echarts-for-react');
          if (charts.length === 0) return null;
          
          const results = Array.from(charts).map((el, index) => {
            const keys = Object.keys(el);
            const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
            if (!fiberKey) return { index, error: 'No fiber key' };
            
            let fiber = el[fiberKey];
            let option = null;
            while (fiber) {
              if (fiber.memoizedProps && fiber.memoizedProps.option) {
                option = fiber.memoizedProps.option;
                break;
              }
              fiber = fiber.return;
            }
            if (!option) return { index, error: 'No option' };
            
            return {
              index,
              xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null,
              series: option.series ? option.series.map(s => ({
                name: s.name,
                type: s.type,
                data: s.data
              })) : null
            };
          });
          return JSON.stringify(results);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    if (navigated) {
      console.log('[Scraper] Navigating to Whale vs Retail Delta...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/i/whale-vs-retail-delta' });
      await new Promise(r => setTimeout(r, 15000));
    }

    console.log('[Scraper] Polling Whale vs Retail Delta ECharts data...');
    const result = await cdp('Runtime.evaluate', {
      expression: fiberExpression,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('No whale vs retail delta data returned');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('Whale vs Retail Delta: ' + parsed.error);

    const dataObj = { data: parsed, timestamp: new Date().toISOString() };
    pushToVps('/api/whale-retail-delta/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Scraper] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Scraper] Failed to navigate back:', e));
    }
    ws.close();
  }
}

async function scrapeCoinGlassTv() {
  let tabs = null;
  let retries = 3;
  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com/tv/'));
  let navigated = false;
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found for CoinGlass TV.');
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
      if (ws) { try { ws.close(); } catch (err) {} ws = null; }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket: ${e.message}`);
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
    await cdp('Runtime.enable');

    const hookScript = `
      window.__capturedTVData = [];
      const originalParse = JSON.parse;
      JSON.parse = function(text, reviver) {
        const res = originalParse.call(JSON, text, reviver);
        try {
          if (res && typeof res === 'object') {
            let shouldCapture = false;
            let label = 'unknown';
            if (res.code === '0' && res.data) {
              shouldCapture = true;
              label = 'api_response';
            } else if (Array.isArray(res) && res.length > 5) {
              shouldCapture = true;
              label = 'array_data';
            }
            if (shouldCapture) {
              window.__capturedTVData.push({
                timestamp: Date.now(),
                label,
                fullContent: res
              });
            }
          }
        } catch (e) {}
        return res;
      };
    `;

    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: hookScript });

    console.log('[Scraper TV] Navigating/Reloading CoinGlass TV page...');
    await cdp('Page.navigate', { url: 'https://www.coinglass.com/tv/Binance_BTCUSDT' });

    // Wait for page load and API responses to decrypt
    await new Promise(r => setTimeout(r, 15000));

    const evalResult = await cdp('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__capturedTVData || [])',
      returnByValue: true
    });

    const rawVal = evalResult?.result?.value;
    if (!rawVal) throw new Error('No CoinGlass TV data captured');
    const captured = JSON.parse(rawVal);

    let price = null;
    let cvdRaw = null;
    let oi = null;
    let fundingRate = null;
    let spotCvdRaw = null;
    let bidAskDeltaRaw = null;
    let markets = null;
    let performance = null;

    for (const item of captured) {
      let content = item.fullContent;
      if (!content) continue;

      if (content.code === '0' && content.data !== undefined && content.data !== null) {
        content = content.data;
      }

      if (Array.isArray(content) && content.length > 0) {
        const firstEl = content[0];
        if (Array.isArray(firstEl)) {
          const val = parseFloat(firstEl[1]);

          if (firstEl.length === 6) {
            if (val > 25000 && val < 200000) {
              price = content;
            }
          } else if (firstEl.length === 5) {
            if (typeof firstEl[1] === 'string') {
              if (Math.abs(val) < 0.15) {
                fundingRate = content;
              } else {
                oi = content;
              }
            } else {
              bidAskDeltaRaw = content;
            }
          } else if (firstEl.length === 3) {
            // Identify Futures CVD vs Spot CVD from length 3 arrays
            if (typeof firstEl[1] === 'string') {
              cvdRaw = content;
            } else {
              spotCvdRaw = content;
            }
          }
        } else if (typeof firstEl === 'object' && firstEl !== null) {
          if (firstEl.symbol && (firstEl.volUsd || firstEl.openInterest)) {
            markets = content;
          }
        }
      } else if (content && typeof content === 'object') {
        if (content.d7 !== undefined && content.d30 !== undefined && content.y1 !== undefined) {
          performance = content;
        }
      }
    }

    // Helper to compute cumulative sum for CVD lines from [timestamp, buy, sell]
    const computeCvdLine = (arr) => {
      if (!Array.isArray(arr)) return null;
      let cum = 0;
      return arr.map(item => {
        const ts = item[0];
        const buy = parseFloat(item[1]) || 0;
        const sell = parseFloat(item[2]) || 0;
        cum += (buy - sell);
        return [ts, cum];
      });
    };

    // Helper to compute cumulative sum for Futures CVD from [timestamp, buy, sell]
    const computeFuturesCvdLine = (arr) => {
      if (!Array.isArray(arr)) return null;
      let cum = 0;
      return arr.map(item => {
        const ts = item[0];
        const buy = parseFloat(item[1]) || 0;
        const sell = parseFloat(item[2]) || 0;
        cum += (buy - sell);
        return [ts, cum];
      });
    };

    // Helper to compute delta for histograms from cvdRaw [timestamp, buy, sell, buyUsd, sellUsd]
    const computeFuturesDeltaLine = (arr) => {
      if (!Array.isArray(arr)) return null;
      return arr.map(item => {
        const ts = item[0];
        const buy = parseFloat(item[1]) || 0;
        const sell = parseFloat(item[2]) || 0;
        return [ts, buy - sell];
      });
    };

    const cvd = computeFuturesCvdLine(cvdRaw);
    const spotCvd = computeCvdLine(spotCvdRaw);
    const bidAskDelta = computeFuturesDeltaLine(bidAskDeltaRaw);

    if (!price || !cvd || !oi || !fundingRate) {
      console.log(`[Scraper TV] Missing some indicators. Price=${!!price}, CVD=${!!cvd}, OI=${!!oi}, FundingRate=${!!fundingRate}, SpotCVD=${!!spotCvd}, BidAskDelta=${!!bidAskDelta}`);
    }

    const dataObj = {
      timestamp: new Date().toISOString(),
      price,
      cvd,
      oi,
      fundingRate,
      spotCvd,
      bidAskDelta,
      markets: markets ? markets.slice(0, 15) : null,
      performance
    };

    pushToVps('/api/coinglass-tv/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Scraper TV] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Scraper TV] Failed to navigate back:', e));
    }
    ws.close();
  }
}

async function scrapeTopTraderLs() {
  let tabs = null;
  let retries = 3;
  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/position') || t.url?.includes('coinglass.com/zh/position')));
  let navigated = false;
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found for Top Trader L/S.');
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
      if (ws) { try { ws.close(); } catch (err) {} ws = null; }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket: ${e.message}`);
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

    const domExpression = `
      (() => {
        try {
          var headers = [];
          var ths = document.querySelectorAll('th');
          ths.forEach(function(th) {
            headers.push((th.innerText || th.textContent || '').trim());
          });

          var rows = [];
          var trs = document.querySelectorAll('tr.ant-table-row');
          trs.forEach(function(tr) {
            var tds = tr.querySelectorAll('td');
            if (tds.length > 0) {
              var rowData = Array.from(tds).map(function(td) {
                return (td.innerText || td.textContent || '').trim().replace(/\\s+/g, ' ');
              });
              rows.push(rowData);
            }
          });
          return JSON.stringify({ headers: headers, rows: rows });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    if (navigated) {
      console.log('[Scraper] Navigating to Top Trader Long/Short Ratio...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/position' });
      await new Promise(r => setTimeout(r, 15000));
    }

    console.log('[Scraper] Polling Top Trader Long/Short table...');
    const result = await cdp('Runtime.evaluate', {
      expression: domExpression,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('No top trader L/S data returned');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('Top Trader L/S: ' + parsed.error);

    const dataObj = { data: parsed, timestamp: new Date().toISOString() };
    pushToVps('/api/top-trader-ls/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Scraper] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Scraper] Failed to navigate back:', e));
    }
    ws.close();
  }
}

async function scrapeWhaleOrders() {
  let tabs = null;
  let retries = 3;
  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/large-orderbook-statistics') || t.url?.includes('coinglass.com/pro/orderbook/WhaleOrders')));
  let navigated = false;
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found.');
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
      if (ws) { try { ws.close(); } catch (err) {} ws = null; }
      if (retries === 0) throw new Error(`Failed to connect to Chrome DevTools WebSocket: ${e.message}`);
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

    const domExpression = `
      (() => {
        try {
          var rows = [];
          var items = document.querySelectorAll('.large-order-item');
          
          var parseVal = function(str) {
            if (!str) return 0;
            var clean = str.replace(/\\$|,/g, '').toUpperCase().trim();
            var mult = 1;
            if (clean.endsWith('K')) { mult = 1000; clean = clean.slice(0, -1); }
            else if (clean.endsWith('M')) { mult = 1000000; clean = clean.slice(0, -1); }
            else if (clean.endsWith('B')) { mult = 1000000000; clean = clean.slice(0, -1); }
            return parseFloat(clean) * mult;
          };

          var getExchangeName = function(src) {
            if (!src) return 'Unknown';
            var lower = src.toLowerCase();
            if (lower.indexOf('coinbase') !== -1) return 'Coinbase';
            if (lower.indexOf('binance') !== -1 || lower.indexOf('270.png') !== -1) return 'Binance';
            if (lower.indexOf('okx') !== -1 || lower.indexOf('82.png') !== -1) return 'OKX';
            if (lower.indexOf('bybit') !== -1 || lower.indexOf('1027.png') !== -1 || lower.indexOf('334.png') !== -1) return 'Bybit';
            var parts = src.split('/');
            var filename = parts[parts.length - 1].replace(/%20/g, ' ');
            return filename.split('.')[0].toUpperCase();
          };

          items.forEach(function(el) {
            var img = el.querySelector('img');
            var exchange = img ? getExchangeName(img.src) : 'Binance';
            
            var text = (el.innerText || '').trim();
            var tokens = text.split(/\\s+/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
            
            if (tokens.length >= 4) {
              var type = tokens[0]; // P or S
              var price = parseFloat(tokens[1].replace(/,/g, '')) || 0;
              var valueUsd = parseVal(tokens[2]);
              var age = tokens.slice(3).join(' ');
              
              var side = 'buy';
              if (el.querySelector('[class*=\"ovv2-item-bg-s\"]')) {
                side = 'sell';
              } else if (el.querySelector('[class*=\"ovv2-item-bg-b\"]')) {
                side = 'buy';
              }

              if (price > 0 && valueUsd > 0) {
                rows.push({
                  exchange: exchange,
                  marketType: type,
                  price: price,
                  valueUsd: valueUsd,
                  age: age,
                  side: side
                });
              }
            }
          });
          return JSON.stringify(rows);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `;

    if (navigated) {
      console.log('[Scraper] Navigating to Large Orderbook Statistics...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/large-orderbook-statistics' });
      await new Promise(r => setTimeout(r, 15000));
    }

    console.log('[Scraper] Polling Whale Orders from DOM...');
    const result = await cdp('Runtime.evaluate', {
      expression: domExpression,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (!val) throw new Error('No whale orders data returned');
    const parsed = JSON.parse(val);
    if (parsed.error) throw new Error('Whale Orders: ' + parsed.error);

    const dataObj = { data: parsed, timestamp: new Date().toISOString() };
    pushToVps('/api/whale-orders/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Scraper] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Scraper] Failed to navigate back:', e));
    }
    ws.close();
  }
}


// ─── Order Book Key Levels — replaces CoinGlass Chrome scraping ──────────────
// Fetches Binance Futures depth + klines and returns the exact same data structure
// that scrapeHeatMap() returned so the frontend renders without changes.
const OB_BUCKET = 100; // USD per price bucket

async function scrapeHeatMap(forceRefresh = false) {
  let tabs = null;
  let retries = 3;

  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list from port 9222. Is the browser debug port responsive?');
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
      // Fallback 2: Try any active http/https tab
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable tab found. Please make sure a web page is open in Chrome.');
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
            series: option.series ? option.series.map(s => {
              if (s.type === 'heatmap' && Array.isArray(s.data)) {
                return {
                  name: s.name,
                  type: s.type,
                  data: s.data.filter(item => {
                    const val = Array.isArray(item) ? item[2] : (item && item.value ? item.value[2] : null);
                    return val !== null && val !== undefined && val > 0;
                  })
                };
              }
              return { name: s.name, type: s.type, data: s.data };
            }) : null,
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
          const xa = parsed.xAxis || [];
          let spanHours = 0;
          if (xa.length >= 2) {
            const t0 = new Date(xa[0]).getTime(), t1 = new Date(xa[xa.length - 1]).getTime();
            spanHours = isNaN(t0) || isNaN(t1) ? 0 : ((t1 - t0) / 3600000);
          }
          if (spanHours > 15 && spanHours <= 30) {
            console.log('Instant heatmap scrape succeeded!');
            return {
              data: parsed,
              timestamp: new Date().toISOString()
            };
          } else {
            console.log(`Instant scrape got chart with span ${spanHours}h (not 24h). Proceeding to reload and switch period...`);
          }
        }
      }
    }

    if (navigated) {
      console.log('Navigating to LiquidationHeatMap...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap' });
      await new Promise(r => setTimeout(r, 15000)); // wait for full React render
    } else {
      console.log('Already on LiquidationHeatMap page. Bypassing reload.');
      await new Promise(r => setTimeout(r, 2000));
    }

    // Switch to 24H period using robust JS event-based clicks
    const triggerClickExpr = `
      function triggerEvents(el) {
        var names = ['mouseenter', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'];
        names.forEach(function(n) {
          if (n === 'focus') el.focus();
          else el.dispatchEvent(new MouseEvent(n, { bubbles: true, cancelable: true, view: window }));
        });
      }
    `;

    // Switch to 24H period using robust JS event-based clicks and polling
    console.log('[Heatmap] Attempting robust period selection to 24H...');
    const clickResultVal = await cdp('Runtime.evaluate', {
      expression: `
        new Promise(function(resolve) {
          var start = Date.now();
          
          function triggerEvents(el) {
            var names = ['mouseenter', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'];
            names.forEach(function(n) {
              if (n === 'focus') el.focus();
              else el.dispatchEvent(new MouseEvent(n, { bubbles: true, cancelable: true, view: window }));
            });
          }

          function poll() {
            var dropdownBtn = document.querySelector('button.MuiSelect-button, button[role="combobox"]');
            if (dropdownBtn) {
              var txt = (dropdownBtn.innerText || dropdownBtn.textContent || '').trim();
              if (txt.includes('24 hour')) {
                resolve(JSON.stringify({ success: true, text: txt, note: 'already-selected' }));
                return;
              }
            }

            if (dropdownBtn) {
              triggerEvents(dropdownBtn);
              
              var menuStart = Date.now();
              function pollMenu() {
                if (Date.now() - start > 15000) {
                  resolve(JSON.stringify({ success: false, error: 'timeout waiting for 24h menu item' }));
                  return;
                }
                
                var options = Array.from(document.querySelectorAll('li.MuiOption-root'));
                for (var i = 0; i < options.length; i++) {
                  var optTxt = (options[i].innerText || options[i].textContent || '').trim();
                  if (optTxt.includes('24 hour')) {
                    triggerEvents(options[i]);
                    resolve(JSON.stringify({ success: true, text: optTxt, note: 'dropdown-clicked' }));
                    return;
                  }
                }
                
                if (Date.now() - menuStart < 8000) {
                  setTimeout(pollMenu, 200);
                } else {
                  triggerEvents(dropdownBtn);
                  setTimeout(pollMenu, 1000);
                }
              }
              setTimeout(pollMenu, 100);
              return;
            }

            if (Date.now() - start < 15000) {
              setTimeout(poll, 500);
            } else {
              resolve(JSON.stringify({ success: false, error: 'timeout waiting for dropdown button' }));
            }
          }
          
          poll();
        })
      `,
      awaitPromise: true,
      returnByValue: true
    });

    let clickResult = 'no-24h-button-found';
    try {
      const resVal = JSON.parse(clickResultVal?.result?.value || '{}');
      if (resVal.success) {
        clickResult = (resVal.note === 'already-selected' ? 'already-selected-24h' : 'dropdown-js-click') + ' "' + resVal.text + '"';
        console.log(`[Heatmap] Period select succeeded (${resVal.note}): ${resVal.text}`);
      } else {
        console.warn('[Heatmap] Robust selection failed:', resVal.error);
      }
    } catch(e) {
      console.error('[Heatmap] Error parsing select result:', e.message);
    }
    console.log('[Heatmap] Period select result:', clickResult);

    // Wait up to 45s for chart to update to 24H period.
    let chartUpdated = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await cdp('Runtime.evaluate', {
        expression: `(function(){
          var el=document.querySelector('.echarts-for-react');
          if(!el) return JSON.stringify({len:0,spanHours:0});
          var keys=Object.keys(el),fk=keys.find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactContainer$'));
          if(!fk) return JSON.stringify({len:0,spanHours:0});
          var f=el[fk],opt=null;
          while(f){if(f.memoizedProps&&f.memoizedProps.option){opt=f.memoizedProps.option;break;}f=f.return;}
          if(!opt||!opt.xAxis) return JSON.stringify({len:0,spanHours:0});
          var xa=Array.isArray(opt.xAxis)?opt.xAxis[0].data:opt.xAxis.data;
          if(!xa||xa.length<2) return JSON.stringify({len:xa?xa.length:0,spanHours:0});
          var t0=new Date(xa[0]).getTime(), t1=new Date(xa[xa.length-1]).getTime();
          var spanHours=isNaN(t0)||isNaN(t1)?0:((t1-t0)/3600000);
          return JSON.stringify({len:xa.length,spanHours:Math.round(spanHours)});
        })()`,
        returnByValue: true
      });
      let info = { len: 0, spanHours: 0 };
      try { info = JSON.parse(check?.result?.value || '{}'); } catch(e) {}
      if (info.spanHours > 15 && info.spanHours <= 30) {
        console.log('[Heatmap] Chart confirmed 24H after', (attempt+1)*3, 's. bars:', info.len, 'span:', info.spanHours + 'h');
        chartUpdated = true;
        break;
      }
      console.log('[Heatmap] Waiting for 24H... attempt', attempt+1, 'bars:', info.len, 'span:', info.spanHours + 'h (need 15-30h)');
    }
    if (!chartUpdated) console.log('[Heatmap] Period did not switch to 24H (time span not 15-30h) — scraping with current span.');

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
                    series: option.series.map(s => {
                      if (s.type === 'heatmap' && Array.isArray(s.data)) {
                        return {
                          name: s.name,
                          type: s.type,
                          data: s.data.filter(item => {
                            const val = Array.isArray(item) ? item[2] : (item && item.value ? item.value[2] : null);
                            return val !== null && val !== undefined && val > 0;
                          })
                        };
                      }
                      return { name: s.name, type: s.type, data: s.data };
                    }),
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

    const dataObj = {
      data: parsed,
      timestamp: new Date().toISOString()
    };
    pushToVps('/api/heatmap-data/update', { period: '24h', data: dataObj.data || dataObj }).catch(console.error);
    return dataObj;

  } finally {
    if (navigated && savedUrl) {
      console.log(`Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('Failed to navigate back:', e));
    }
    ws.close();
  }
}

// ─── Combined Order Book Scraper (CDP) ───────────────────────────────────────
async function scrapeOrderBookCombined(forceRefresh = false) {
  let tabs = null;
  let retries = 3;

  while (retries > 0) {
    try {
      const tabsResponse = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(4000) });
      tabs = await tabsResponse.json();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw new Error('Failed to fetch Chrome tab list from port 9222. Is the browser debug port responsive?');
      console.log(`[OrderBook DevTools Retry] Port 9222 unresponsive. Retrying list fetch in 2s... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com/mergev2/BTC-USDT') || t.url?.includes('coinglass.com/mergev2')));
  let navigated = false;

  if (!tab) {
    // Fallback 1: Coba tab coinglass apa saja
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
    if (!tab) {
      // Fallback 2: Coba tab web apa saja yang aktif
      tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    }
    if (!tab) throw new Error('No suitable Chrome tab found for order book scrape. Please open Chrome.');
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
      console.log(`[OrderBook DevTools Retry] WebSocket connection failed. Retrying in 2s... (${retries} retries left). Error: ${e.message}`);
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

    // Ekspresi untuk memeriksa dan mengekstrak data dari DOM (dengan polling)
    const evaluateExpression = `
      new Promise(function(resolve) {
        var start = Date.now();
        function check() {
          var orderbooks = document.querySelectorAll('.orderbook');
          if (orderbooks.length >= 2) {
            var parseBook = function(el) {
              var rows = [];
              
              var parseVal = function(str) {
                if (!str) return 0;
                var clean = str.replace(/,/g, '').toUpperCase().trim();
                var mult = 1;
                if (clean.endsWith('K')) { mult = 1000; clean = clean.slice(0, -1); }
                else if (clean.endsWith('M')) { mult = 1000000; clean = clean.slice(0, -1); }
                else if (clean.endsWith('B')) { mult = 1000000000; clean = clean.slice(0, -1); }
                return parseFloat(clean) * mult;
              };

              // Method 1: Parse via child elements directly (no specific class name required)
              var rowEls = Array.from(el.children);
              if (rowEls.length === 1 && rowEls[0].children.length > 5) {
                rowEls = Array.from(rowEls[0].children);
              }

              rowEls.forEach(function(row) {
                var txt = (row.innerText || row.textContent || '').trim();
                var tokens = txt.split(/\\s+/).filter(function(t){ return t.length > 0; });
                if (tokens.length >= 3) {
                  var price = parseVal(tokens[0]);
                  var quantity = parseVal(tokens[1]);
                  var total = parseVal(tokens[2]);
                  if (!isNaN(price) && !isNaN(quantity) && !isNaN(total) && price > 0) {
                    rows.push({ price: price, quantity: quantity, total: total });
                  }
                }
              });

              // Method 2: Fallback to splitting container innerText by whitespace
              if (rows.length === 0) {
                var allTxt = (el.innerText || el.textContent || '').trim();
                var tokens = allTxt.split(/\\s+/).filter(function(t){ return t.length > 0; });
                for (var i = 0; i < tokens.length; i += 3) {
                  if (i + 2 < tokens.length) {
                    var price = parseVal(tokens[i]);
                    var quantity = parseVal(tokens[i+1]);
                    var total = parseVal(tokens[i+2]);
                    if (!isNaN(price) && !isNaN(quantity) && !isNaN(total) && price > 0) {
                      rows.push({ price: price, quantity: quantity, total: total });
                    }
                  }
                }
              }
              return rows;
            };

            var asks = parseBook(orderbooks[0]);
            var bids = parseBook(orderbooks[1]);
            if (asks.length > 0 && bids.length > 0) {
              resolve(JSON.stringify({ asks: asks, bids: bids }));
              return;
            }
          }
          if (Date.now() - start < 35000) {
            setTimeout(check, 1500);
          } else {
            resolve(JSON.stringify({ error: 'timeout waiting for orderbook data' }));
          }
        }
        setTimeout(check, 1000);
      })
    `;

    // Coba kikis instan jika tab sudah berada di URL yang benar
    if (!navigated && !forceRefresh) {
      console.log('[OrderBook Scraper] Checking if existing tab already has orderbook data...');
      const immediateResult = await cdp('Runtime.evaluate', {
        expression: evaluateExpression,
        awaitPromise: true,
        returnByValue: true
      });
      const raw = immediateResult?.result?.value;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.error && parsed.asks && parsed.asks.length > 0) {
          console.log('[OrderBook Scraper] Instant scrape succeeded!');
          const dataObj = {
            asks: parsed.asks,
            bids: parsed.bids,
            timestamp: new Date().toISOString()
          };
          pushToVps('/api/orderbook-data/update', { data: dataObj }).catch(console.error);
          return dataObj;
        }
      }
    }

    if (navigated || forceRefresh) {
      console.log('[OrderBook Scraper] Navigating to https://www.coinglass.com/mergev2/BTC-USDT...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/mergev2/BTC-USDT' });
      await new Promise(r => setTimeout(r, 10000)); // Wait 10s for React load
    }

    console.log('[OrderBook Scraper] Polling DOM for orderbook data...');
    const result = await cdp('Runtime.evaluate', {
      expression: evaluateExpression,
      awaitPromise: true,
      returnByValue: true
    });

    const raw = result?.result?.value;
    if (!raw) throw new Error('Evaluation returned empty result.');
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(parsed.error);

    console.log(`[OrderBook Scraper] Successfully scraped. Asks: ${parsed.asks.length}, Bids: ${parsed.bids.length}`);
    const dataObj = {
      asks: parsed.asks,
      bids: parsed.bids,
      timestamp: new Date().toISOString()
    };
    pushToVps('/api/orderbook-data/update', { data: dataObj }).catch(console.error);
    return dataObj;
  } finally {
    if (navigated && savedUrl) {
      console.log(`[OrderBook Scraper] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[OrderBook Scraper] Failed to restore URL:', e.message));
    }
    ws.close();
  }
}

// REST API for fetching Combined Order Book data (with cache)
app.get('/api/orderbook-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  // Cache berlaku selama 3 menit (180.000 ms), sama seperti heatmap
  if (orderBookDataCache && !forceRefresh && lastOrderBookFetchTime && (Date.now() - lastOrderBookFetchTime < 180000)) {
    return res.json({ success: true, source: 'cache', data: orderBookDataCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: orderBookDataCache || null });
  }

  if (isOrderBookScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isOrderBookScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass Combined Order Book scrape...');
    const result = await runWithCdpLock(() => scrapeOrderBookCombined(forceRefresh));
    orderBookDataCache = result;
    lastOrderBookFetchTime = Date.now();
    saveCacheToDisk('orderbook_cache.json', orderBookDataCache);

    res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    console.error('[API] Combined Order Book scrape failed:', err.message);
    if (orderBookDataCache) {
      console.log('[API] Falling back to cached orderbook data.');
      res.json({ success: true, source: 'fallback-cache', data: orderBookDataCache, warning: err.message });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isOrderBookScrapingBusy = false;
  }
});

// REST API for fetching Depth Delta data
app.get('/api/depth-delta', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  // Cache valid for 5 minutes (300,000 ms)
  if (depthDeltaCache && !forceRefresh && lastDepthDeltaFetchTime && (Date.now() - lastDepthDeltaFetchTime < 300000)) {
    return res.json({ success: true, source: 'cache', data: depthDeltaCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: depthDeltaCache || null });
  }

  if (isDepthDeltaScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isDepthDeltaScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass Depth Delta scrape...');
    const result = await runWithCdpLock(() => scrapeDepthDelta());
    depthDeltaCache = result;
    lastDepthDeltaFetchTime = Date.now();
    saveCacheToDisk('depth_delta_cache.json', depthDeltaCache);

    res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    console.error('[API] Depth Delta scrape failed:', err.message);
    if (depthDeltaCache) {
      res.json({ success: true, source: 'fallback-cache', data: depthDeltaCache, warning: err.message });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isDepthDeltaScrapingBusy = false;
  }
});

// REST API for fetching Coinbase Premium Index
app.get('/api/coinbase-premium', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (cbPremiumCache && !forceRefresh && lastCbPremiumFetchTime && (Date.now() - lastCbPremiumFetchTime < 300000)) {
    return res.json({ success: true, source: 'cache', data: cbPremiumCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: cbPremiumCache || null });
  }

  if (isCbPremiumScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isCbPremiumScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass Coinbase Premium Index scrape...');
    const result = await runWithCdpLock(() => scrapeCoinbasePremium());
    cbPremiumCache = result;
    lastCbPremiumFetchTime = Date.now();
    saveCacheToDisk('cb_premium_cache.json', cbPremiumCache);

    res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    console.error('[API] Coinbase Premium Index scrape failed:', err.message);
    if (cbPremiumCache) {
      res.json({ success: true, source: 'fallback-cache', data: cbPremiumCache, warning: err.message });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isCbPremiumScrapingBusy = false;
  }
});

// REST API for fetching Whale Orders (Large Orderbook Statistics)
app.get('/api/whale-orders', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  let btcPrice = 65000;
  try {
    const tickerResp = await fetchBinance('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const tickerData = await tickerResp.json();
    btcPrice = parseFloat(tickerData.price) || 65000;
  } catch (e) {
    console.error('[API] Failed to fetch BTC price for whale-orders, using fallback:', e.message);
  }

  if (whaleOrdersCache && !forceRefresh && lastWhaleOrdersFetchTime && (Date.now() - lastWhaleOrdersFetchTime < 300000)) {
    return res.json({ success: true, source: 'cache', data: whaleOrdersCache, btcPrice });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: whaleOrdersCache || null, btcPrice });
  }

  if (isWhaleOrdersScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isWhaleOrdersScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass Large Orderbook Statistics scrape...');
    const result = await runWithCdpLock(() => scrapeWhaleOrders());
    whaleOrdersCache = result;
    lastWhaleOrdersFetchTime = Date.now();
    saveCacheToDisk('whale_orders_cache.json', whaleOrdersCache);

    res.json({ success: true, source: 'live', data: result, btcPrice });
  } catch (err) {
    console.error('[API] Large Orderbook Statistics scrape failed:', err.message);
    if (whaleOrdersCache) {
      res.json({ success: true, source: 'fallback-cache', data: whaleOrdersCache, warning: err.message, btcPrice });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isWhaleOrdersScrapingBusy = false;
  }
});

// REST API for fetching Whale vs Retail Delta
app.get('/api/whale-retail-delta', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (whaleRetailDeltaCache && !forceRefresh && lastWhaleRetailDeltaFetchTime && (Date.now() - lastWhaleRetailDeltaFetchTime < 300000)) {
    return res.json({ success: true, source: 'cache', data: whaleRetailDeltaCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: whaleRetailDeltaCache || null });
  }

  if (isWhaleRetailDeltaScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isWhaleRetailDeltaScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass Whale vs Retail Delta scrape...');
    const result = await runWithCdpLock(() => scrapeWhaleRetailDelta());
    whaleRetailDeltaCache = result;
    lastWhaleRetailDeltaFetchTime = Date.now();
    saveCacheToDisk('whale_retail_delta_cache.json', whaleRetailDeltaCache);

    res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    console.error('[API] Whale vs Retail Delta scrape failed:', err.message);
    if (whaleRetailDeltaCache) {
      res.json({ success: true, source: 'fallback-cache', data: whaleRetailDeltaCache, warning: err.message });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isWhaleRetailDeltaScrapingBusy = false;
  }
});

// REST API for fetching Top Trader Long/Short
app.get('/api/top-trader-ls', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (topTraderLsCache && !forceRefresh && lastTopTraderLsFetchTime && (Date.now() - lastTopTraderLsFetchTime < 300000)) {
    return res.json({ success: true, source: 'cache', data: topTraderLsCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: topTraderLsCache || null });
  }

  if (isTopTraderLsScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isTopTraderLsScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass Top Trader Long/Short scrape...');
    const result = await runWithCdpLock(() => scrapeTopTraderLs());
    topTraderLsCache = result;
    lastTopTraderLsFetchTime = Date.now();
    saveCacheToDisk('top_trader_ls_cache.json', topTraderLsCache);

    res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    console.error('[API] Top Trader Long/Short scrape failed:', err.message);
    if (topTraderLsCache) {
      res.json({ success: true, source: 'fallback-cache', data: topTraderLsCache, warning: err.message });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isTopTraderLsScrapingBusy = false;
  }
});

// REST API for fetching CoinGlass TV data (CVD, OI, Funding Rate, Price)
app.get('/api/coinglass-tv', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (coinglassTvCache && !forceRefresh && lastCoinglassTvFetchTime && (Date.now() - lastCoinglassTvFetchTime < 300000)) {
    return res.json({ success: true, source: 'cache', data: coinglassTvCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: coinglassTvCache || null });
  }

  if (isCoinglassTvScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isCoinglassTvScrapingBusy = true;
  try {
    console.log('[API] Starting CoinGlass TV scrape...');
    const result = await runWithCdpLock(() => scrapeCoinGlassTv());
    coinglassTvCache = result;
    lastCoinglassTvFetchTime = Date.now();
    saveCacheToDisk('coinglass_tv_cache.json', coinglassTvCache);

    res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    console.error('[API] CoinGlass TV scrape failed:', err.message);
    if (coinglassTvCache) {
      res.json({ success: true, source: 'fallback-cache', data: coinglassTvCache, warning: err.message });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  } finally {
    isCoinglassTvScrapingBusy = false;
  }
});

// REST API for fetching consolidated market summary
app.get('/api/coinglass-summary', (req, res) => {
  let score = 0;
  const metrics = {};

  // 1. Depth Delta
  try {
    const inner = depthDeltaCache?.data?.[0] || depthDeltaCache;
    const deltaSeries = inner?.series?.find(s => s.name?.includes('Delta') || s.name === 'Liquidity Delta');
    const latestDelta = deltaSeries?.data?.length ? parseFloat(deltaSeries.data[deltaSeries.data.length - 1]) : null;
    if (latestDelta !== null && !isNaN(latestDelta)) {
      const isBullish = latestDelta > 0;
      metrics.depthDelta = {
        value: latestDelta,
        formatted: (latestDelta > 0 ? '+' : '') + (latestDelta / 1e6).toFixed(2) + 'M',
        sentiment: isBullish ? 'bullish' : 'bearish',
        description: isBullish ? 'Bid depth lebih tebal dari ask depth' : 'Ask depth lebih tebal dari bid depth'
      };
      score += isBullish ? 1 : -1;
    } else {
      metrics.depthDelta = { sentiment: 'neutral', description: 'Data tidak tersedia', formatted: '--' };
    }
  } catch (e) {
    metrics.depthDelta = { sentiment: 'neutral', description: 'Gagal menganalisis data', formatted: '--' };
  }

  // 2. Coinbase Premium
  try {
    const inner = cbPremiumCache?.data?.[0] || cbPremiumCache;
    const rateSeries = inner?.series?.find(s => s.name?.includes('Rate') || s.name?.includes('Index') || s.name === 'Premium Rate');
    const latestPremium = rateSeries?.data?.length ? parseFloat(rateSeries.data[rateSeries.data.length - 1]) : null;
    if (latestPremium !== null && !isNaN(latestPremium)) {
      const sentiment = latestPremium > 0.02 ? 'bullish' : (latestPremium < -0.02 ? 'bearish' : 'neutral');
      metrics.coinbasePremium = {
        value: latestPremium,
        formatted: (latestPremium > 0 ? '+' : '') + latestPremium.toFixed(4) + '%',
        sentiment: sentiment,
        description: sentiment === 'bullish' ? 'Institusi AS agresif membeli' : (sentiment === 'bearish' ? 'Institusi AS agresif menjual' : 'Tekanan beli/jual institusi seimbang')
      };
      if (sentiment === 'bullish') score += 1;
      else if (sentiment === 'bearish') score -= 1;
    } else {
      metrics.coinbasePremium = { sentiment: 'neutral', description: 'Data tidak tersedia', formatted: '--' };
    }
  } catch (e) {
    metrics.coinbasePremium = { sentiment: 'neutral', description: 'Gagal menganalisis data', formatted: '--' };
  }

  // 3. Whale Orders
  try {
    const orders = Array.isArray(whaleOrdersCache) ? whaleOrdersCache : (whaleOrdersCache?.data || []);
    if (orders.length > 0) {
      const buyOrders = orders.filter(o => o.side === 'buy');
      const sellOrders = orders.filter(o => o.side === 'sell');
      const totalBuyVal = buyOrders.reduce((sum, o) => sum + (o.valueUsd || 0), 0);
      const totalSellVal = sellOrders.reduce((sum, o) => sum + (o.valueUsd || 0), 0);
      
      const sortedBuys = [...buyOrders].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);
      const sortedSells = [...sellOrders].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);
      
      // Separate Spot (S) and Perpetual Futures (P)
      const spotBuys = buyOrders.filter(o => o.marketType === 'S');
      const spotSells = sellOrders.filter(o => o.marketType === 'S');
      const futuresBuys = buyOrders.filter(o => o.marketType === 'P');
      const futuresSells = sellOrders.filter(o => o.marketType === 'P');

      const sortedSpotBuys = [...spotBuys].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);
      const sortedSpotSells = [...spotSells].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);
      const sortedFuturesBuys = [...futuresBuys].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);
      const sortedFuturesSells = [...futuresSells].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);

      const formatVal = (v) => `$${(v / 1e6).toFixed(2)}M`;

      const isBullish = totalBuyVal > totalSellVal;
      metrics.whaleOrders = {
        buyCount: buyOrders.length,
        sellCount: sellOrders.length,
        buyVolume: totalBuyVal,
        sellVolume: totalSellVal,
        formatted: `Buy: $${(totalBuyVal / 1e6).toFixed(1)}M | Sell: $${(totalSellVal / 1e6).toFixed(1)}M`,
        sentiment: isBullish ? 'bullish' : 'bearish',
        description: isBullish ? `Whale dominasi Buy (+$${((totalBuyVal - totalSellVal)/1e6).toFixed(1)}M)` : `Whale dominasi Sell (+$${((totalSellVal - totalBuyVal)/1e6).toFixed(1)}M)`,
        top3Buy: sortedBuys.map(o => ({
          price: o.price,
          valueUsd: o.valueUsd,
          valueUsdFormatted: formatVal(o.valueUsd),
          exchange: o.exchange,
          marketType: o.marketType
        })),
        top3Sell: sortedSells.map(o => ({
          price: o.price,
          valueUsd: o.valueUsd,
          valueUsdFormatted: formatVal(o.valueUsd),
          exchange: o.exchange,
          marketType: o.marketType
        })),
        top3BuySpot: sortedSpotBuys.map(o => ({
          price: o.price,
          valueUsd: o.valueUsd,
          valueUsdFormatted: formatVal(o.valueUsd),
          exchange: o.exchange
        })),
        top3SellSpot: sortedSpotSells.map(o => ({
          price: o.price,
          valueUsd: o.valueUsd,
          valueUsdFormatted: formatVal(o.valueUsd),
          exchange: o.exchange
        })),
        top3BuyFutures: sortedFuturesBuys.map(o => ({
          price: o.price,
          valueUsd: o.valueUsd,
          valueUsdFormatted: formatVal(o.valueUsd),
          exchange: o.exchange
        })),
        top3SellFutures: sortedFuturesSells.map(o => ({
          price: o.price,
          valueUsd: o.valueUsd,
          valueUsdFormatted: formatVal(o.valueUsd),
          exchange: o.exchange
        }))
      };
      score += isBullish ? 1 : -1;
    } else {
      metrics.whaleOrders = { sentiment: 'neutral', description: 'Tidak ada order aktif terdeteksi', formatted: '--' };
    }
  } catch (e) {
    metrics.whaleOrders = { sentiment: 'neutral', description: 'Gagal menganalisis data', formatted: '--' };
  }

  // 4. Whale vs Retail
  try {
    const inner = whaleRetailDeltaCache?.data?.[0] || whaleRetailDeltaCache;
    const wrSeries = inner?.series?.find(s => s.name?.includes('Delta') || s.name === 'Whale vs Retail Delta');
    const latestWRDelta = wrSeries?.data?.length ? parseFloat(wrSeries.data[wrSeries.data.length - 1]) : null;
    if (latestWRDelta !== null && !isNaN(latestWRDelta)) {
      const isBullish = latestWRDelta > 0;
      metrics.whaleRetail = {
        value: latestWRDelta,
        formatted: (latestWRDelta > 0 ? '+' : '') + latestWRDelta.toFixed(3),
        sentiment: isBullish ? 'bullish' : 'bearish',
        description: isBullish ? 'Whale posisi Long, Retail posisi Short' : 'Whale posisi Short, Retail posisi Long'
      };
      score += isBullish ? 1 : -1;
    } else {
      metrics.whaleRetail = { sentiment: 'neutral', description: 'Data tidak tersedia', formatted: '--' };
    }
  } catch (e) {
    metrics.whaleRetail = { sentiment: 'neutral', description: 'Gagal menganalisis data', formatted: '--' };
  }

  // 5. Top Trader L/S
  try {
    const inner = topTraderLsCache?.data || topTraderLsCache;
    const rows = inner?.rows || [];
    
    // Binance U (Accounts) is index 8, OKX (Accounts) is index 13
    const ratios = [];
    rows.forEach(row => {
      [8, 13].forEach(idx => {
        const val = row[idx];
        if (val && val.trim() !== '' && val.includes('%')) {
          const longVal = parseFloat(val);
          if (!isNaN(longVal)) {
            const shortVal = 100 - longVal;
            if (shortVal > 0) ratios.push(longVal / shortVal);
          }
        }
      });
    });

    if (ratios.length > 0) {
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const sentiment = avgRatio > 1.05 ? 'bullish' : (avgRatio < 0.95 ? 'bearish' : 'neutral');
      metrics.topTraderLs = {
        value: avgRatio,
        formatted: avgRatio.toFixed(2),
        sentiment: sentiment,
        description: sentiment === 'bullish' ? 'Top trader cenderung Long' : (sentiment === 'bearish' ? 'Top trader cenderung Short' : 'Sentimen top trader seimbang')
      };
      if (sentiment === 'bullish') score += 1;
      else if (sentiment === 'bearish') score -= 1;
    } else {
      metrics.topTraderLs = { sentiment: 'neutral', description: 'Data tidak tersedia', formatted: '--' };
    }
  } catch (e) {
    metrics.topTraderLs = { sentiment: 'neutral', description: 'Gagal menganalisis data', formatted: '--' };
  }

  // 6. Combined Depth & Top Walls
  try {
    const bids = orderBookDataCache?.bids || orderBookDataCache?.data?.bids || [];
    const asks = orderBookDataCache?.asks || orderBookDataCache?.data?.asks || [];
    if (bids.length > 0 && asks.length > 0) {
      const sortedBids = [...bids].sort((a, b) => b.price - a.price);
      const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
      const midPrice = (sortedBids[0].price + sortedAsks[0].price) / 2;

      const rangeLimit = 0.02;
      const bidRangeLimit = midPrice * (1 - rangeLimit);
      const askRangeLimit = midPrice * (1 + rangeLimit);

      const bidsInRange = sortedBids.filter(b => b.price >= bidRangeLimit);
      const asksInRange = sortedAsks.filter(a => a.price <= askRangeLimit);

      const totalBidsQty = bidsInRange.reduce((sum, b) => sum + b.quantity, 0);
      const totalAsksQty = asksInRange.reduce((sum, a) => sum + a.quantity, 0);

      const imbalanceRatio = totalAsksQty > 0 ? (totalBidsQty / totalAsksQty) : 1.0;
      const sentiment = imbalanceRatio > 1.05 ? 'bullish' : (imbalanceRatio < 0.95 ? 'bearish' : 'neutral');
      
      metrics.combinedDepth = {
        value: imbalanceRatio,
        formatted: imbalanceRatio.toFixed(2),
        sentiment: sentiment,
        description: sentiment === 'bullish' ? `Bid mendominasi (${imbalanceRatio.toFixed(2)}x)` : (sentiment === 'bearish' ? `Ask mendominasi (${imbalanceRatio.toFixed(2)}x)` : 'Tekanan bid/ask seimbang')
      };

      // Get the top 3 highest volume walls (permintaan tertinggi)
      const topBids = [...bids]
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 3)
        .map(b => ({ price: b.price, quantity: b.quantity }));

      const topAsks = [...asks]
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 3)
        .map(a => ({ price: a.price, quantity: a.quantity }));

      metrics.topWalls = {
        bids: topBids,
        asks: topAsks
      };
      
      if (sentiment === 'bullish') score += 1;
      else if (sentiment === 'bearish') score -= 1;
    } else {
      metrics.combinedDepth = { sentiment: 'neutral', description: 'Data tidak tersedia', formatted: '--' };
      metrics.topWalls = { bids: [], asks: [] };
    }
  } catch (e) {
    metrics.combinedDepth = { sentiment: 'neutral', description: 'Gagal menganalisis data', formatted: '--' };
    metrics.topWalls = { bids: [], asks: [] };
  }

  // Sentiment Verdict calculation
  let verdict = 'NEUTRAL';
  if (score >= 3) verdict = 'STRONG BULLISH';
  else if (score >= 1) verdict = 'BULLISH';
  else if (score <= -3) verdict = 'STRONG BEARISH';
  else if (score <= -1) verdict = 'BEARISH';

  // Dynamic explanation generation
  let explanation = `Sentimen pasar keseluruhan saat ini dinilai **${verdict}** berdasarkan analisis 6 indikator utama CoinGlass. `;
  
  const bulletPoints = [];
  if (metrics.depthDelta?.sentiment !== 'neutral') {
    bulletPoints.push(`Orderbook Depth Delta menunjukkan dominasi ${metrics.depthDelta.sentiment === 'bullish' ? '<b>Dinding Beli (Bid)</b>' : '<b>Dinding Jual (Ask)</b>'} (${metrics.depthDelta.formatted})`);
  }
  if (metrics.coinbasePremium?.sentiment !== 'neutral') {
    bulletPoints.push(`Coinbase Premium Index berada di level ${metrics.coinbasePremium.formatted} (${metrics.coinbasePremium.sentiment.toUpperCase()})`);
  }
  if (metrics.whaleOrders?.sentiment !== 'neutral') {
    bulletPoints.push(`Peta order whale aktif bias ke arah ${metrics.whaleOrders.sentiment === 'bullish' ? '<b>BELI (Buy)</b>' : '<b>JUAL (Sell)</b>'} (${metrics.whaleOrders.formatted})`);
  }
  if (metrics.whaleRetail?.sentiment !== 'neutral') {
    bulletPoints.push(`Whale vs Retail Delta mengindikasikan ${metrics.whaleRetail.sentiment === 'bullish' ? '<b>Whale mendominasi posisi LONG</b> sedangkan retail cenderung Short' : '<b>Whale mendominasi posisi SHORT</b> sedangkan retail cenderung Long'} (${metrics.whaleRetail.formatted})`);
  }
  if (metrics.topTraderLs?.sentiment !== 'neutral') {
    bulletPoints.push(`Rata-rata rasio Long/Short Top Trader di exchange Binance/OKX berada di angka **${metrics.topTraderLs.formatted}**`);
  }
  if (metrics.combinedDepth?.sentiment !== 'neutral') {
    bulletPoints.push(`Orderbook Combined Depth (2% Range) menunjukkan bias ${metrics.combinedDepth.sentiment === 'bullish' ? '<b>BELI (Bid)</b>' : '<b>JUAL (Ask)</b>'} dengan rasio **${metrics.combinedDepth.formatted}**`);
  }

  if (bulletPoints.length > 0) {
    explanation += 'Berikut adalah ringkasan indikator saat ini:\n<ul style="margin-top: 5px; margin-bottom: 8px; padding-left: 20px;">' + bulletPoints.map(bp => `<li style="margin-bottom: 4px;">${bp}</li>`).join('') + '</ul>';
  } else {
    explanation += 'Tidak ada data cache CoinGlass yang cukup untuk menyusun ringkasan indikator saat ini. Silakan jalankan sinkronisasi data.';
  }

  // Inject top 3 whale orders summary
  if (metrics.whaleOrders && metrics.whaleOrders.top3Buy && metrics.whaleOrders.top3Sell) {
    const buyListStr = metrics.whaleOrders.top3Buy.length > 0 
      ? metrics.whaleOrders.top3Buy.map(o => `<b>$${o.price.toLocaleString()}</b> (${o.valueUsdFormatted} di ${o.exchange})`).join(', ')
      : 'Tidak ada order';
    
    const sellListStr = metrics.whaleOrders.top3Sell.length > 0 
      ? metrics.whaleOrders.top3Sell.map(o => `<b>$${o.price.toLocaleString()}</b> (${o.valueUsdFormatted} di ${o.exchange})`).join(', ')
      : 'Tidak ada order';

    explanation += `<div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255, 255, 255, 0.15); font-size: 12px; line-height: 1.5;">`;
    explanation += `📢 <b>Top 3 Whale Buy (Bid) Orders:</b> ${buyListStr}<br/>`;
    explanation += `📢 <b>Top 3 Whale Sell (Ask) Orders:</b> ${sellListStr}`;
    explanation += `</div>`;
  }

  res.json({
    success: true,
    verdict,
    score,
    explanation,
    metrics: {
      ...metrics,
      ...botMetrics
    },
    botPhaseState,
    status: {
      lastPrice: botMetrics.openInterest && botMetrics.openInterestBtc ? (botMetrics.openInterest / botMetrics.openInterestBtc) : 60000
    },
    timestamp: new Date().toISOString()
  });
});

// REST API for fetching HeatMap data (with cache)
app.get('/api/heatmap-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (heatmapDataCache && !forceRefresh && lastHeatmapFetchTime && (Date.now() - lastHeatmapFetchTime < 180000)) {
    return res.json({ success: true, source: 'cache', data: heatmapDataCache });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: heatmapDataCache || null });
  }

  if (isHeatmapScrapingBusy) {
    if (heatmapDataCache) return res.json({ success: true, source: "stale-cache", data: heatmapDataCache });
    return res.status(409).json({ success: false, error: "A scrape is already in progress, please wait." });
  }

  isHeatmapScrapingBusy = true;
  try {
    console.log('Starting CoinGlass Heatmap scrape...');
    const result = await runWithCdpLock(() => scrapeHeatMap(forceRefresh));
    heatmapDataCache = cleanSweptLevels(result);
    lastHeatmapFetchTime = Date.now();
    saveCacheToDisk('heatmap24h_cache.json', heatmapDataCache);
    res.json({ success: true, source: 'live', data: heatmapDataCache });
  } catch (error) {
    console.error('Heatmap scrape error:', error.message);
    if (heatmapDataCache) {
      console.log('Falling back to cached heatmap data due to scrape failure');
      return res.json({ success: true, source: 'cache-fallback', data: heatmapDataCache });
    }
    res.status(500).json({ success: false, error: error.message });
  } finally {
    isHeatmapScrapingBusy = false;
  }
});

// POST endpoint for updating HeatMap data from bridge (local -> VPS)
app.post('/api/heatmap-data/update', (req, res) => {
  const { data, period } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });

  const cleanedData = cleanSweptLevels(data);

  if (period === '3d') {
    heatmap3DCache = { data: cleanedData, timestamp: new Date().toISOString(), period: '3d' };
    lastHeatmap3DFetchTime = Date.now();
    console.log('[Bridge API] Received 3D Heatmap update from local client.');
    try {
      const hd3 = cleanedData.data || cleanedData;
      if (hd3) {
        if (!hd3.series) hd3.series = [];
        if (!hd3.series.some(s => s.type === 'candlestick' || s.type === 'candlestick_raw')) {
          const mainData = heatmapDataCache?.data?.data || heatmapDataCache?.data || heatmapDataCache;
          const cs2d = mainData?.series?.find(s => s.type === 'candlestick' || s.type === 'candlestick_raw');
          if (cs2d) hd3.series.push(cs2d);
        }
      }
      sweepPrediction3DCache = predictSweepTargets(hd3, botMetrics);
      console.log('[Bridge API] Updated 3D Sweep Prediction from received 3D data.');
    } catch (err) {
      console.error('[Bridge API] Failed to compute 3D Sweep Prediction:', err.message);
    }
    saveCacheToDisk('heatmap3d_cache.json', heatmap3DCache);
  } else {
    heatmapDataCache = { data: cleanedData, timestamp: new Date().toISOString() };
    lastHeatmapFetchTime = Date.now();
    console.log('[Bridge API] Received 24h Heatmap update from local client.');
    saveCacheToDisk('heatmap24h_cache.json', heatmapDataCache);
  }
  res.json({ success: true });
});

app.post('/api/orderbook-data/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  orderBookDataCache = data;
  lastOrderBookFetchTime = Date.now();
  saveCacheToDisk('orderbook_cache.json', orderBookDataCache);
  console.log('[Push API] Received Combined Order Book update from client.');
  res.json({ success: true });
});

app.post('/api/depth-delta/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  depthDeltaCache = data;
  lastDepthDeltaFetchTime = Date.now();
  saveCacheToDisk('depth_delta_cache.json', depthDeltaCache);
  console.log('[Push API] Received Depth Delta update from client.');
  res.json({ success: true });
});

app.post('/api/coinbase-premium/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  cbPremiumCache = data;
  lastCbPremiumFetchTime = Date.now();
  saveCacheToDisk('cb_premium_cache.json', cbPremiumCache);
  console.log('[Push API] Received Coinbase Premium update from client.');
  res.json({ success: true });
});

app.post('/api/whale-orders/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  whaleOrdersCache = data;
  lastWhaleOrdersFetchTime = Date.now();
  saveCacheToDisk('whale_orders_cache.json', whaleOrdersCache);
  console.log('[Push API] Received Whale Orders update from client.');
  res.json({ success: true });
});

app.post('/api/whale-retail-delta/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  whaleRetailDeltaCache = data;
  lastWhaleRetailDeltaFetchTime = Date.now();
  saveCacheToDisk('whale_retail_delta_cache.json', whaleRetailDeltaCache);
  console.log('[Push API] Received Whale vs Retail Delta update from client.');
  res.json({ success: true });
});

app.post('/api/top-trader-ls/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  topTraderLsCache = data;
  lastTopTraderLsFetchTime = Date.now();
  saveCacheToDisk('top_trader_ls_cache.json', topTraderLsCache);
  console.log('[Push API] Received Top Trader Long/Short update from client.');
  res.json({ success: true });
});

app.post('/api/etf-data/update', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: 'No data provided' });
  etfDataCache = data;
  lastFetchTime = Date.now();
  saveCacheToDisk('etf_cache.json', etfDataCache);
  console.log('[Push API] Received ETF Flow update from client.');
  res.json({ success: true });
});

app.post('/api/bot-phase/update', (req, res) => {
  const { botPhaseState: newPhaseState, botMetrics: newMetrics, sweepHistory: newHistory } = req.body;
  if (newPhaseState) {
    botPhaseState = newPhaseState;
  }
  if (newMetrics) {
    botMetrics = { ...botMetrics, ...newMetrics };
  }
  if (newHistory && Array.isArray(newHistory)) {
    sweepHistory = newHistory;
    saveSweepHistory(sweepHistory);
  }
  console.log(`[Sync API] Successfully synchronized bot phase: ${botPhaseState?.phase}`);
  res.json({ success: true });
});

app.post('/api/trades/sync', (req, res) => {
  const { trades } = req.body;
  if (!trades || !Array.isArray(trades)) {
    return res.status(400).json({ success: false, error: 'Invalid trades payload' });
  }
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
    console.log(`[Sync API] Successfully synchronized ${trades.length} trades from local client.`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Sync API] Failed to write trades file:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/jda-trades/sync', (req, res) => {
  const { trades } = req.body;
  if (!trades || !Array.isArray(trades)) {
    return res.status(400).json({ success: false, error: 'Invalid JDA trades payload' });
  }
  try {
    fs.writeFileSync(JDA_TRADES_FILE, JSON.stringify(trades, null, 2));
    console.log(`[Sync API] Successfully synchronized ${trades.length} JDA trades from local client.`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Sync API] Failed to write jda trades file:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST API for fetching ETF data (with cache)
app.get('/api/etf-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  let btcPrice = 65000; // default fallback
  try {
    const tickerResp = await fetchBinance('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const tickerData = await tickerResp.json();
    btcPrice = parseFloat(tickerData.price) || 65000;
  } catch (e) {
    console.error('Failed to fetch BTC price from Binance, using default fallback:', e.message);
  }

  // Return cached data if available and fresh (less than 1 hour old)
  if (etfDataCache && !forceRefresh && lastFetchTime && (Date.now() - lastFetchTime < 3600000)) {
    return res.json({ success: true, source: 'cache', data: etfDataCache, btcPrice });
  }

  // Bypass if scraper is disabled
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.json({ success: true, source: 'cache', data: etfDataCache || null, btcPrice });
  }

  if (isEtfScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isEtfScrapingBusy = true;
  try {
    console.log('Starting CoinGlass scrape...');
    const result = await runWithCdpLock(() => scrapeCoinGlass('/etf/bitcoin', forceRefresh));
    etfDataCache = result;
    lastFetchTime = Date.now();
    saveCacheToDisk('etf_cache.json', etfDataCache);

    // Send ETF alerts to Telegram (only when alert state changes)
    const etfAlertInfo = buildEtfAlerts(result, btcPrice);
    if (etfAlertInfo && etfAlertInfo.stateKey !== lastEtfAlertState) {
      lastEtfAlertState = etfAlertInfo.stateKey;
      if (etfAlertInfo.stateKey !== 'stable') {
        const header = `📊 <b>ETF Monitor Update</b>\n${'─'.repeat(20)}\n`;
        sendTelegramAlert(header + etfAlertInfo.alerts.join('\n\n'));
        console.log(`[ETF Alert] State changed to: ${etfAlertInfo.stateKey}`);
      } else {
        console.log(`[ETF Alert] State changed to: stable (alert suppressed to avoid spam)`);
      }
    }

    res.json({ success: true, source: 'live', data: result, btcPrice });
  } catch (error) {
    console.warn(`[ETF Scrape Error] Scrape failed: ${error.message}. Falling back to cached data.`);
    if (etfDataCache) {
      return res.json({ success: true, source: 'cache', data: etfDataCache, btcPrice });
    }
    sendTelegramAlert(`⚠️ <b>ETF Scrape Error</b>\n${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    isEtfScrapingBusy = false;
  }
});

// ─── JSON Database Persistence ──────────────────────────────
const TRADES_FILE = path.join(__dirname, 'trades.json');
const JDA_TRADES_FILE = path.join(__dirname, 'jda_trades.json');

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
    pushToVps('/api/trades/sync', { trades }).catch(console.error);
  } catch (e) {
    console.error('Error saving trades file:', e);
  }
}

function loadJdaTrades() {
  if (!fs.existsSync(JDA_TRADES_FILE)) {
    fs.writeFileSync(JDA_TRADES_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const data = fs.readFileSync(JDA_TRADES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading jda trades file:', e);
    return [];
  }
}

function saveJdaTrades(trades) {
  try {
    fs.writeFileSync(JDA_TRADES_FILE, JSON.stringify(trades, null, 2));
    pushToVps('/api/jda-trades/sync', { trades }).catch(console.error);
  } catch (e) {
    console.error('Error saving jda trades file:', e);
  }
}function cleanSweptLevels(heatmapData) {
  if (!heatmapData) return heatmapData;
  let mainData = heatmapData;
  let isWrapped = false;
  if (heatmapData.data && heatmapData.data.series) {
    mainData = heatmapData.data;
    isWrapped = true;
  }
  if (!mainData.series || !mainData.xAxis || !mainData.yAxis) {
    return heatmapData;
  }

  const candleSeries = mainData.series.find(s => s.type === 'candlestick');
  const heatmapSeries = mainData.series.find(s => s.type === 'heatmap');
  
  if (!candleSeries || !heatmapSeries || !Array.isArray(candleSeries.data) || !Array.isArray(heatmapSeries.data)) {
    return heatmapData;
  }

  const yAxisData = mainData.yAxis || [];
  const candles = candleSeries.data;
  const originalHeatmapData = heatmapSeries.data;

  // Group points by yIdx
  const pointsByY = new Map();
  originalHeatmapData.forEach(item => {
    const v = Array.isArray(item) ? item : (item.value || []);
    const yIdx = parseInt(v[1], 10);
    const xIdx = parseInt(v[0], 10);
    const val = parseFloat(v[2] || 0);
    
    if (!pointsByY.has(yIdx)) {
      pointsByY.set(yIdx, []);
    }
    pointsByY.get(yIdx).push({ xIdx, yIdx, val, original: item });
  });

  const cleanedHeatmapData = [];

  pointsByY.forEach((pts, yIdx) => {
    const price = parseFloat(yAxisData[yIdx]);
    if (isNaN(price)) {
      pts.forEach(p => cleanedHeatmapData.push(p.original));
      return;
    }

    // Sort points chronologically
    pts.sort((a, b) => a.xIdx - b.xIdx);

    let swept = false;
    let lastXIdx = -1;

    pts.forEach(p => {
      const xIdx = p.xIdx;

      // Check if there was a gap since the last point at this yIdx.
      // A gap of more than 1 index resets the swept state because it
      // indicates a new liquidation pool formed after the old one was cleared.
      if (lastXIdx !== -1 && xIdx - lastXIdx > 1) {
        swept = false;
      }
      lastXIdx = xIdx;

      // Check if the candle at xIdx sweeps this price level
      if (!swept && xIdx < candles.length) {
        const c = candles[xIdx];
        if (c && c.length >= 4) {
          const low = parseFloat(c[2]);
          const high = parseFloat(c[3]);
          if (!isNaN(low) && !isNaN(high) && price >= low && price <= high) {
            swept = true;
          }
        }
      }

      if (!swept) {
        cleanedHeatmapData.push(p.original);
      }
    });
  });

  // Reassign the cleaned data back to the series
  heatmapSeries.data = cleanedHeatmapData;

  return heatmapData;
}

function loadSettings() {
  const defaultSettings = {
    capital: 1000,
    riskPercent: 1.0,
    minRR: 2.0,
    minReversalProbability: 50,
    minConfirmCandles: 0,
    atrMultiplier: 2.0,
    minSLPercent: 0.5,
    maxActive: 1,
    minDist: 0.2,
    maxDist: 8.0,
    autoTradeEnabled: true,
    sweepConfirmCandles: 5,
    minPoolVolumeRatio: 0.25,
    cooldownMinutes: 60,
    maxTPPercent: 1.5,
    autoCutDistanceThreshold: 1.0,
    breakevenEnabled: true,
    telegramBotToken: '',
    telegramChatId: '',
    authUsername: 'admin',
    authPassword: 'admin123',
    vpsUrl: '',
    vpsUsername: '',
    vpsPassword: '',
    disableScraper: false,
    disableTelegram: false
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

async function pushToVps(apiPath, payload) {
  const settings = loadSettings();
  if (!settings.vpsUrl) return;

  const url = `${settings.vpsUrl}${apiPath}`;
  const username = settings.vpsUsername || settings.authUsername || 'admin';
  const password = settings.vpsPassword || settings.authPassword || 'admin123';
  const authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

  try {
    console.log(`[VPS Push] Pushing data to ${url}...`);
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      console.error(`[VPS Push] Failed to push to ${url}. Status: ${response.status}`);
      return;
    }
    const json = await response.json();
    if (json.success) {
      console.log(`[VPS Push] Successfully pushed to ${url}`);
    } else {
      console.error(`[VPS Push] VPS API returned error:`, json.error);
    }
  } catch (err) {
    console.error(`[VPS Push] Error pushing to ${url}:`, err.message);
  }
}

// ─── Sweep History REST API Endpoints ─────────────────────────
app.get('/api/sweep-history', (req, res) => {
  res.json(sweepHistory);
});

app.post('/api/sweep-history/clear', (req, res) => {
  sweepHistory = [];
  saveSweepHistory(sweepHistory);
  const settings = loadSettings();
  if (!settings.disableScraper && process.env.DISABLE_SCRAPER !== 'true') {
    pushToVps('/api/sweep-history/clear', {}).catch(console.error);
  }
  res.json({ success: true });
});

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

  const id = trade.id || 'T' + Date.now();
  let timestamp = trade.timestamp;
  if (!timestamp) {
    const parsedTs = parseInt(id.replace('T', ''), 10);
    timestamp = isNaN(parsedTs) ? Date.now() : parsedTs;
  }

  const trades = loadTrades();
  trades.push({
    id,
    timestamp,
    time: trade.time || new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction: trade.direction,
    tf: trade.tf || '15m',
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
    trade.closeTimestamp = Date.now();
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
      `PnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</code> (${trade.pnl >= 0 ? '+' : ''}Rp ${(trade.pnl * 16300).toFixed(0)})\n` +
      `Note: ${trade.note}`
    );
    return;
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

// ─── JDA Trade Log REST API Endpoints ─────────────────────────
app.get('/api/jda-trades', (req, res) => {
  const trades = loadJdaTrades();
  res.json({ success: true, data: trades });
});

app.post('/api/jda-trades/add', (req, res) => {
  const trade = req.body;
  if (!trade || !trade.direction || !trade.entry || !trade.tp || !trade.sl || !trade.capital || !trade.riskPercent) {
    return res.status(400).json({ success: false, error: 'Incomplete trade data' });
  }

  const id = trade.id || 'T' + Date.now();
  let timestamp = trade.timestamp;
  if (!timestamp) {
    const parsedTs = parseInt(id.replace('T', ''), 10);
    timestamp = isNaN(parsedTs) ? Date.now() : parsedTs;
  }

  const trades = loadJdaTrades();
  trades.push({
    id,
    timestamp,
    time: trade.time || new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction: trade.direction,
    tf: trade.tf || '15m',
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

  saveJdaTrades(trades);
  res.json({ success: true });

  // Send Telegram Alert for new manual trade
  sendTelegramAlert(
    `🔔 <b>JDA MTF Trade Logged (Manual)</b>\n` +
    `Type: <b>${trade.direction}</b> (${trade.tf || '15m'})\n` +
    `Entry: <code>$${parseFloat(trade.entry).toFixed(2)}</code>\n` +
    `TP: <code>$${parseFloat(trade.tp).toFixed(2)}</code>\n` +
    `SL: <code>$${parseFloat(trade.sl).toFixed(2)}</code>\n` +
    `Size: <code>$${parseFloat(trade.positionSizeUsd).toFixed(0)}</code>\n` +
    `Note: ${trade.note || 'Manual Entry'}`
  );
});

app.post('/api/jda-trades/cut', (req, res) => {
  const { id, closePrice } = req.body;
  if (!id || !closePrice) {
    return res.status(400).json({ success: false, error: 'Missing trade ID or close price' });
  }

  const trades = loadJdaTrades();
  const trade = trades.find(t => t.id === id);
  if (trade && trade.status === 'ACTIVE') {
    trade.status = 'CUT_LOSS';
    const diff = trade.direction === 'LONG' ? (closePrice - trade.entry) : (trade.entry - closePrice);
    trade.pnl = parseFloat((trade.positionSizeUsd * (diff / trade.entry)).toFixed(2));
    trade.closePrice = parseFloat(closePrice);
    trade.closeTimestamp = Date.now();
    trade.note = trade.note ? `${trade.note} (Manual Cut)` : 'Manual Cut';
    saveJdaTrades(trades);
    res.json({ success: true });

    // Send Telegram Alert for manual cut
    sendTelegramAlert(
      `⚠️ <b>JDA MTF Trade Closed (Manual Cut)</b>\n` +
      `Type: <b>${trade.direction}</b> (${trade.tf || '15m'})\n` +
      `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
      `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
      `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
      `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
      `Close: <code>$${parseFloat(closePrice).toFixed(2)}</code>\n` +
      `PnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</code> (${trade.pnl >= 0 ? '+' : ''}Rp ${(trade.pnl * 16300).toFixed(0)})\n` +
      `Note: ${trade.note}`
    );
    return;
  }
  res.status(404).json({ success: false, error: 'Active JDA trade not found' });
});

app.post('/api/jda-trades/delete', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing trade ID' });
  }

  let trades = loadJdaTrades();
  trades = trades.filter(t => t.id !== id);
  saveJdaTrades(trades);
  res.json({ success: true });
});

app.post('/api/jda-trades/clear', (req, res) => {
  saveJdaTrades([]);
  res.json({ success: true });
});

// Settings REST API Endpoints
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({ success: true, data: settings });
});

app.post('/api/settings', (req, res) => {
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    return res.status(403).json({ success: false, error: 'Settings are view-only/disabled on the VPS instance.' });
  }
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
    ...current,
    capital: parseNum(newSettings.capital, current.capital),
    riskPercent: parseNum(newSettings.riskPercent, current.riskPercent),
    minRR: parseNum(newSettings.minRR, current.minRR),
    minReversalProbability: parseIntNum(newSettings.minReversalProbability, current.minReversalProbability || 55),
    minConfirmCandles: parseIntNum(newSettings.minConfirmCandles, current.minConfirmCandles !== undefined ? current.minConfirmCandles : 0),
    atrMultiplier: parseNum(newSettings.atrMultiplier, current.atrMultiplier !== undefined ? current.atrMultiplier : 2.0),
    minSLPercent: parseNum(newSettings.minSLPercent, current.minSLPercent !== undefined ? current.minSLPercent : 0.5),
    maxActive: parseIntNum(newSettings.maxActive, current.maxActive),
    minDist: parseNum(newSettings.minDist, current.minDist),
    maxDist: parseNum(newSettings.maxDist, current.maxDist),
    autoTradeEnabled: newSettings.autoTradeEnabled !== undefined ? !!newSettings.autoTradeEnabled : current.autoTradeEnabled,
    sweepConfirmCandles: parseIntNum(newSettings.sweepConfirmCandles, current.sweepConfirmCandles),
    minPoolVolumeRatio: parseNum(newSettings.minPoolVolumeRatio, current.minPoolVolumeRatio),
    cooldownMinutes: parseIntNum(newSettings.cooldownMinutes, current.cooldownMinutes),
    maxTPPercent: parseNum(newSettings.maxTPPercent, current.maxTPPercent),
    autoCutDistanceThreshold: parseNum(newSettings.autoCutDistanceThreshold, current.autoCutDistanceThreshold),
    breakevenEnabled: newSettings.breakevenEnabled !== undefined ? !!newSettings.breakevenEnabled : current.breakevenEnabled,
    telegramBotToken: newSettings.telegramBotToken !== undefined ? String(newSettings.telegramBotToken).trim() : current.telegramBotToken,
    telegramChatId: newSettings.telegramChatId !== undefined ? String(newSettings.telegramChatId).trim() : current.telegramChatId,
    disableScraper: newSettings.disableScraper !== undefined ? !!newSettings.disableScraper : current.disableScraper,
    disableTelegram: newSettings.disableTelegram !== undefined ? !!newSettings.disableTelegram : current.disableTelegram,
    jdaAutoTradeEnabled: newSettings.jdaAutoTradeEnabled !== undefined ? !!newSettings.jdaAutoTradeEnabled : current.jdaAutoTradeEnabled,
    jdaMinConfidence: parseIntNum(newSettings.jdaMinConfidence, current.jdaMinConfidence || 60),
    jdaCapital: parseNum(newSettings.jdaCapital, current.jdaCapital || 1000),
    jdaRiskPercent: parseNum(newSettings.jdaRiskPercent, current.jdaRiskPercent || 1.0),
    jdaSlTpMethod: newSettings.jdaSlTpMethod !== undefined ? String(newSettings.jdaSlTpMethod).trim() : (current.jdaSlTpMethod || 'HEATMAP'),
    jdaAtrPeriod: parseIntNum(newSettings.jdaAtrPeriod, current.jdaAtrPeriod || 14),
    jdaAtrMultiplier: parseNum(newSettings.jdaAtrMultiplier, current.jdaAtrMultiplier || 2.0),
    jdaRiskRewardRatio: parseNum(newSettings.jdaRiskRewardRatio, current.jdaRiskRewardRatio || 2.0)
  };

  saveSettings(updated);
  if (updated.autoTradeEnabled !== current.autoTradeEnabled) {
    sendTelegramAlert(`⚙️ <b>LSR Auto-Trading Toggle</b>\n────────────────────\nAuto-Trading is now: <b>${updated.autoTradeEnabled ? 'ENABLED 🟢' : 'DISABLED 🔴'}</b>`);
  }
  if (updated.jdaAutoTradeEnabled !== current.jdaAutoTradeEnabled) {
    sendTelegramAlert(`⚙️ <b>JDA Auto-Trading Toggle</b>\n────────────────────\nAuto-Trading is now: <b>${updated.jdaAutoTradeEnabled ? 'ENABLED 🟢' : 'DISABLED 🔴'}</b>`);
  }
  res.json({ success: true, data: updated });
});

// Telegram Notification Helper
async function sendTelegramAlert(message) {
  const settings = loadSettings();
  if (settings.disableTelegram || process.env.DISABLE_TELEGRAM === 'true') {
    console.log('[Telegram Alert] Telegram alerts are disabled on this instance.');
    return;
  }

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

// TradingView Webhook Endpoint
app.post('/api/tradingview/webhook', (req, res) => {
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    console.warn('[TradingView Webhook] Webhook ignored. VPS is in view-only mode.');
    return res.status(403).json({ success: false, error: 'VPS is in view-only mode. Webhook alerts should be sent to your local app.' });
  }

  const data = req.body;
  console.log('[TradingView Webhook] Received payload:', JSON.stringify(data));

  if (!data || !data.action) {
    return res.status(400).json({ success: false, error: 'Missing action parameter' });
  }

  const trades = loadTrades();

  if (data.action === 'buy' || data.action === 'sell') {
    const direction = data.direction || (data.action === 'buy' ? 'LONG' : 'SHORT');
    const entry = parseFloat(data.entry || 0);
    const tp = parseFloat(data.tp || 0);
    const sl = parseFloat(data.sl || 0);

    if (!entry || !tp || !sl) {
      return res.status(400).json({ success: false, error: 'Missing entry, tp, or sl' });
    }

    const activeTrades = trades.filter(t => t.status === 'ACTIVE' && !(t.id && t.id.startsWith('T_BT_')) && !(t.note && t.note.toLowerCase().includes('backtest')));
    if (activeTrades.length >= settings.maxActive) {
      console.log('[TradingView Webhook] Max active trades reached, skipping entry.');
      return res.status(400).json({ success: false, error: 'Max active trades reached' });
    }

    let slDistance = Math.abs(((entry - sl) / entry) * 100);
    const minSLPercent = Math.max(0.5, settings.minSLPercent !== undefined ? parseFloat(settings.minSLPercent) : 0.5);
    const slFloorFraction = minSLPercent / 100;
    if (slDistance < minSLPercent) {
      slDistance = minSLPercent;
      sl = direction === 'LONG' ? (entry * (1 - slFloorFraction)) : (entry * (1 + slFloorFraction));
      console.log(`[Webhook] Stop Loss was too tight (${slDistance.toFixed(3)}%). Clamped to ${minSLPercent}%: $${sl.toFixed(2)}`);
    }

    const tpDistance = Math.abs(((tp - entry) / entry) * 100);
    const rr = (tpDistance / slDistance).toFixed(1);

    const riskUsd = settings.capital * (settings.riskPercent / 100);
    const positionSizeUsd = riskUsd / (slDistance / 100);

    const timestamp = Date.now();
    const newTrade = {
      id: 'T' + timestamp,
      timestamp,
      time: new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      direction,
      tf: data.tf || data.timeframe || '15m',
      entry,
      tp,
      sl: parseFloat(sl.toFixed(2)),
      capital: settings.capital,
      riskPercent: settings.riskPercent,
      riskUsd,
      positionSizeUsd,
      tpDistance,
      slDistance,
      status: 'ACTIVE',
      pnl: 0,
      note: data.note || 'TradingView Alert'
    };

    trades.push(newTrade);
    saveTrades(trades);
    res.json({ success: true, data: newTrade });

    sendTelegramAlert(
      `🔔 <b>New Trade Executed (TradingView Alert)</b>\n` +
      `Type: <b>${direction}</b>\n` +
      `Entry: <code>$${entry.toFixed(2)}</code>\n` +
      `TP: <code>$${tp.toFixed(2)}</code> (Risk R: 1:${rr})\n` +
      `SL: <code>$${sl.toFixed(2)}</code>\n` +
      `Size: <code>$${positionSizeUsd.toFixed(0)}</code> (Risk: $${riskUsd.toFixed(2)})\n` +
      `Note: ${newTrade.note}`
    );

  } else if (data.action === 'cut') {
    const direction = data.direction;
    const closePrice = parseFloat(data.close || 0);

    const trade = direction 
      ? trades.find(t => t.status === 'ACTIVE' && t.direction === direction)
      : trades.find(t => t.status === 'ACTIVE');

    if (trade) {
      trade.status = 'CUT_LOSS';
      const diff = trade.direction === 'LONG' ? (closePrice - trade.entry) : (trade.entry - closePrice);
      trade.pnl = parseFloat((trade.positionSizeUsd * (diff / trade.entry)).toFixed(2));
      trade.closePrice = closePrice || trade.entry;
      trade.closeTimestamp = Date.now();
      trade.note = trade.note ? `${trade.note} (${data.note || 'TradingView Exit'})` : (data.note || 'TradingView Exit');
      saveTrades(trades);
      res.json({ success: true, data: trade });

      sendTelegramAlert(
        `⚠️ <b>Trade Closed (TradingView Exit)</b>\n` +
        `Type: <b>${trade.direction}</b>\n` +
        `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
        `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
        `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
        `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
        `Close: <code>$${trade.closePrice.toFixed(2)}</code>\n` +
        `PnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</code> (${trade.pnl >= 0 ? '+' : ''}Rp ${(trade.pnl * 16300).toFixed(0)})\n` +
        `Note: ${trade.note}`
      );
    } else {
      res.status(404).json({ success: false, error: 'No active trade found to exit' });
    }
  } else {
    res.status(400).json({ success: false, error: 'Unknown action' });
  }
});

app.post('/api/jda-trades/webhook', (req, res) => {
  const settings = loadSettings();
  if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
    console.warn('[JDA Webhook] Webhook ignored. VPS is in view-only mode.');
    return res.status(403).json({ success: false, error: 'VPS is in view-only mode.' });
  }

  const data = req.body;
  console.log('[JDA Webhook] Received payload:', JSON.stringify(data));

  if (!data || !data.action) {
    return res.status(400).json({ success: false, error: 'Missing action parameter' });
  }

  const trades = loadJdaTrades();

  if (data.action === 'buy' || data.action === 'sell') {
    const direction = data.direction || (data.action === 'buy' ? 'LONG' : 'SHORT');
    let entry = parseFloat(data.entry || 0);
    let tp = parseFloat(data.tp || 0);
    let sl = parseFloat(data.sl || 0);

    if (!entry || !tp || !sl) {
      return res.status(400).json({ success: false, error: 'Missing entry, tp, or sl' });
    }

    const activeTrades = trades.filter(t => t.status === 'ACTIVE' && !(t.id && t.id.startsWith('T_BT_')) && !(t.note && t.note.toLowerCase().includes('backtest')));
    if (activeTrades.length >= settings.maxActive) {
      console.log('[JDA Webhook] Max active trades reached, skipping entry.');
      return res.status(400).json({ success: false, error: 'Max active trades reached' });
    }

    let slDistance = Math.abs(((entry - sl) / entry) * 100);
    const minSLPercent = Math.max(0.5, settings.minSLPercent !== undefined ? parseFloat(settings.minSLPercent) : 0.5);
    const slFloorFraction = minSLPercent / 100;
    if (slDistance < minSLPercent) {
      slDistance = minSLPercent;
      sl = direction === 'LONG' ? (entry * (1 - slFloorFraction)) : (entry * (1 + slFloorFraction));
      console.log(`[JDA Webhook] Stop Loss clamped to ${minSLPercent}%: $${sl.toFixed(2)}`);
    }

    const tpDistance = Math.abs(((tp - entry) / entry) * 100);
    const rr = (tpDistance / slDistance).toFixed(1);

    const riskUsd = settings.capital * (settings.riskPercent / 100);
    const positionSizeUsd = riskUsd / (slDistance / 100);

    const timestamp = Date.now();
    const newTrade = {
      id: 'T' + timestamp,
      timestamp,
      time: new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      direction,
      tf: data.tf || data.timeframe || '15m',
      entry,
      tp,
      sl: parseFloat(sl.toFixed(2)),
      capital: settings.capital,
      riskPercent: settings.riskPercent,
      riskUsd,
      positionSizeUsd,
      tpDistance,
      slDistance,
      status: 'ACTIVE',
      pnl: 0,
      note: data.note || 'JDA TradingView Alert'
    };

    trades.push(newTrade);
    saveJdaTrades(trades);
    res.json({ success: true, data: newTrade });

    sendTelegramAlert(
      `🔔 <b>New JDA MTF Trade (TradingView Alert)</b>\n` +
      `Type: <b>${direction}</b> (${newTrade.tf})\n` +
      `Entry: <code>$${entry.toFixed(2)}</code>\n` +
      `TP: <code>$${tp.toFixed(2)}</code> (Risk R: 1:${rr})\n` +
      `SL: <code>$${sl.toFixed(2)}</code>\n` +
      `Size: <code>$${positionSizeUsd.toFixed(0)}</code> (Risk: $${riskUsd.toFixed(2)})\n` +
      `Note: ${newTrade.note}`
    );

  } else if (data.action === 'cut') {
    const direction = data.direction;
    const closePrice = parseFloat(data.close || 0);

    const trade = direction 
      ? trades.find(t => t.status === 'ACTIVE' && t.direction === direction)
      : trades.find(t => t.status === 'ACTIVE');

    if (trade) {
      trade.status = 'CUT_LOSS';
      const diff = trade.direction === 'LONG' ? (closePrice - trade.entry) : (trade.entry - closePrice);
      trade.pnl = parseFloat((trade.positionSizeUsd * (diff / trade.entry)).toFixed(2));
      trade.closePrice = closePrice || trade.entry;
      trade.closeTimestamp = Date.now();
      trade.note = trade.note ? `${trade.note} (${data.note || 'JDA TradingView Exit'})` : (data.note || 'JDA TradingView Exit');
      saveJdaTrades(trades);
      res.json({ success: true, data: trade });

      sendTelegramAlert(
        `⚠️ <b>JDA MTF Trade Closed (TradingView Exit)</b>\n` +
        `Type: <b>${trade.direction}</b> (${trade.tf || '15m'})\n` +
        `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
        `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
        `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
        `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
        `Close: <code>$${trade.closePrice.toFixed(2)}</code>\n` +
        `PnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</code> (${trade.pnl >= 0 ? '+' : ''}Rp ${(trade.pnl * 16300).toFixed(0)})\n` +
        `Note: ${trade.note}`
      );
    } else {
      res.status(404).json({ success: false, error: 'No active JDA trade found to exit' });
    }
  } else {
    res.status(400).json({ success: false, error: 'Unknown action' });
  }
});

// ─── Binance Metric State & Fetchers ──────────────────────────
let botMetrics = {
  openInterest: 0,
  openInterestBtc: 0,
  oiChange1h: 0,
  oiChange15m: 0,
  spotCvd1h: 0,
  spotCvd15m: 0,
  trend1h: 'UNKNOWN',
  trend4h: 'UNKNOWN',
  fundingRate: 0,
  premiumRate: 0,
  longShortRatio: 1.0,
  longAccount: 0.5,
  shortAccount: 0.5,
  reversalProbability: 0
};

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

async function fetchBinanceOI() {
  try {
    const res = await fetchBinance('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=13');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const currentOIVal = parseFloat(data[data.length - 1].sumOpenInterestValue);
      const startOIVal = parseFloat(data[0].sumOpenInterestValue);
      const currentOI = parseFloat(data[data.length - 1].sumOpenInterest);
      const diffPercent = ((currentOIVal - startOIVal) / startOIVal) * 100;

      const initialOi15m = parseFloat(data[data.length - 4]?.sumOpenInterestValue || data[0].sumOpenInterestValue);
      const diff15m = initialOi15m > 0 ? ((currentOIVal - initialOi15m) / initialOi15m) * 100 : 0;

      return {
        currentOI,
        currentOIVal,
        oiChange1h: isNaN(diffPercent) ? 0 : diffPercent,
        oiChange15m: isNaN(diff15m) ? 0 : diff15m
      };
    }
  } catch (err) {
    console.error('[Binance API] Error fetching OI:', err.message);
  }
  return { currentOI: 0, currentOIVal: 0, oiChange1h: 0, oiChange15m: 0 };
}

async function fetchBinanceSpotCVD() {
  try {
    const res = await fetchBinance('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=12');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      let cumulativeDelta = 0;
      let cvd15m = 0;
      data.forEach((k, idx) => {
        const totalVal = parseFloat(k[7]);
        const takerBuyVal = parseFloat(k[10]);
        if (!isNaN(totalVal) && !isNaN(takerBuyVal)) {
          const delta = 2 * takerBuyVal - totalVal;
          cumulativeDelta += delta;
          if (idx >= data.length - 3) {
            cvd15m += delta;
          }
        }
      });
      return { cvd1h: cumulativeDelta, cvd15m };
    }
  } catch (err) {
    console.error('[Binance API] Error fetching Spot CVD:', err.message);
  }
  return { cvd1h: 0, cvd15m: 0 };
}

async function fetchBinanceHTFTrend() {
  try {
    // 1h Klines
    const res1h = await fetchBinance('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=210');
    let trend1h = 'UNKNOWN';
    let currentPrice = 0;
    if (res1h.ok) {
      const data1h = await res1h.json();
      if (Array.isArray(data1h) && data1h.length >= 200) {
        const prices = data1h.map(k => parseFloat(k[4]));
        currentPrice = prices[prices.length - 1];
        const ema50 = calculateEMA(prices, 50);
        trend1h = currentPrice > ema50 ? 'BULLISH' : 'BEARISH';
      }
    }

    // 4h Klines
    const res4h = await fetchBinance('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=210');
    let trend4h = 'UNKNOWN';
    if (res4h.ok) {
      const data4h = await res4h.json();
      if (Array.isArray(data4h) && data4h.length >= 200) {
        const prices = data4h.map(k => parseFloat(k[4]));
        const ema50 = calculateEMA(prices, 50);
        trend4h = prices[prices.length - 1] > ema50 ? 'BULLISH' : 'BEARISH';
      }
    }

    return { trend1h, trend4h };
  } catch (err) {
    console.error('[Binance API] Error fetching HTF Trend:', err.message);
  }
  return { trend1h: 'UNKNOWN', trend4h: 'UNKNOWN' };
}

async function fetchBinanceFundingRate() {
  try {
    const res = await fetchBinance('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data) {
      const lastFundingRate = parseFloat(data.lastFundingRate || 0);
      const markPrice = parseFloat(data.markPrice || 0);
      const indexPrice = parseFloat(data.indexPrice || 0);
      let premiumRate = 0;
      if (indexPrice > 0) {
        premiumRate = ((markPrice - indexPrice) / indexPrice) * 100;
      }
      return { fundingRate: lastFundingRate, premiumRate };
    }
  } catch (err) {
    console.error('[Binance API] Error fetching Funding Rate & Premium:', err.message);
  }
  return { fundingRate: 0, premiumRate: 0 };
}

async function fetchBinanceLongShortRatio() {
  try {
    const res = await fetchBinance('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return {
        ratio: parseFloat(data[0].longShortRatio || 1.0),
        long: parseFloat(data[0].longAccount || 0.5),
        short: parseFloat(data[0].shortAccount || 0.5)
      };
    }
  } catch (err) {
    console.error('[Binance API] Error fetching L/S Ratio:', err.message);
  }
  return { ratio: 1.0, long: 0.5, short: 0.5 };
}

// Helper functions for new CoinGlass metrics
function getLatestCoinbasePremium() {
  try {
    if (!cbPremiumCache || !cbPremiumCache.data) return null;
    const chart = Array.isArray(cbPremiumCache.data) ? cbPremiumCache.data[0] : cbPremiumCache.data;
    if (!chart || !chart.series || !chart.series[0] || !chart.series[0].data) return null;
    const data = chart.series[0].data;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== null && data[i] !== undefined) {
        return parseFloat(data[i]);
      }
    }
  } catch (e) {
    console.error('[Premium Index Parser] Error:', e.message);
  }
  return null;
}

function getLatestDepthDelta() {
  try {
    if (!depthDeltaCache || !depthDeltaCache.data) return null;
    const chart = Array.isArray(depthDeltaCache.data) ? depthDeltaCache.data[0] : depthDeltaCache.data;
    if (!chart || !chart.series || !chart.series[0] || !chart.series[0].data) return null;

    const series0 = chart.series[0];
    const data0 = series0.data;
    let val0 = null;
    for (let i = data0.length - 1; i >= 0; i--) {
      if (data0[i] !== null && data0[i] !== undefined) {
        val0 = parseFloat(data0[i]);
        break;
      }
    }

    if (chart.series[1] && chart.series[1].data) {
      const data1 = chart.series[1].data;
      let val1 = null;
      for (let i = data1.length - 1; i >= 0; i--) {
        if (data1[i] !== null && data1[i] !== undefined) {
          val1 = parseFloat(data1[i]);
          break;
        }
      }
      if (val0 !== null && val1 !== null) {
        const name0 = (series0.name || '').toLowerCase();
        const name1 = (chart.series[1].name || '').toLowerCase();
        if (name0.includes('bid') || name1.includes('ask')) {
          return val0 - Math.abs(val1);
        }
      }
    }
    return val0;
  } catch (e) {
    console.error('[Depth Delta Parser] Error:', e.message);
  }
  return null;
}

function findWhaleOrderNear(price, direction, tolerancePercent = 0.15) {
  try {
    if (!whaleOrdersCache) return null;
    const rawData = whaleOrdersCache.data || whaleOrdersCache;
    const data = Array.isArray(rawData) ? rawData : (rawData.data || []);
    if (!Array.isArray(data)) return null;

    const targetSide = direction === 'LONG' ? 'buy' : 'sell';

    let closest = null;
    let minDiff = Infinity;

    data.forEach(order => {
      if (order.side !== targetSide) return;

      const diff = Math.abs(order.price - price);
      const pct = (diff / price) * 100;
      if (pct <= tolerancePercent) {
        if (diff < minDiff) {
          minDiff = diff;
          closest = order;
        }
      }
    });
    return closest;
  } catch (e) {
    console.error('[Whale Order Finder] Error:', e.message);
  }
  return null;
}

function calculateReversalProbability(sweepDetail, oiChange15m, spotCvd15m, trend1h, trend4h, premiumRate, longShortRatio) {
  const baseScore = 40;
  let score = baseScore;

  // 1. Liquidation Pool Volume (Up to 15 points)
  // Scale so that $20M of aggregated bin volume gives full 15 points
  const volMillions = sweepDetail.volume / 1e6;
  const poolVolumePoints = Math.min(15, parseFloat((volMillions * 0.75).toFixed(1)));
  score += poolVolumePoints;

  // 2. Rejection Strength / Wick Depth (Up to 15 points)
  const rejectionPoints = Math.min(15, parseFloat(((sweepDetail.rejectionStrength || 0) * 15).toFixed(1)));
  score += rejectionPoints;

  // 3. Open Interest change (±10) - Short-term 15m
  // Squeeze: OI drops during a support sweep = positive reversal indicator
  let oiChangePoints = 0;
  if (sweepDetail.direction === 'LONG' && oiChange15m < 0) {
    oiChangePoints = 10;
  } else if (sweepDetail.direction === 'SHORT' && oiChange15m > 0) {
    oiChangePoints = -10;
  }
  score += oiChangePoints;

  // 4. Spot CVD Divergence (+10 max) - Short-term 15m
  // Spot buying (positive spotCvd) during LONG = full points
  let spotCvdPoints = 0;
  if (sweepDetail.direction === 'LONG' && spotCvd15m > 0) {
    spotCvdPoints = 10;
  } else if (sweepDetail.direction === 'SHORT' && spotCvd15m < 0) {
    spotCvdPoints = 10;
  }
  score += spotCvdPoints;

  // 5. HTF Trend Alignment (Up to 10 points)
  let trendPoints = 0;
  if (sweepDetail.direction === 'LONG') {
    if (trend1h === 'BULLISH') trendPoints += 5;
    if (trend4h === 'BULLISH') trendPoints += 5;
  } else if (sweepDetail.direction === 'SHORT') {
    if (trend1h === 'BEARISH') trendPoints += 5;
    if (trend4h === 'BEARISH') trendPoints += 5;
  }
  score += trendPoints;

  // 6. Premium Rate (±10) - Sensitivity of micro-sentiment
  let premiumRatePoints = 0;
  const pRate = parseFloat(premiumRate) || 0;
  if (sweepDetail.direction === 'LONG') {
    if (pRate < -0.01) {
      premiumRatePoints = 10;
    } else if (pRate > 0.01) {
      premiumRatePoints = -10;
    }
  } else if (sweepDetail.direction === 'SHORT') {
    if (pRate > 0.01) {
      premiumRatePoints = 10;
    } else if (pRate < -0.01) {
      premiumRatePoints = -10;
    }
  }
  score += premiumRatePoints;

  // 7. Long/Short Ratio (Up to 10 points) - Deprecated in strategy calculation (set to 0 for backwards compatibility)
  let lsRatioPoints = 0;

  // 8. Coinbase Premium Index (Reactivated for Directional Filtering)
  let coinbasePremiumPoints = 0;
  const cbPremium = getLatestCoinbasePremium();
  if (cbPremium !== null) {
    if (sweepDetail.direction === 'LONG') {
      if (cbPremium > 0.01) {
        coinbasePremiumPoints = 15;
      } else if (cbPremium < -0.05) {
        coinbasePremiumPoints = -20;
      } else if (cbPremium < -0.01) {
        coinbasePremiumPoints = -10;
      }
    } else if (sweepDetail.direction === 'SHORT') {
      if (cbPremium < -0.01) {
        coinbasePremiumPoints = 15;
      } else if (cbPremium > 0.05) {
        coinbasePremiumPoints = -20;
      } else if (cbPremium > 0.01) {
        coinbasePremiumPoints = -10;
      }
    }
  }
  score += lsRatioPoints;
  score += coinbasePremiumPoints;

  // 9. Orderbook Depth Delta (Up to 15 points + Anti-Spoofing Force Skip)
  let deltaPoints = 0;
  const depthDelta = getLatestDepthDelta();
  if (depthDelta !== null) {
    if (sweepDetail.direction === 'LONG') {
      if (depthDelta > 0) {
        deltaPoints = Math.min(15, (depthDelta / 50) * 15);
      } else if (depthDelta < -30) {
        deltaPoints = -15;
        sweepDetail.forceSkip = 'Spoofing detected: High negative depth delta (' + depthDelta.toFixed(0) + ' BTC)';
      } else {
        deltaPoints = -Math.min(15, Math.abs(depthDelta) * 0.5);
      }
    } else if (sweepDetail.direction === 'SHORT') {
      if (depthDelta < 0) {
        deltaPoints = Math.min(15, (Math.abs(depthDelta) / 50) * 15);
      } else if (depthDelta > 30) {
        deltaPoints = -15;
        sweepDetail.forceSkip = 'Spoofing detected: High positive depth delta (' + depthDelta.toFixed(0) + ' BTC)';
      } else {
        deltaPoints = -Math.min(15, depthDelta * 0.5);
      }
    }
  }
  score += deltaPoints;

  // 10. Whale Order Wall (Up to 5 points)
  let whalePoints = 0;
  if (sweepDetail.price) {
    const whaleOrder = findWhaleOrderNear(sweepDetail.price, sweepDetail.direction, 0.15); // 0.15% tolerance
    if (whaleOrder) {
      const valMillions = whaleOrder.valueUsd / 1e6;
      whalePoints = Math.min(5, valMillions * 1);
    }
  }
  score += whalePoints;

  // 11. Liquidation Spike (+10 max)
  let liqScore = 0;
  if (sweepDetail.direction === 'LONG') {
    // long positions liquidated (SELL side)
    const liqUsd = getRecentLiquidationsUsd('SELL', 5);
    liqScore = Math.min(10, parseFloat((liqUsd / 200000).toFixed(1)));
  } else {
    // short positions liquidated (BUY side)
    const liqUsd = getRecentLiquidationsUsd('BUY', 5);
    liqScore = Math.min(10, parseFloat((liqUsd / 200000).toFixed(1)));
  }
  score += liqScore;

  const finalScore = Math.max(10, Math.min(99, Math.round(score)));
  const forceSkipText = sweepDetail.forceSkip || null;

  return {
    score: finalScore,
    forceSkip: forceSkipText,
    breakdown: {
      baseScore,
      poolVolume: Math.round(poolVolumePoints * 10) / 10,
      rejection: Math.round(rejectionPoints * 10) / 10,
      oiChange: Math.round(oiChangePoints * 10) / 10,
      spotCvd: Math.round(spotCvdPoints * 10) / 10,
      trend: Math.round(trendPoints * 10) / 10,
      funding: Math.round(premiumRatePoints * 10) / 10, // Maps to funding field on UI
      lsRatio: lsRatioPoints,
      coinbasePremium: coinbasePremiumPoints,
      depthDelta: Math.round(deltaPoints * 10) / 10,
      whaleWall: Math.round(whalePoints * 10) / 10,
      liquidations: Math.round(liqScore * 10) / 10,
      depthDeltaVal: depthDelta !== null ? depthDelta : 0,
      premiumVal: cbPremium !== null ? cbPremium : 0
    }
  };
}

// ─── Server-Side Bot Logic ──────────────────────────────────
function evaluateActiveTradesBackend(heatmapData) {
  const settings = loadSettings();
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
        const pnl = trade.isBreakeven ? 0 : -trade.riskUsd;
        trade.pnl = pnl;
        trade.closePrice = trade.sl;
        trade.closeTimestamp = Date.now();
        trade.note = trade.isBreakeven ? `Wick Hit Breakeven ($${lastLow.toFixed(2)})` : `Wick Hit SL ($${lastLow.toFixed(2)})`;
        updated = true;

        const pnlText = pnl === 0 ? `$0.00 (Breakeven)` : `-$${trade.riskUsd.toFixed(2)}`;
        const pnlBsText = pnl === 0 ? `Rp 0` : `-Rp ${(trade.riskUsd * 16300).toFixed(0)}`;
        const alertIcon = trade.isBreakeven ? `🛡️` : `🚨`;
        const alertTitle = trade.isBreakeven ? `Trade Closed (Hit Breakeven)` : `Trade Closed (Hit SL)`;

        console.log(`[LSR Bot] ${alertIcon} LONG Hit ${trade.isBreakeven ? 'Breakeven' : 'SL'} at $${trade.sl.toFixed(2)} (Last Low: $${lastLow.toFixed(2)}), PnL: ${pnlText}`);
        sendTelegramAlert(
          `${alertIcon} <b>${alertTitle}</b>\n` +
          `Type: <b>LONG</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `SL Hit: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `PnL: <code>${pnlText}</code> (${pnlBsText})\n` +
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
        trade.closeTimestamp = Date.now();
        trade.note = `Wick Hit TP ($${lastHigh.toFixed(2)})`;
        updated = true;
        console.log(`[LSR Bot] 🎉 LONG Hit TP at $${trade.tp.toFixed(2)} (Last High: $${lastHigh.toFixed(2)}), PnL: +$${profit.toFixed(2)}`);
        sendTelegramAlert(
          `🎉 <b>Trade Closed (Hit TP)</b>\n` +
          `Type: <b>LONG</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `TP Hit: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `PnL: <code>+$${profit.toFixed(2)}</code> (+Rp ${(profit * 16300).toFixed(0)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
    } else { // SHORT
      // 1. Check Stop Loss Hit
      if (lastHigh >= trade.sl) {
        trade.status = 'HIT_SL';
        const pnl = trade.isBreakeven ? 0 : -trade.riskUsd;
        trade.pnl = pnl;
        trade.closePrice = trade.sl;
        trade.closeTimestamp = Date.now();
        trade.note = trade.isBreakeven ? `Wick Hit Breakeven ($${lastHigh.toFixed(2)})` : `Wick Hit SL ($${lastHigh.toFixed(2)})`;
        updated = true;

        const pnlText = pnl === 0 ? `$0.00 (Breakeven)` : `-$${trade.riskUsd.toFixed(2)}`;
        const pnlBsText = pnl === 0 ? `Rp 0` : `-Rp ${(trade.riskUsd * 16300).toFixed(0)}`;
        const alertIcon = trade.isBreakeven ? `🛡️` : `🚨`;
        const alertTitle = trade.isBreakeven ? `Trade Closed (Hit Breakeven)` : `Trade Closed (Hit SL)`;

        console.log(`[LSR Bot] ${alertIcon} SHORT Hit ${trade.isBreakeven ? 'Breakeven' : 'SL'} at $${trade.sl.toFixed(2)} (Last High: $${lastHigh.toFixed(2)}), PnL: ${pnlText}`);
        sendTelegramAlert(
          `${alertIcon} <b>${alertTitle}</b>\n` +
          `Type: <b>SHORT</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `SL Hit: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `PnL: <code>${pnlText}</code> (${pnlBsText})\n` +
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
        trade.closeTimestamp = Date.now();
        trade.note = `Wick Hit TP ($${lastLow.toFixed(2)})`;
        updated = true;
        console.log(`[LSR Bot] 🎉 SHORT Hit TP at $${trade.tp.toFixed(2)} (Last Low: $${lastLow.toFixed(2)}), PnL: +$${profit.toFixed(2)}`);
        sendTelegramAlert(
          `🎉 <b>Trade Closed (Hit TP)</b>\n` +
          `Type: <b>SHORT</b>\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `TP Hit: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `PnL: <code>+$${profit.toFixed(2)}</code> (+Rp ${(profit * 16300).toFixed(0)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
    }

    // 2.5. Check Breakeven Trigger (1:1 R:R target hit)
    if (settings.breakevenEnabled !== false && !trade.isBreakeven && trade.sl !== trade.entry) {
      const slDist = trade.slDistance || (Math.abs(trade.entry - trade.sl) / trade.entry * 100);
      if (trade.direction === 'LONG') {
        const targetPrice = trade.entry * (1 + slDist / 100);
        if (lastHigh >= targetPrice) {
          trade.sl = trade.entry * 1.001; // Lock in slippage/fee buffer (+0.1%)
          trade.isBreakeven = true;
          trade.note = `SL moved to Breakeven+Buffer (1:1 hit at $${lastHigh.toFixed(2)})`;
          updated = true;
          console.log(`[LSR Bot] 🛡️ LONG SL moved to Breakeven+Buffer for trade ${trade.id} (Entry: $${trade.entry.toFixed(2)}, Target: $${targetPrice.toFixed(2)}, New SL: $${trade.sl.toFixed(2)})`);
          sendTelegramAlert(
            `🛡️ <b>Trade Protected (Moved to BE+Buffer)</b>\n` +
            `Type: <b>LONG</b>\n` +
            `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
            `New SL: <code>$${trade.sl.toFixed(2)}</code> (+0.1% Buffer)\n` +
            `R:R 1:1 Target Hit: <code>$${targetPrice.toFixed(2)}</code>\n` +
            `Note: ${trade.note}`
          );
        }
      } else { // SHORT
        const targetPrice = trade.entry * (1 - slDist / 100);
        if (lastLow <= targetPrice) {
          trade.sl = trade.entry * 0.999; // Lock in slippage/fee buffer (-0.1%)
          trade.isBreakeven = true;
          trade.note = `SL moved to Breakeven+Buffer (1:1 hit at $${lastLow.toFixed(2)})`;
          updated = true;
          console.log(`[LSR Bot] 🛡️ SHORT SL moved to Breakeven+Buffer for trade ${trade.id} (Entry: $${trade.entry.toFixed(2)}, Target: $${targetPrice.toFixed(2)}, New SL: $${trade.sl.toFixed(2)})`);
          sendTelegramAlert(
            `🛡️ <b>Trade Protected (Moved to BE+Buffer)</b>\n` +
            `Type: <b>SHORT</b>\n` +
            `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
            `New SL: <code>$${trade.sl.toFixed(2)}</code> (-0.1% Buffer)\n` +
            `R:R 1:1 Target Hit: <code>$${targetPrice.toFixed(2)}</code>\n` +
            `Note: ${trade.note}`
          );
        }
      }
    }

    // 3. Check Pool Shrinkage (only if price is close to TP)
    const currentTpDistPercent = (Math.abs(lastClose - trade.tp) / trade.tp) * 100;
    const autoCutDistanceThreshold = settings.autoCutDistanceThreshold !== undefined ? settings.autoCutDistanceThreshold : 1.0;

    if (currentTpDistPercent <= autoCutDistanceThreshold) {
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

      if (trade.initialTpVolume && currentTpVolume < trade.initialTpVolume * 0.7) {
        // Multi-timeframe validation: check if the pool is still intact in the 3D heatmap
        let poolStillIntact3D = false;
        try {
          if (typeof heatmap3DCache !== 'undefined' && heatmap3DCache) {
            const heatmap3d = heatmap3DCache.data || heatmap3DCache;
            if (heatmap3d && heatmap3d.yAxis && heatmap3d.series) {
              const yAxis3d = heatmap3d.yAxis;
              const hs3d = heatmap3d.series.find(s => s.type === 'heatmap');
              if (hs3d && hs3d.data) {
                let closestYIdx3D = -1, minDiff3D = Infinity;
                yAxis3d.forEach((priceStr, idx) => {
                  const diff = Math.abs(parseFloat(priceStr) - trade.tp);
                  if (diff < minDiff3D) { minDiff3D = diff; closestYIdx3D = idx; }
                });
                
                if (closestYIdx3D !== -1) {
                  let current3DVolume = 0;
                  const latestXIdx3D = (heatmap3d.xAxis || []).length - 1;
                  hs3d.data.forEach(item => {
                    const v = Array.isArray(item) ? item : (item.value || []);
                    const xIdx = parseInt(v[0], 10);
                    const yIdx = parseInt(v[1], 10);
                    if (yIdx === closestYIdx3D && xIdx === latestXIdx3D) {
                      current3DVolume += parseFloat(v[2] || 0);
                    }
                  });
                  
                  // Compute dynamic top 25% volume cutoff for 3D heatmap
                  const volumeByY3D = {};
                  hs3d.data.forEach(item => {
                    const v = Array.isArray(item) ? item : (item.value || []);
                    const xIdx = parseInt(v[0], 10);
                    const yIdx = parseInt(v[1], 10);
                    const val = parseFloat(v[2] || 0);
                    if (!isNaN(yIdx) && xIdx === latestXIdx3D) {
                      volumeByY3D[yIdx] = (volumeByY3D[yIdx] || 0) + val;
                    }
                  });
                  const allVolumes3D = Object.values(volumeByY3D).filter(v => v > 0).sort((a, b) => b - a);
                  const topCutoffIndex3D = Math.max(1, Math.floor(allVolumes3D.length * 0.25));
                  const minPoolVolume3D = allVolumes3D[topCutoffIndex3D - 1] || 0;
                  
                  if (current3DVolume >= minPoolVolume3D && current3DVolume > 50000000) {
                    poolStillIntact3D = true;
                  }
                }
              }
            }
          }
        } catch (e3d) {
          console.error('[LSR Bot] Error during 3D heatmap Auto-Cut validation:', e3d.message);
        }

        if (poolStillIntact3D) {
          console.log(`[LSR Bot] 🛡️ Auto-Cut bypassed for trade ${trade.id}: 24H pool shrunk to $${(currentTpVolume/1e6).toFixed(1)}M, but 3D pool is still intact at $${trade.tp.toFixed(0)}.`);
        } else {
          trade.status = 'CUT_LOSS';
          const diff = trade.direction === 'LONG' ? (lastClose - trade.entry) : (trade.entry - lastClose);
          const profit = trade.positionSizeUsd * (diff / trade.entry);
          trade.pnl = profit;
          trade.closePrice = lastClose;
          trade.closeTimestamp = Date.now();
          trade.note = 'Auto (Pool -70%)';
          updated = true;
          console.log(`[LSR Bot] ⚠️ AUTO-CUT TRIGGERED — ${trade.direction} Closed at $${lastClose.toFixed(2)} (Initial Pool: $${(trade.initialTpVolume/1e9).toFixed(2)}B, Current Pool: $${(currentTpVolume/1e9).toFixed(2)}B), PnL: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
          sendTelegramAlert(
            `⚠️ <b>Trade Closed (Auto-Cut: Pool -70%)</b>\n` +
            `Type: <b>${trade.direction}</b>\n` +
            `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
            `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
            `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
            `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
            `Close: <code>$${lastClose.toFixed(2)}</code>\n` +
            `PnL: <code>${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}</code> (${profit >= 0 ? '+' : ''}Rp ${(profit * 16300).toFixed(0)})\n` +
            `Note: ${trade.note}`
          );
          return;
        }
      }
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

function evaluateActiveJdaTradesBackend(heatmapData) {
  const cs = heatmapData.series.find(s => s.type === 'candlestick');
  if (!cs || !cs.data || cs.data.length === 0) return;

  const lastCandle = cs.data[cs.data.length - 1];
  const lastClose = parseFloat(lastCandle[1]);
  const lastLow = parseFloat(lastCandle[2]);
  const lastHigh = parseFloat(lastCandle[3]);

  if (isNaN(lastClose) || isNaN(lastLow) || isNaN(lastHigh)) return;

  const trades = loadJdaTrades();
  let updated = false;

  trades.forEach(trade => {
    if (trade.status !== 'ACTIVE') return;

    if (trade.direction === 'LONG') {
      // 1. Check Stop Loss Hit
      if (lastLow <= trade.sl) {
        trade.status = 'HIT_SL';
        const pnl = -trade.riskUsd;
        trade.pnl = pnl;
        trade.closePrice = trade.sl;
        trade.closeTimestamp = Date.now();
        trade.note = `Wick Hit SL ($${lastLow.toFixed(2)})`;
        updated = true;

        const pnlText = `-$${trade.riskUsd.toFixed(2)}`;
        const pnlBsText = `-Rp ${(trade.riskUsd * 16300).toFixed(0)}`;
        console.log(`[JDA Bot] LONG Hit SL at $${trade.sl.toFixed(2)} (Last Low: $${lastLow.toFixed(2)}), PnL: ${pnlText}`);
        sendTelegramAlert(
          `🚨 <b>JDA MTF Trade Closed (Hit SL)</b>\n` +
          `Type: <b>LONG</b> (${trade.tf || '15m'})\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `SL Hit: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `PnL: <code>${pnlText}</code> (${pnlBsText})\n` +
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
        trade.closeTimestamp = Date.now();
        trade.note = `Wick Hit TP ($${lastHigh.toFixed(2)})`;
        updated = true;
        console.log(`[JDA Bot] 🎉 LONG Hit TP at $${trade.tp.toFixed(2)} (Last High: $${lastHigh.toFixed(2)}), PnL: +$${profit.toFixed(2)}`);
        sendTelegramAlert(
          `🎉 <b>JDA MTF Trade Closed (Hit TP)</b>\n` +
          `Type: <b>LONG</b> (${trade.tf || '15m'})\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `TP Hit: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `PnL: <code>+$${profit.toFixed(2)}</code> (+Rp ${(profit * 16300).toFixed(0)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
    } else { // SHORT
      // 1. Check Stop Loss Hit
      if (lastHigh >= trade.sl) {
        trade.status = 'HIT_SL';
        const pnl = -trade.riskUsd;
        trade.pnl = pnl;
        trade.closePrice = trade.sl;
        trade.closeTimestamp = Date.now();
        trade.note = `Wick Hit SL ($${lastHigh.toFixed(2)})`;
        updated = true;

        const pnlText = `-$${trade.riskUsd.toFixed(2)}`;
        const pnlBsText = `-Rp ${(trade.riskUsd * 16300).toFixed(0)}`;
        console.log(`[JDA Bot] SHORT Hit SL at $${trade.sl.toFixed(2)} (Last High: $${lastHigh.toFixed(2)}), PnL: ${pnlText}`);
        sendTelegramAlert(
          `🚨 <b>JDA MTF Trade Closed (Hit SL)</b>\n` +
          `Type: <b>SHORT</b> (${trade.tf || '15m'})\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `SL Hit: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `PnL: <code>${pnlText}</code> (${pnlBsText})\n` +
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
        trade.closeTimestamp = Date.now();
        trade.note = `Wick Hit TP ($${lastLow.toFixed(2)})`;
        updated = true;
        console.log(`[JDA Bot] 🎉 SHORT Hit TP at $${trade.tp.toFixed(2)} (Last Low: $${lastLow.toFixed(2)}), PnL: +$${profit.toFixed(2)}`);
        sendTelegramAlert(
          `🎉 <b>JDA MTF Trade Closed (Hit TP)</b>\n` +
          `Type: <b>SHORT</b> (${trade.tf || '15m'})\n` +
          `Entry: <code>$${trade.entry.toFixed(2)}</code>\n` +
          `TP: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `SL: <code>$${trade.sl.toFixed(2)}</code>\n` +
          `Size: <code>$${trade.positionSizeUsd.toFixed(0)}</code>\n` +
          `TP Hit: <code>$${trade.tp.toFixed(2)}</code>\n` +
          `PnL: <code>+$${profit.toFixed(2)}</code> (+Rp ${(profit * 16300).toFixed(0)})\n` +
          `Note: ${trade.note}`
        );
        return;
      }
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
    saveJdaTrades(trades);
  }
}

function autoJdaTradeStrategyBackend(heatmapData, klines15m) {
  const settings = loadSettings();
  if (!settings.jdaAutoTradeEnabled) {
    botJdaPhaseState = { phase: 'DISABLED', message: 'JDA Auto-trade is disabled', lastUpdate: new Date().toISOString() };
    return;
  }

  if (!jdaSignalCache) {
    botJdaPhaseState = { phase: 'NO_DATA', message: 'No JDA signal cache available', lastUpdate: new Date().toISOString() };
    return;
  }

  const JdaTrades = loadJdaTrades();
  const activeJdaTrades = JdaTrades.filter(t => t.status === 'ACTIVE');

  if (activeJdaTrades.length >= (settings.maxActive || 1)) {
    botJdaPhaseState = { phase: 'MAX_ACTIVE', message: `Max active JDA trades reached (${activeJdaTrades.length}/${settings.maxActive || 1})`, lastUpdate: new Date().toISOString() };
    return;
  }

  const currentJdaAction = jdaSignalCache.action;
  if (!currentJdaAction || currentJdaAction === 'WAIT') {
    botJdaPhaseState = { phase: 'STANDBY', message: `Monitoring market... (Conf: ${Math.round(jdaSignalCache.conf)}%)`, lastUpdate: new Date().toISOString() };
    return;
  }

  // Check confidence threshold
  if (jdaSignalCache.conf < (settings.jdaMinConfidence || 60)) {
    botJdaPhaseState = { phase: 'STANDBY', message: `Signal ignored: Confidence too low (${Math.round(jdaSignalCache.conf)}% < ${settings.jdaMinConfidence || 60}%)`, lastUpdate: new Date().toISOString() };
    return;
  }

  const direction = (currentJdaAction.includes('LONG')) ? 'LONG' : 'SHORT';

  // Cooldown check
  const latestTrade = JdaTrades[JdaTrades.length - 1];
  if (latestTrade) {
    const elapsedMinutes = (Date.now() - latestTrade.timestamp) / (60 * 1000);
    const cooldown = settings.cooldownMinutes || 60;
    if (elapsedMinutes < cooldown && latestTrade.direction === direction) {
      botJdaPhaseState = { phase: 'COOLDOWN', message: `Cooldown active (${Math.round(cooldown - elapsedMinutes)}m remaining for ${direction})`, lastUpdate: new Date().toISOString() };
      return;
    }
  }

  // Get current price from candlestick series
  const cs = heatmapData.series.find(s => s.type === 'candlestick');
  if (!cs || !cs.data || cs.data.length === 0) return;
  const lastCandle = cs.data[cs.data.length - 1];
  const entry = parseFloat(lastCandle[1]);
  if (isNaN(entry)) return;

  let tp = 0;
  let sl = 0;
  let calculatedVia = 'HEATMAP';

  if (settings.jdaSlTpMethod === 'HEATMAP') {
    const yAxisData = heatmapData.yAxis || [];
    const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');
    if (heatmapSeries && heatmapSeries.data && heatmapSeries.data.length > 0) {
      const latestXIdx = heatmapData.xAxis.length - 1;
      const volumeByY = {};
      heatmapSeries.data.forEach(item => {
        const v = Array.isArray(item) ? item : (item.value || []);
        const xIdx = parseInt(v[0], 10);
        const yIdx = parseInt(v[1], 10);
        if (!isNaN(yIdx) && xIdx === latestXIdx) {
          volumeByY[yIdx] = parseFloat(v[2] || 0);
        }
      });

      const allVolumes = Object.values(volumeByY).filter(v => v > 0).sort((a, b) => b - a);
      const volumeRatio = settings.minPoolVolumeRatio || 0.15;
      const topCutoffIndex = Math.max(1, Math.floor(allVolumes.length * volumeRatio));
      const minPoolVolume = allVolumes[topCutoffIndex - 1] || 0;

      let nearestAbove = null, nearestBelow = null;
      yAxisData.forEach((priceStr, idx) => {
        const p = parseFloat(priceStr);
        if (isNaN(p)) return;
        const volume = volumeByY[idx] || 0;
        if (volume < minPoolVolume) return;

        const distPercent = ((p - entry) / entry) * 100;
        const absDist = Math.abs(distPercent);

        if (absDist < 0.1 || absDist > (settings.maxDist || 8)) return;

        if (p > entry) {
          if (!nearestAbove || absDist < Math.abs(nearestAbove.distance)) {
            nearestAbove = { price: p, distance: distPercent };
          }
        } else {
          if (!nearestBelow || absDist < Math.abs(nearestBelow.distance)) {
            nearestBelow = { price: p, distance: distPercent };
          }
        }
      });

      if (direction === 'LONG' && nearestAbove && nearestBelow) {
        tp = nearestAbove.price;
        sl = nearestBelow.price;
      } else if (direction === 'SHORT' && nearestAbove && nearestBelow) {
        tp = nearestBelow.price;
        sl = nearestAbove.price;
      }
    }
  }

  // Fallback to ATR if heatmap target is zero or method is ATR
  if (tp === 0 || sl === 0) {
    calculatedVia = 'ATR';
    if (klines15m) {
      const atrValue = calculateATRFromCandles(klines15m, settings.jdaAtrPeriod || 14);
      if (atrValue) {
        const slDistanceUsd = atrValue * (settings.jdaAtrMultiplier || 2.0);
        const tpDistanceUsd = slDistanceUsd * (settings.jdaRiskRewardRatio || 2.0);

        if (direction === 'LONG') {
          sl = entry - slDistanceUsd;
          tp = entry + tpDistanceUsd;
        } else {
          sl = entry + slDistanceUsd;
          tp = entry - tpDistanceUsd;
        }
      }
    }
  }

  // Hard fallback
  if (tp === 0 || sl === 0) {
    calculatedVia = 'HARD_FALLBACK';
    const fallbackSLPercent = 1.5;
    const fallbackTPPercent = 3.0;
    if (direction === 'LONG') {
      sl = entry * (1 - fallbackSLPercent / 100);
      tp = entry * (1 + fallbackTPPercent / 100);
    } else {
      sl = entry * (1 + fallbackSLPercent / 100);
      tp = entry * (1 - fallbackTPPercent / 100);
    }
  }

  const riskUsd = settings.jdaCapital * (settings.jdaRiskPercent / 100);
  const slDistance = Math.abs(((entry - sl) / entry) * 100);
  const tpDistance = Math.abs(((tp - entry) / entry) * 100);
  const positionSizeUsd = riskUsd / (slDistance / 100);

  const timestamp = Date.now();
  const newTrade = {
    id: 'T' + timestamp,
    timestamp,
    time: new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction,
    tf: jdaSignalCache.confLevel ? 'MTF' : '15m',
    entry,
    tp: parseFloat(tp.toFixed(2)),
    sl: parseFloat(sl.toFixed(2)),
    capital: settings.jdaCapital,
    riskPercent: settings.jdaRiskPercent,
    riskUsd,
    positionSizeUsd,
    tpDistance,
    slDistance,
    status: 'ACTIVE',
    pnl: 0,
    note: `Auto-Trade (JDA MTF Signal Engine - ${currentJdaAction} via ${calculatedVia})`
  };

  JdaTrades.push(newTrade);
  saveJdaTrades(JdaTrades);

  botJdaPhaseState = {
    phase: 'TRADE_EXECUTED',
    lastUpdate: new Date().toISOString(),
    message: `Executed JDA ${direction} trade at $${entry.toFixed(2)}`
  };

  sendTelegramAlert(
    `🔔 <b>New JDA MTF Trade Executed (Auto-Trade Engine)</b>\n` +
    `Type: <b>${direction}</b>\n` +
    `Trigger: <b>${currentJdaAction}</b> (Conf: ${jdaSignalCache.conf}%)\n` +
    `Entry: <code>$${entry.toFixed(2)}</code>\n` +
    `TP: <code>$${tp.toFixed(2)}</code>\n` +
    `SL: <code>$${sl.toFixed(2)}</code>\n` +
    `Size: <code>$${positionSizeUsd.toFixed(0)}</code> (Risk: $${riskUsd.toFixed(2)})\n` +
    `Note: ${newTrade.note}`
  );
}


// ─── Global Bot Phase State (for API reporting) ─────────────
const SWEEP_HISTORY_FILE = path.join(__dirname, 'sweep_history.json');
let sweepHistory = [];
let lastSweepHistoryKey = null;
let lastSweepHistoryTime = 0;

function loadSweepHistory() {
  if (!fs.existsSync(SWEEP_HISTORY_FILE)) {
    try {
      fs.writeFileSync(SWEEP_HISTORY_FILE, JSON.stringify([], null, 2));
    } catch (e) {
      console.error('Error creating sweep history file:', e.message);
    }
    return [];
  }
  try {
    const data = fs.readFileSync(SWEEP_HISTORY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading sweep history file:', e.message);
    return [];
  }
}

function saveSweepHistory(history) {
  try {
    fs.writeFileSync(SWEEP_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('Error saving sweep history file:', e.message);
  }
}

// Load sweep history on startup
try {
  sweepHistory = loadSweepHistory();
} catch (e) {
  sweepHistory = [];
}

let botPhaseState = {
  phase: 'INITIALIZING',
  nearestPool: null,
  nearestPoolDistance: null,
  nearestPoolVolume: null,
  nearestPoolSide: null,
  sweepCandidate: null,
  lastUpdate: new Date().toISOString(),
  message: 'Bot starting up...'
};

function setBotPhaseState(newState, providedOldPhase) {
  const oldPhase = providedOldPhase !== undefined ? providedOldPhase : (botPhaseState ? botPhaseState.phase : null);
  botPhaseState = newState;
  
  if (newState && newState.phase) {
    const isStandbyTransition = (newState.phase === 'STANDBY' && oldPhase && oldPhase !== 'STANDBY');
    const shouldLog = (newState.phase !== 'STANDBY' || isStandbyTransition || sweepHistory.length === 0);
    
    if (shouldLog) {
      const key = `${newState.phase}_${newState.nearestPool || ''}_${newState.message}`;
      const now = Date.now();
      
      // Deduplicate: same phase and message within 2 minutes
      if (key !== lastSweepHistoryKey || (now - lastSweepHistoryTime > 120000)) {
        lastSweepHistoryKey = key;
        lastSweepHistoryTime = now;
        
        const entry = {
          id: 'L' + now + Math.floor(Math.random() * 1000),
          timestamp: now,
          phase: newState.phase,
          nearestPool: newState.nearestPool,
          nearestPoolDistance: newState.nearestPoolDistance,
          nearestPoolVolume: newState.nearestPoolVolume,
          nearestPoolSide: newState.nearestPoolSide,
          message: newState.message,
          sweepCandidate: newState.sweepCandidate || null,
          probabilityBreakdown: newState.probabilityBreakdown || null
        };
        
        sweepHistory.unshift(entry);
        if (sweepHistory.length > 200) {
          sweepHistory.pop();
        }
        saveSweepHistory(sweepHistory);
      }
    }
  }
}

let botJdaPhaseState = {
  phase: 'INITIALIZING',
  lastUpdate: new Date().toISOString(),
  message: 'Bot starting up...'
};

// API endpoint for bot phase status

app.get('/api/sweep-prediction', (req, res) => {
  console.log('[DEBUG API] Get sweep-prediction. 24h:', sweepPredictionCache ? sweepPredictionCache.direction + ' ' + sweepPredictionCache.confidence + '%' : 'NULL', '3d:', sweepPrediction3DCache ? sweepPrediction3DCache.direction + ' ' + sweepPrediction3DCache.confidence + '%' : 'NULL');
  res.json({ success: true, data: sweepPredictionCache, data3d: sweepPrediction3DCache });
});

app.get('/api/heatmap-data-3d', async (req, res) => {
  if (heatmap3DCache && lastHeatmap3DFetchTime && (Date.now() - lastHeatmap3DFetchTime < 600000)) {
    return res.json({ success: true, source: 'cache', data: heatmap3DCache });
  }
  if (heatmap3DCache) {
    return res.json({ success: true, source: 'stale-cache', data: heatmap3DCache });
  }
  res.status(503).json({ success: false, error: 'No 3D data yet, please wait for next cycle.' });
});

app.get('/api/jda-signal', async (req, res) => {
  try {
    if (!jdaSignalCache || (Date.now() - jdaSignalCache.fetchTime > 180000)) {
      jdaSignalCache = await fetchJDASignal();
    }
    res.json({ success: true, data: jdaSignalCache });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Connection Status Check ─────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const settings = loadSettings();
  const checks = [];

  // 1. Dashboard server (self — always ok if we got here)
  checks.push({ name: 'Dashboard Server', key: 'server', status: 'ok', detail: `Running on port ${PORT}`, latency: 0 });

  // 2. Chrome CDP (only check if scraper is enabled)
  if (!settings.disableScraper && process.env.DISABLE_SCRAPER !== 'true') {
    const cdpStart = Date.now();
    try {
      const r = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(3000) });
      const tabs = await r.json();
      const cgTab = tabs.find(t => t.url?.includes('coinglass.com'));
      checks.push({
        name: 'Chrome DevTools (CDP)',
        key: 'cdp',
        status: 'ok',
        detail: `${tabs.length} tab(s) open · ${cgTab ? 'CoinGlass tab found' : 'No CoinGlass tab (will navigate on sync)'}`,
        latency: Date.now() - cdpStart
      });
    } catch (e) {
      checks.push({ name: 'Chrome DevTools (CDP)', key: 'cdp', status: 'error', detail: 'Port 9222 unreachable — open Chrome with --remote-debugging-port=9222', latency: Date.now() - cdpStart });
    }
  }

  // 3. Binance Spot API
  const bsStart = Date.now();
  try {
    const r = await fetchBinance('https://api.binance.com/api/v3/ping', { signal: AbortSignal.timeout(5000) });
    checks.push({ name: 'Binance Spot API', key: 'binance_spot', status: r.ok ? 'ok' : 'error', detail: r.ok ? 'Reachable' : `HTTP ${r.status}`, latency: Date.now() - bsStart });
  } catch (e) {
    checks.push({ name: 'Binance Spot API', key: 'binance_spot', status: 'error', detail: e.message, latency: Date.now() - bsStart });
  }

  // 4. Binance Futures API
  const bfStart = Date.now();
  try {
    const r = await fetchBinance('https://fapi.binance.com/fapi/v1/ping', { signal: AbortSignal.timeout(5000) });
    checks.push({ name: 'Binance Futures API', key: 'binance_futures', status: r.ok ? 'ok' : 'error', detail: r.ok ? 'Reachable' : `HTTP ${r.status}`, latency: Date.now() - bfStart });
  } catch (e) {
    checks.push({ name: 'Binance Futures API', key: 'binance_futures', status: 'error', detail: e.message, latency: Date.now() - bfStart });
  }

  // 5. Telegram Bot API (only check if alerts are enabled)
  if (!settings.disableTelegram && process.env.DISABLE_TELEGRAM !== 'true') {
    const token = settings.telegramBotToken;
    const chatId = settings.telegramChatId;
    const tokenValid = token && token.length > 20 && token !== 'admin123';
    if (!tokenValid) {
      checks.push({ name: 'Telegram Bot', key: 'telegram', status: 'unconfigured', detail: 'Bot token not set — configure in Settings', latency: 0 });
    } else {
      const tgStart = Date.now();
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(5000) });
        const data = await r.json();
        if (data.ok) {
          checks.push({
            name: 'Telegram Bot',
            key: 'telegram',
            status: chatId ? 'ok' : 'warning',
            detail: `@${data.result.username}${!chatId ? ' · Chat ID not configured' : ' · Chat ID set'}`,
            latency: Date.now() - tgStart
          });
        } else {
          checks.push({ name: 'Telegram Bot', key: 'telegram', status: 'error', detail: data.description || 'Invalid token', latency: Date.now() - tgStart });
        }
      } catch (e) {
        checks.push({ name: 'Telegram Bot', key: 'telegram', status: 'error', detail: e.message, latency: Date.now() - tgStart });
      }
    }
  }

  const okCount = checks.filter(c => c.status === 'ok').length;
  const errCount = checks.filter(c => c.status === 'error').length;

  res.json({ success: true, checks, okCount, errCount, checkedAt: new Date().toISOString() });
});

app.get('/api/bot-status', async (req, res) => {
  const settings = loadSettings();
  
  let btcPrice = 65000; // default fallback
  try {
    const tickerResp = await fetchBinance('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const tickerData = await tickerResp.json();
    btcPrice = parseFloat(tickerData.price) || 65000;
  } catch (e) {
    console.error('Failed to fetch BTC price from Binance for bot-status, using default fallback:', e.message);
  }

  // Whale Trade Detector — fetch recent aggTrades and find large ones (>$500K)
  let whaleData = { 
    buyCount: 0, 
    sellCount: 0, 
    buyVol: 0, 
    sellVol: 0, 
    signal: 'NEUTRAL', 
    threshold: 500000, 
    netFlow: 0,
    wsConnected,
    wsProcessedCount: totalWsMessagesReceived,
    inMemoryTradesCount: recentWhaleTrades.length
  };
  const cutoffTime = Date.now() - 15 * 60 * 1000; // last 15 minutes
  
  // Clean up old trades
  recentWhaleTrades = recentWhaleTrades.filter(t => t.time >= cutoffTime);
  
  if (recentWhaleTrades.length > 0) {
    recentWhaleTrades.forEach(t => {
      if (t.isBuyerMaker) { // buyer was maker -> taker was seller (sell)
        whaleData.sellCount++;
        whaleData.sellVol += t.usd;
      } else { // buyer was taker (buy)
        whaleData.buyCount++;
        whaleData.buyVol += t.usd;
      }
    });
    const netFlow = whaleData.buyVol - whaleData.sellVol;
    whaleData.netFlow = netFlow;
    const whaleThreshold = 500000;
    if (netFlow > whaleThreshold * 2) whaleData.signal = 'ACCUMULATION';
    else if (netFlow < -whaleThreshold * 2) whaleData.signal = 'DISTRIBUTION';
    else whaleData.signal = 'NEUTRAL';
  } else {
    // FALLBACK: If WS is warming up or disconnected, query REST API
    try {
      const whaleThreshold = 500000; // $500K per trade
      const aggRes = await fetchBinance('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=1000', { signal: AbortSignal.timeout(4000) });
      if (aggRes.ok) {
        const aggTrades = await aggRes.json();
        aggTrades.forEach(t => {
          if (t.T < cutoffTime) return;
          const tradeUsd = parseFloat(t.p) * parseFloat(t.q);
          if (tradeUsd < whaleThreshold) return;
          if (t.m) { // buyer is maker -> taker is seller (sell)
            whaleData.sellCount++;
            whaleData.sellVol += tradeUsd;
          } else { // buyer is taker (buy)
            whaleData.buyCount++;
            whaleData.buyVol += tradeUsd;
          }
        });
        const netFlow = whaleData.buyVol - whaleData.sellVol;
        whaleData.netFlow = netFlow;
        if (netFlow > whaleThreshold * 2) whaleData.signal = 'ACCUMULATION';
        else if (netFlow < -whaleThreshold * 2) whaleData.signal = 'DISTRIBUTION';
        else whaleData.signal = 'NEUTRAL';
      }
    } catch (e) {
      console.error('[Whale Detector Fallback] Error:', e.message);
    }
  }

  res.json({
    success: true,
    btcPrice,
    whaleData,
    data: {
      ...botPhaseState,
      jdaPhase: botJdaPhaseState.phase,
      jdaAutoTradeEnabled: settings.jdaAutoTradeEnabled,
      jdaAction: jdaSignalCache ? jdaSignalCache.action : 'WAIT',
      metrics: botMetrics,
      autoTradeEnabled: settings.autoTradeEnabled,
      strategy: 'Liquidity Sweep Reversal (LSR)',
      settings: {
        minRR: settings.minRR,
        maxActive: settings.maxActive,
        sweepConfirmCandles: settings.sweepConfirmCandles || 3,
        cooldownMinutes: settings.cooldownMinutes || 60,
        minPoolVolumeRatio: settings.minPoolVolumeRatio || 0.15,
        minReversalProbability: settings.minReversalProbability || 65,
        capital: settings.capital || 1000,
        riskPercent: settings.riskPercent || 1.0
      }
    }
  });
});

// ─── Market Extras: Fear & Greed + ETF Flow ──────────────────────────────────
let fngCache = null;
let fngCacheTime = 0;

app.get('/api/market-extras', async (req, res) => {
  // 1. Fear & Greed Index (cache 1 hour — updates once/day)
  let fng = fngCache;
  if (!fng || Date.now() - fngCacheTime > 3600000) {
    try {
      const fngRes = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(5000) });
      if (fngRes.ok) {
        const fngData = await fngRes.json();
        if (fngData.data && fngData.data.length > 0) {
          fng = {
            value: parseInt(fngData.data[0].value),
            label: fngData.data[0].value_classification,
            timestamp: fngData.data[0].timestamp
          };
          fngCache = fng;
          fngCacheTime = Date.now();
        }
      }
    } catch (e) {
      console.error('[Fear&Greed] Fetch error:', e.message);
    }
  }

  // 2. ETF Flow Summary — read from existing etfDataCache (zero cost)
  let etfSummary = null;
  try {
    const etfRaw = etfDataCache;
    if (etfRaw) {
      const kpis = etfRaw.kpis || {};
      const parseUSD = (str) => {
        if (!str) return 0;
        const clean = str.replace(/[\$\+,]/g, '').trim();
        const m = clean.match(/^([+-]?[\d.]+)([KMB])?$/i);
        if (!m) return 0;
        const num = parseFloat(m[1]);
        const s = (m[2] || '').toUpperCase();
        if (s === 'K') return num * 1000;
        if (s === 'M') return num * 1000000;
        if (s === 'B') return num * 1000000000;
        return num;
      };
      const dailyUsd = kpis.dailyTotalNetInflow ? parseUSD(kpis.dailyTotalNetInflow.usd) : 0;
      const totalUsd = kpis.totalNetInflow ? parseUSD(kpis.totalNetInflow.usd) : 0;
      const gbtcBtc = etfRaw.formatted && etfRaw.formatted[0] ? (etfRaw.formatted[0].GBTC || 0) : 0;

      let etfSignal = 'NEUTRAL';
      if (dailyUsd > 50000000) etfSignal = 'BULLISH';       // > $50M daily inflow
      else if (dailyUsd < -100000000) etfSignal = 'BEARISH'; // < -$100M daily outflow
      if (gbtcBtc < -200) etfSignal = etfSignal === 'BULLISH' ? 'MIXED' : 'BEARISH'; // GBTC vampire

      etfSummary = {
        dailyUsd,
        totalUsd,
        gbtcBtc,
        signal: etfSignal,
        dailyLabel: kpis.dailyTotalNetInflow ? kpis.dailyTotalNetInflow.usd : 'N/A',
        totalLabel: kpis.totalNetInflow ? kpis.totalNetInflow.usd : 'N/A',
        lastUpdate: etfRaw.timestamp || null
      };
    }
  } catch (e) {
    console.error('[ETF Summary] Error:', e.message);
  }

  res.json({ success: true, fng, etfSummary });
});

function isTrendFilterActive(settings, botMetrics) {
  const mode = settings.htfTrendFilterMode || "OFF";
  if (mode === "ON") return true;
  if (mode === "OFF") return false;
  if (mode === "AUTO") {
    const isStrong1h = botMetrics && botMetrics.strength1h === "STRONG";
    const isStrong4h = botMetrics && botMetrics.strength4h === "STRONG";
    return isStrong1h || isStrong4h;
  }
  return false;
}

function extractTopPoolsForServer(cache, currentPrice) {
  if (!cache) return { above: [], below: [] };
  const data = cache.data?.data || cache.data || cache;
  if (!data || !data.xAxis || !data.yAxis || !data.series) return { above: [], below: [] };

  const yAxisData = data.yAxis;
  const leverageLatest = {};
  const leverageMaxRecent = {};
  
  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  if (!heatmapSeries || !heatmapSeries.data) return { above: [], below: [] };

  const latestXIdx = data.xAxis.length - 1;
  const startXIdx = Math.max(0, latestXIdx - 40);

  heatmapSeries.data.forEach(item => {
    const v = Array.isArray(item) ? item : (item.value || []);
    const xIdx = parseInt(v[0], 10);
    const yIdx = parseInt(v[1], 10);
    const val = parseFloat(v[2] || 0);
    if (!isNaN(yIdx)) {
      if (xIdx === latestXIdx) {
        leverageLatest[yIdx] = val;
      }
      if (xIdx >= startXIdx && xIdx <= latestXIdx) {
        if (!leverageMaxRecent[yIdx] || val > leverageMaxRecent[yIdx]) {
          leverageMaxRecent[yIdx] = val;
        }
      }
    }
  });

  const cs = data.series.find(s => s.type === 'candlestick');
  let maxHighRecent = currentPrice;
  let minLowRecent = currentPrice;
  if (cs && cs.data) {
    const recentCandles = cs.data.slice(-40);
    recentCandles.forEach(c => {
      const low = parseFloat(c[2]), high = parseFloat(c[3]);
      if (!isNaN(high) && high > maxHighRecent) maxHighRecent = high;
      if (!isNaN(low) && low < minLowRecent) minLowRecent = low;
    });
  }

  const levels = [];
  yAxisData.forEach((priceStr, yIdx) => {
    const price = parseFloat(priceStr);
    if (isNaN(price)) return;
    const latestVal = leverageLatest[yIdx] || 0;
    const maxRecentVal = leverageMaxRecent[yIdx] || 0;
    const isAbove = price > currentPrice;

    let isLiquidated = false;
    if (isAbove) {
      if (price <= maxHighRecent) isLiquidated = true;
    } else {
      if (price >= minLowRecent) isLiquidated = true;
    }

    let leverage = latestVal;
    if (isLiquidated && maxRecentVal > 0) {
      leverage = maxRecentVal;
    }

    if (leverage <= 0) return;
    levels.push({ price, leverage, isAbove, isLiquidated });
  });

  const activeLevels = levels.filter(l => !l.isLiquidated);
  const aboveLevels = activeLevels.filter(l => l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5);
  const belowLevels = activeLevels.filter(l => !l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5);

  return { above: aboveLevels, below: belowLevels };
}

function autoTradeStrategyBackend(heatmapData) {
  const settings = loadSettings();
  
  if (!settings.autoTradeEnabled) {
    botPhaseState = { ...botPhaseState, phase: 'DISABLED', message: 'Auto-trade is disabled', lastUpdate: new Date().toISOString() };
    return;
  }

  const cs = heatmapData.series.find(s => s.type === 'candlestick');
  if (!cs || !cs.data || cs.data.length === 0) {
    botPhaseState = { ...botPhaseState, phase: 'NO_DATA', message: 'No candlestick data available', lastUpdate: new Date().toISOString() };
    return;
  }

  const lastCandle = cs.data[cs.data.length - 1];
  const currentPrice = parseFloat(lastCandle[1]);
  if (isNaN(currentPrice)) return;

  const lastClose = currentPrice;
  const lastLow = parseFloat(lastCandle[2]);
  const lastHigh = parseFloat(lastCandle[3]);
  if (isNaN(lastLow) || isNaN(lastHigh)) return;

  const trades = loadTrades();
  const activeTrades = trades.filter(t => t.status === 'ACTIVE' && !(t.id && t.id.startsWith('T_BT_')) && !(t.note && t.note.toLowerCase().includes('backtest')));

  // Extract visible Top 5 pools for both 24H and 3D caches
  const pools24h = extractTopPoolsForServer(heatmapDataCache, currentPrice);
  const pools3d = extractTopPoolsForServer(heatmap3DCache, currentPrice);

  const visibleAbove = [...pools24h.above, ...pools3d.above];
  const visibleBelow = [...pools24h.below, ...pools3d.below];

  // Find nearest visible pool on each side
  let nearestAbove = null, nearestBelow = null;

  visibleAbove.forEach(p => {
    const distPercent = ((p.price - currentPrice) / currentPrice) * 100;
    const absDist = Math.abs(distPercent);
    if (absDist < 0.1 || absDist > settings.maxDist) return;
    if (!nearestAbove || absDist < Math.abs(nearestAbove.distance)) {
      nearestAbove = { price: p.price, distance: distPercent, volume: p.leverage };
    }
  });

  visibleBelow.forEach(p => {
    const distPercent = ((p.price - currentPrice) / currentPrice) * 100;
    const absDist = Math.abs(distPercent);
    if (absDist < 0.1 || absDist > settings.maxDist) return;
    if (!nearestBelow || absDist < Math.abs(nearestBelow.distance)) {
      nearestBelow = { price: p.price, distance: distPercent, volume: p.leverage };
    }
  });

  // ─── Step 4: Phase Detection ──────────────────────────────
  const sweepConfirmCandles = settings.sweepConfirmCandles || 3;
  const recentCandles = cs.data.slice(Math.max(0, cs.data.length - sweepConfirmCandles));
  // Historical candles for "already swept" check (older candles, NOT the recent sweep window)
  const olderCandles = cs.data.slice(Math.max(0, cs.data.length - 15), Math.max(0, cs.data.length - sweepConfirmCandles));
  
  // Determine closest pool overall
  const closestPool = [nearestAbove, nearestBelow]
    .filter(Boolean)
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0];

  if (!closestPool) {
    botPhaseState = {
      phase: activeTrades.length >= settings.maxActive ? 'MAX_ACTIVE' : 'STANDBY',
      nearestPool: null,
      nearestPoolDistance: null,
      nearestPoolVolume: null,
      nearestPoolSide: null,
      sweepCandidate: null,
      message: activeTrades.length >= settings.maxActive 
        ? `Max active trades reached (${activeTrades.length}/${settings.maxActive}). Monitoring only. No qualifying pools found.`
        : `No qualifying HIGH pools found near $${currentPrice.toFixed(0)}. Waiting...`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] STANDBY — No qualifying pools near price $${currentPrice.toFixed(0)}`);
    return;
  }

  const poolSide = closestPool.distance > 0 ? 'RESISTANCE' : 'SUPPORT';

  // Calculate preview probability using closest pool as proxy sweep candidate
  const previewSweep = {
    volume: closestPool.volume,
    rejectionStrength: 0.1, // minimal
    direction: closestPool.distance > 0 ? 'SHORT' : 'LONG',
    price: closestPool.price
  };
  const previewResult = calculateReversalProbability(
    previewSweep,
    botMetrics.oiChange15m,
    botMetrics.spotCvd15m,
    botMetrics.trend1h,
    botMetrics.trend4h,
    botMetrics.premiumRate,
    botMetrics.longShortRatio
  );
  const previewProb = previewResult.score;
  botMetrics.reversalProbability = previewProb;
  botMetrics.probabilityBreakdown = previewResult.breakdown;

  // If max active trades reached, update status and return early
  if (activeTrades.length >= settings.maxActive) {
    botPhaseState = {
      phase: 'MAX_ACTIVE',
      nearestPool: closestPool.price,
      nearestPoolDistance: closestPool.distance.toFixed(2) + '%',
      nearestPoolVolume: closestPool.volume,
      nearestPoolSide: poolSide,
      sweepCandidate: null,
      reversalProbabilityPreview: previewProb,
      probabilityBreakdown: previewResult.breakdown,
      message: `Max active trades reached (${activeTrades.length}/${settings.maxActive}). Monitoring only. Nearest ${poolSide} pool: $${closestPool.price.toFixed(0)} (${Math.abs(closestPool.distance).toFixed(2)}% away). Preview prob: ${previewProb}%.`,
      lastUpdate: new Date().toISOString()
    };
    return;
  }
  // ─── Global Exit Cooldown Check ─────────────────────────────
  const exitCooldownMs = (settings.cooldownMinutes || 60) * 60 * 1000; // Read from settings (default 60m)
  const exitCooldownTrade = trades.find(t => {
    if (t.status === 'ACTIVE') return false;
    if (!t.closeTimestamp) return false;
    const timeSinceClose = Date.now() - t.closeTimestamp;
    return timeSinceClose >= 0 && timeSinceClose < exitCooldownMs;
  });

  if (exitCooldownTrade) {
    const minutesLeft = Math.ceil((exitCooldownMs - (Date.now() - exitCooldownTrade.closeTimestamp)) / 60000);
    botPhaseState = {
      phase: 'COOLDOWN',
      nearestPool: closestPool.price,
      nearestPoolDistance: closestPool.distance.toFixed(2) + '%',
      nearestPoolVolume: closestPool.volume,
      nearestPoolSide: poolSide,
      sweepCandidate: null,
      reversalProbabilityPreview: previewProb,
      probabilityBreakdown: previewResult.breakdown,
      message: `Exit Cooldown Active: A trade was recently closed (${exitCooldownTrade.status} at ${new Date(exitCooldownTrade.closeTimestamp).toLocaleTimeString()}). New entries blocked for ${minutesLeft} more minutes.`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] COOLDOWN — Exit Cooldown active. A trade recently closed (${exitCooldownTrade.status}).`);
    return;
  }

  // ─── Step 5: Sweep Detection across recent candles ────────
  const sweepCandidates = [];
  
  // Combine all visible active pools from top lists (both 24h and 3d)
  const visiblePools = [...visibleAbove, ...visibleBelow];

  visiblePools.forEach(pObj => {
    const p = pObj.price;
    const volume = pObj.leverage;
    
    // Check if this pool was already swept by OLDER candles (stale sweep = skip)
    const alreadySweptOld = olderCandles.some(c => {
      const cLow = parseFloat(c[2]);
      const cHigh = parseFloat(c[3]);
      return p >= cLow && p <= cHigh;
    });
    if (alreadySweptOld) return;
    
    // Find the sweep candle — wick through pool with close on the reversal side
    const sweepIdx = recentCandles.findIndex(candle => {
      const cClose = parseFloat(candle[1]);
      const cLow   = parseFloat(candle[2]);
      const cHigh  = parseFloat(candle[3]);
      if (isNaN(cClose) || isNaN(cLow) || isNaN(cHigh)) return false;
      return p < currentPrice
        ? (cLow <= p && cClose > p)   // LONG: wick below pool, close above
        : (cHigh >= p && cClose < p); // SHORT: wick above pool, close below
    });

    if (sweepIdx === -1) return; // no sweep candle in window

    // Fix 2: require ≥minConfirmCandles confirmation candles AFTER the sweep candle
    const confirmCandles = recentCandles.slice(sweepIdx + 1);
    const confirmCount = confirmCandles.filter(c => {
      const close = parseFloat(c[1]);
      return p < currentPrice ? close > p : close < p;
    }).length;

    const minConfirm = settings.minConfirmCandles !== undefined ? settings.minConfirmCandles : 0;
    if (confirmCount < minConfirm) return; // price not confirmed on reversal side yet

    const sweepCandle = recentCandles[sweepIdx];
    const cClose = parseFloat(sweepCandle[1]);
    const cLow   = parseFloat(sweepCandle[2]);
    const cHigh  = parseFloat(sweepCandle[3]);

    if (p < currentPrice) {
      // Pool BELOW price: wick went down to sweep, but price closed ABOVE pool → LONG reversal
      const wickDepth = Math.abs(((cLow - p) / p) * 100);
      const rejectionStrength = Math.abs(((cClose - cLow) / cLow) * 100);
      sweepCandidates.push({
        price: p,
        volume,
        direction: 'LONG',
        distFromPrice: Math.abs(((p - currentPrice) / currentPrice) * 100),
        wickDepth,
        rejectionStrength,
        confirmCount,
        sweepLow: cLow,
        sweepHigh: cHigh,
        sweepClose: cClose,
        score: volume * (1 + rejectionStrength) * (1 + wickDepth) * (1 + confirmCount * 0.2)
      });
    } else {
      // Pool ABOVE price: wick went up to sweep, but price closed BELOW pool → SHORT reversal
      const wickDepth = Math.abs(((cHigh - p) / p) * 100);
      const rejectionStrength = Math.abs(((cHigh - cClose) / cHigh) * 100);
      sweepCandidates.push({
        price: p,
        volume,
        direction: 'SHORT',
        distFromPrice: Math.abs(((p - currentPrice) / currentPrice) * 100),
        wickDepth,
        rejectionStrength,
        confirmCount,
        sweepLow: cLow,
        sweepHigh: cHigh,
        sweepClose: cClose,
        score: volume * (1 + rejectionStrength) * (1 + wickDepth) * (1 + confirmCount * 0.2)
      });
    }
  });

  // ─── Step 6: No sweep detected → Report phase ────────────
  if (sweepCandidates.length === 0) {
    const nearDist = Math.abs(closestPool.distance);

    if (nearDist <= 0.5) {
      // ALERT phase: price is close to a major pool
      botPhaseState = {
        phase: 'ALERT',
        nearestPool: closestPool.price,
        nearestPoolDistance: closestPool.distance.toFixed(2) + '%',
        nearestPoolVolume: closestPool.volume,
        nearestPoolSide: poolSide,
        sweepCandidate: null,
        reversalProbabilityPreview: previewProb,
        probabilityBreakdown: previewResult.breakdown,
        message: `⚠️ Price $${currentPrice.toFixed(0)} approaching ${poolSide} pool at $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}% away). Preview prob: ${previewProb}%. Watching for sweep...`,
        lastUpdate: new Date().toISOString()
      };
      console.log(`[LSR Bot] ALERT — Price approaching ${poolSide} pool $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}%) Preview prob: ${previewProb}%`);
    } else {
      // STANDBY phase: price in mid-range, no qualifying sweep
      botPhaseState = {
        phase: 'STANDBY',
        nearestPool: closestPool.price,
        nearestPoolDistance: closestPool.distance.toFixed(2) + '%',
        nearestPoolVolume: closestPool.volume,
        nearestPoolSide: poolSide,
        sweepCandidate: null,
        reversalProbabilityPreview: previewProb,
        probabilityBreakdown: previewResult.breakdown,
        message: `Waiting in mid-range. Nearest ${poolSide} pool: $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}%). No sweep yet. Preview prob: ${previewProb}%.`,
        lastUpdate: new Date().toISOString()
      };
      console.log(`[LSR Bot] STANDBY — Mid-range at $${currentPrice.toFixed(0)}, nearest pool $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}%) Preview prob: ${previewProb}%`);
    }
    return;
  }

  // ─── Step 7: Sweep detected! Pick the best one ───────────
  sweepCandidates.sort((a, b) => b.score - a.score);
  const bestSweep = sweepCandidates[0];
  
  const direction = bestSweep.direction;
  const entry = currentPrice;

  // ─── Step 8: Calculate SL (ATR-based, customizable floor and multiplier) ──────
  const atrMultiplier = settings.atrMultiplier !== undefined ? settings.atrMultiplier : 2.0;
  // Enforce a strict minimum stop loss (SL) floor of 0.5% from the entry price
  const minSLPercent = Math.max(0.5, settings.minSLPercent !== undefined ? parseFloat(settings.minSLPercent) : 0.5);
  const slFloorFraction = minSLPercent / 100;

  const atr = calculateATRFromCandles(cs.data, 14);
  const minBuffer = entry * slFloorFraction;
  const atrBuffer = atr ? atr * atrMultiplier : minBuffer;
  const slBuffer  = Math.max(minBuffer, atrBuffer);

  let sl = direction === 'LONG'
    ? (bestSweep.sweepLow  - slBuffer)
    : (bestSweep.sweepHigh + slBuffer);

  let slDistance = Math.abs(((entry - sl) / entry) * 100);

  // Safety: minimum SL distance to prevent extreme leverage
  if (slDistance < minSLPercent) {
    slDistance = minSLPercent;
    sl = direction === 'LONG' ? (entry * (1 - slFloorFraction)) : (entry * (1 + slFloorFraction));
  }

  // ─── Step 9: Calculate TP (largest opposing unswept pool, capped by maxTPPercent) ──
  const maxTPPercent = settings.maxTPPercent !== undefined ? settings.maxTPPercent : 1.5;
  const maxTPDistance = entry * (maxTPPercent / 100);

  let tp = 0;
  let maxOpposingVolume = 0;
  let initialTpVolume = null;

  // Opposing visible pools
  const opposingPools = direction === 'LONG'
    ? [...pools24h.above, ...pools3d.above]
    : [...pools24h.below, ...pools3d.below];

  // 1. Search for the largest opposing unswept pool WITHIN the maxTPPercent distance
  opposingPools.forEach(pObj => {
    const p = pObj.price;
    const dist = Math.abs(p - currentPrice);
    if (dist > maxTPDistance) return; // Exceeds max distance cap

    // Pastikan pool target belum tersapu oleh semua candle
    const swept = cs.data.some(c => p >= parseFloat(c[2]) && p <= parseFloat(c[3]));
    if (swept) return;

    const volume = pObj.leverage;
    if (volume > maxOpposingVolume) {
      maxOpposingVolume = volume;
      tp = p;
      initialTpVolume = volume;
    }
  });

  // 2. Fallback if no pool found within the cap:
  if (tp === 0) {
    let uncappedTp = 0;
    let uncappedMaxVol = 0;
    opposingPools.forEach(pObj => {
      const p = pObj.price;
      const swept = cs.data.some(c => p >= parseFloat(c[2]) && p <= parseFloat(c[3]));
      if (swept) return;

      const volume = pObj.leverage;
      if (volume > uncappedMaxVol) {
        uncappedMaxVol = volume;
        uncappedTp = p;
        initialTpVolume = volume;
      }
    });

    if (uncappedTp !== 0) {
      // We found a pool but it was too far. Cap it to maxTPPercent distance.
      tp = direction === 'LONG' 
        ? (entry + maxTPDistance) 
        : (entry - maxTPDistance);
    } else {
      // Hard fallback: minRR * slDistance or maxTPPercent (whichever is larger)
      const minRR = settings.minRR || 2.0;
      const fallbackDist = Math.max(slDistance * minRR, maxTPPercent);
      tp = direction === 'LONG' 
        ? (entry * (1 + fallbackDist / 100)) 
        : (entry * (1 - fallbackDist / 100));
    }
  }

  const tpDistance = Math.abs(((tp - entry) / entry) * 100);
  const rr = parseFloat((tpDistance / slDistance).toFixed(1));

  // ─── Step 10: R:R Filter ──────────────────────────────────
  const minRR = settings.minRR || 2.0;
  if (rr < minRR) {
    botPhaseState = {
      phase: 'SWEEP_REJECTED',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
      sweepCandidate: { direction, entry, tp, sl, rr },
      message: `Sweep detected at $${bestSweep.price.toFixed(0)} but R:R ${rr} < min ${minRR}. Skipping.`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] SWEEP_REJECTED — R:R ${rr} < min ${minRR} for ${direction} at $${entry.toFixed(0)}`);
    return;
  }

  // ─── Step 10b: Reversal Probability Filter ────────────────
  const probResult = calculateReversalProbability(bestSweep, botMetrics.oiChange15m, botMetrics.spotCvd15m, botMetrics.trend1h, botMetrics.trend4h, botMetrics.premiumRate, botMetrics.longShortRatio);
  const prob = probResult.score;
  botMetrics.reversalProbability = prob; // cache the latest calculated probability for reporting
  botMetrics.probabilityBreakdown = probResult.breakdown;

  // ─── Step 10c: Hard Coinbase Premium Filter ────────────────
  const latestPremium = getLatestCoinbasePremium();
  if (latestPremium !== null) {
    const minLongPremium = settings.minCoinbasePremiumForLongs !== undefined ? parseFloat(settings.minCoinbasePremiumForLongs) : -0.05;
    const maxShortPremium = settings.maxCoinbasePremiumForShorts !== undefined ? parseFloat(settings.maxCoinbasePremiumForShorts) : 0.05;

    if (direction === 'LONG' && latestPremium < minLongPremium) {
      botPhaseState = {
        phase: 'SWEEP_REJECTED',
        nearestPool: bestSweep.price,
        nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
        nearestPoolVolume: bestSweep.volume,
        nearestPoolSide: 'SUPPORT',
        sweepCandidate: { direction, entry, tp, sl, rr, prob },
        message: `Sweep detected at $${bestSweep.price.toFixed(0)} but LONG blocked: Coinbase Premium Index ${latestPremium.toFixed(4)} < min ${minLongPremium}`,
        lastUpdate: new Date().toISOString()
      };
      console.log(`[LSR Bot] SWEEP_REJECTED — Coinbase Premium ${latestPremium.toFixed(4)} < min ${minLongPremium} for LONG at $${entry.toFixed(0)}`);
      return;
    }
    if (direction === 'SHORT' && latestPremium > maxShortPremium) {
      botPhaseState = {
        phase: 'SWEEP_REJECTED',
        nearestPool: bestSweep.price,
        nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
        nearestPoolVolume: bestSweep.volume,
        nearestPoolSide: 'RESISTANCE',
        sweepCandidate: { direction, entry, tp, sl, rr, prob },
        message: `Sweep detected at $${bestSweep.price.toFixed(0)} but SHORT blocked: Coinbase Premium Index ${latestPremium.toFixed(4)} > max ${maxShortPremium}`,
        lastUpdate: new Date().toISOString()
      };
      console.log(`[LSR Bot] SWEEP_REJECTED — Coinbase Premium ${latestPremium.toFixed(4)} > max ${maxShortPremium} for SHORT at $${entry.toFixed(0)}`);
      return;
    }
  }

  // ─── Step 10d: Strict HTF Trend Filter Override ────────────
  if (isTrendFilterActive(settings, botMetrics) && direction === 'LONG' && botMetrics.trend1h === 'BEARISH' && botMetrics.trend4h === 'BEARISH') {
    botPhaseState = {
      phase: 'SWEEP_REJECTED',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: 'SUPPORT',
      sweepCandidate: { direction, entry, tp, sl, rr, prob },
      message: `Sweep detected at $${bestSweep.price.toFixed(0)} but LONG blocked: Dominant HTF trend is BEARISH on both 1h and 4h timeframes.`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] SWEEP_REJECTED — LONG blocked by bearish HTF trend for LONG at $${entry.toFixed(0)}`);
    return;
  }
  if (isTrendFilterActive(settings, botMetrics) && direction === 'SHORT' && botMetrics.trend1h === 'BULLISH' && botMetrics.trend4h === 'BULLISH') {
    botPhaseState = {
      phase: 'SWEEP_REJECTED',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: 'RESISTANCE',
      sweepCandidate: { direction, entry, tp, sl, rr, prob },
      message: `Sweep detected at $${bestSweep.price.toFixed(0)} but SHORT blocked: Dominant HTF trend is BULLISH on both 1h and 4h timeframes.`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] SWEEP_REJECTED — SHORT blocked by bullish HTF trend for SHORT at $${entry.toFixed(0)}`);
    return;
  }

  // Check for anti-spoofing or other override force-skips
  if (probResult.forceSkip) {
    botPhaseState = {
      phase: 'SWEEP_REJECTED',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
      sweepCandidate: { 
        direction, 
        entry, 
        tp, 
        sl, 
        rr, 
        prob,
        rejectionStrength: bestSweep.rejectionStrength,
        wickDepth: bestSweep.wickDepth,
        confirmCount: bestSweep.confirmCount,
        forceSkip: probResult.forceSkip
      },
      probabilityBreakdown: probResult.breakdown,
      message: `Sweep detected at $${bestSweep.price.toFixed(0)} but force skipped: ${probResult.forceSkip}`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] FORCE_SKIP — ${probResult.forceSkip} for ${direction} at $${entry.toFixed(0)}`);
    return;
  }

  const minProb = settings.minReversalProbability || 65;
  if (prob < minProb) {
    botPhaseState = {
      phase: 'SWEEP_REJECTED',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
      sweepCandidate: { 
        direction, 
        entry, 
        tp, 
        sl, 
        rr, 
        prob,
        rejectionStrength: bestSweep.rejectionStrength,
        wickDepth: bestSweep.wickDepth,
        confirmCount: bestSweep.confirmCount
      },
      probabilityBreakdown: probResult.breakdown,
      message: `Sweep detected at $${bestSweep.price.toFixed(0)} but Reversal Prob ${prob}% < min ${minProb}%. Skipping.`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] SWEEP_REJECTED — Reversal Prob ${prob}% < min ${minProb}% for ${direction} at $${entry.toFixed(0)}`);
    return;
  }

  // ─── Step 11: Cooldown Check ──────────────────────────────
  const cooldownMs = (settings.cooldownMinutes || 60) * 60 * 1000;
  const isCooldown = trades.some(t => {
    if (t.direction !== direction) return false;
    // Parse the Indonesian locale date - use the trade ID timestamp as fallback
    const tradeTime = t.id ? parseInt(t.id.substring(1), 10) : 0;
    const timeDiffMs = Date.now() - tradeTime;
    if (isNaN(timeDiffMs) || timeDiffMs > cooldownMs) return false;
    // Similar TP target (within 0.5%)
    const tpDiff = Math.abs(t.tp - tp) / tp;
    return tpDiff < 0.005;
  });

  if (isCooldown) {
    botPhaseState = {
      phase: 'COOLDOWN',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
      sweepCandidate: { 
        direction, 
        entry, 
        tp, 
        sl, 
        rr, 
        prob,
        rejectionStrength: bestSweep.rejectionStrength,
        wickDepth: bestSweep.wickDepth,
        confirmCount: bestSweep.confirmCount
      },
      probabilityBreakdown: probResult.breakdown,
      message: `Sweep ${direction} at $${bestSweep.price.toFixed(0)} detected but in cooldown. Waiting...`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] COOLDOWN — ${direction} trade recently executed near this TP zone`);
    return;
  }

  // ─── Step 11b: Conflicting Sweep Filter ──────────────────────────────────
  // If an opposing sweep (e.g. support sweep while we want to SHORT) happened in
  // the same candle window, the market is in a "both-sides sweep" trap — skip.
  const allWindowCandles = [...olderCandles, ...recentCandles];
  const hasConflictingSweep = (direction === 'SHORT' ? visibleBelow : visibleAbove).some(pObj => {
    const p = pObj.price;
    return allWindowCandles.some(c => {
      const cLow   = parseFloat(c[2]);
      const cHigh  = parseFloat(c[3]);
      const cClose = parseFloat(c[1]);
      if (isNaN(cLow) || isNaN(cHigh) || isNaN(cClose)) return false;
      return direction === 'SHORT'
        ? (cLow <= p && cClose > p)   // support swept → bounce in progress → don't SHORT
        : (cHigh >= p && cClose < p); // resistance swept → rejection in progress → don't LONG
    });
  });

  if (hasConflictingSweep) {
    botPhaseState = {
      phase: 'CONFLICTING_SWEEP',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
      sweepCandidate: { 
        direction, 
        entry, 
        tp, 
        sl, 
        rr,
        rejectionStrength: bestSweep.rejectionStrength,
        wickDepth: bestSweep.wickDepth,
        confirmCount: bestSweep.confirmCount
      },
      message: `${direction} setup valid but conflicting ${direction === 'SHORT' ? 'SUPPORT' : 'RESISTANCE'} sweep found in same window — both-sides trap. Waiting for clean setup.`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] CONFLICTING_SWEEP — ${direction} at $${entry.toFixed(0)} rejected: opposing sweep active in window`);
    return;
  }

  // ─── Step 12: EXECUTE TRADE ───────────────────────────────
  const riskUsd = settings.capital * (settings.riskPercent / 100);
  const positionSizeUsd = riskUsd / (slDistance / 100);

  const timestamp = Date.now();
  const newTrade = {
    id: 'T' + timestamp,
    timestamp,
    time: new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction,
    tf: '15m',
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
    note: `LSR ${direction} (Swept $${bestSweep.price.toFixed(0)}, Rej: ${bestSweep.rejectionStrength.toFixed(2)}%, R:R 1:${rr}, Prob: ${prob}%)`
  };

  trades.push(newTrade);
  saveTrades(trades);

  botPhaseState = {
    phase: 'TRADE_EXECUTED',
    nearestPool: bestSweep.price,
    nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
    nearestPoolVolume: bestSweep.volume,
    nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
    sweepCandidate: { 
      direction, 
      entry: newTrade.entry, 
      tp: newTrade.tp, 
      sl: newTrade.sl, 
      rr, 
      prob,
      rejectionStrength: bestSweep.rejectionStrength,
      wickDepth: bestSweep.wickDepth,
      confirmCount: bestSweep.confirmCount
    },
    probabilityBreakdown: probResult.breakdown,
    message: `🎯 ${direction} entry at $${entry.toFixed(0)} after sweep of $${bestSweep.price.toFixed(0)} pool. R:R 1:${rr} (Prob: ${prob}%)`,
    lastUpdate: new Date().toISOString()
  };

  console.log(`[LSR Bot] 🎯 TRADE EXECUTED — ${direction} Entry:$${entry.toFixed(2)} TP:$${tp.toFixed(2)} SL:$${sl.toFixed(2)} R:R 1:${rr}`);
  console.log(`[LSR Bot]    Sweep pool: $${bestSweep.price.toFixed(2)}, Wick depth: ${bestSweep.wickDepth.toFixed(3)}%, Rejection: ${bestSweep.rejectionStrength.toFixed(3)}%`);

  // Send Telegram Alert
  sendTelegramAlert(
    `🎯 <b>LSR Trade Executed</b>\n` +
    `Strategy: <b>Liquidity Sweep Reversal</b>\n` +
    `Type: <b>${direction}</b>\n` +
    `Entry: <code>$${entry.toFixed(2)}</code>\n` +
    `TP: <code>$${tp.toFixed(2)}</code> (R:R 1:${rr})\n` +
    `SL: <code>$${sl.toFixed(2)}</code>\n` +
    `Size: <code>$${positionSizeUsd.toFixed(0)}</code> (Risk: $${riskUsd.toFixed(2)})\n` +
    `\n🔍 <b>Sweep Details:</b>\n` +
    `Pool swept: <code>$${bestSweep.price.toFixed(2)}</code>\n` +
    `Wick depth: <code>${bestSweep.wickDepth.toFixed(3)}%</code>\n` +
    `Rejection: <code>${bestSweep.rejectionStrength.toFixed(3)}%</code>\n` +
    `Pool volume: <code>${(bestSweep.volume / 1e6).toFixed(1)}M</code>\n` +
    `Note: ${newTrade.note}`
  );
}

// ─── Background 24/7 Bot Loop Worker ────────────────────────
async function fetchOrderBookLevels() {
  const now = Date.now();

  // 1. Recent 5m candles (25 bars = ~2h price context)
  const klinesRes = await fetchBinance('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=25');
  const klinesRaw = await klinesRes.json();

  // xAxis labels (time strings for ECharts category axis)
  const xAxisData = klinesRaw.map(k => {
    const d = new Date(parseInt(k[6]));
    const mo = d.toLocaleString('en-US', { month: 'short' });
    const dy = d.getDate();
    const hr = String(d.getHours()).padStart(2, '0');
    const mn = String(d.getMinutes()).padStart(2, '0');
    return mo + ' ' + dy + ', ' + hr + ':' + mn;
  });

  // Candlestick data: [open, close, low, high] per candle (ECharts format)
  const candlestickData = klinesRaw.map(k => [
    parseFloat(k[1]),  // open
    parseFloat(k[4]),  // close
    parseFloat(k[3]),  // low
    parseFloat(k[2])   // high
  ]);

  // raw candles for strategy functions [closeTime, close, low, high, open, vol]
  const candlestickRaw = klinesRaw.map(k => [
    parseInt(k[6]),
    parseFloat(k[4]),
    parseFloat(k[3]),
    parseFloat(k[2]),
    parseFloat(k[1]),
    parseFloat(k[5])
  ]);

  const currentPrice = parseFloat(klinesRaw[klinesRaw.length - 1][4]);

  // 2. Futures order book — 500 levels each side
  const depthRes = await fetchBinance('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=500');
  const depth = await depthRes.json();

  // 3. Bucket bids + asks into OB_BUCKET price increments (volume in USD)
  const volumeByBucket = {};
  [...depth.bids, ...depth.asks].forEach(([priceStr, qtyStr]) => {
    const p = parseFloat(priceStr);
    const q = parseFloat(qtyStr);
    if (!p || !q) return;
    const bucket = Math.round(p / OB_BUCKET) * OB_BUCKET;
    volumeByBucket[bucket] = (volumeByBucket[bucket] || 0) + q * p;
  });

  // 4. Boost round-number levels (00 multiples) — psychological stop clusters
  const vols = Object.values(volumeByBucket).filter(v => v > 0).sort((a, b) => a - b);
  const medianVol = vols[Math.floor(vols.length / 2)] || 0;
  const roundBase = Math.floor(currentPrice / 1000) * 1000;
  for (let offset = -4000; offset <= 4000; offset += 500) {
    const level = roundBase + offset;
    if (level > 0) {
      volumeByBucket[level] = (volumeByBucket[level] || 0) + medianVol * 0.15;
    }
  }

  // 5. Build sorted yAxis price levels
  const priceLevels = Object.keys(volumeByBucket).map(Number).filter(p => p > 0).sort((a, b) => a - b);
  const yAxisData = priceLevels.map(String);

  // 6. Build 2D heatmap: for each [candleIdx, priceIdx] → volume (static snapshot per candle)
  const maxVol = Math.max(...Object.values(volumeByBucket));
  const heatmapItems = [];
  xAxisData.forEach((_, xIdx) => {
    priceLevels.forEach((price, yIdx) => {
      const vol = volumeByBucket[price] || 0;
      if (vol > 0) heatmapItems.push([xIdx, yIdx, vol]);
    });
  });

  console.log('[OrderBook] ' + priceLevels.length + ' price levels, ' + heatmapItems.length + ' heatmap cells around $' + currentPrice.toFixed(0));

  // Return structure matching what frontend expects:
  // resObj.data.data → { series, xAxis, yAxis, visualMap }
  // resObj.data.timestamp → for cache change detection
  return {
    data: {
      series: [
        { type: 'candlestick', data: candlestickData },
        { type: 'heatmap', data: heatmapItems },
        // raw candles for strategy functions (accessed via series.find type='candlestick_raw')
        { type: 'candlestick_raw', data: candlestickRaw }
      ],
      xAxis: xAxisData,
      yAxis: yAxisData,
      visualMap: { max: maxVol }
    },
    timestamp: now,
    source: 'orderbook'
  };
}



// ─── JDA + Sweep Prediction cache vars ─────────────────────────────────────
let jdaSignalCache = null;
let sweepPredictionCache = null;


async function fetchBinance15mKlines() {
  try {
    const res = await fetchBinance('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=20');
    const raw = await res.json();
    return {
      type: 'candlestick_15m',
      data: raw.map(k => [parseInt(k[6]), parseFloat(k[4]), parseFloat(k[3]), parseFloat(k[2]), parseFloat(k[1]), parseFloat(k[5])])
    };
  } catch (e) {
    console.error('[Binance API] Error fetching 15m klines:', e.message);
    return null;
  }
}



// ─── JDA Signal (simplified — uses Binance klines for VZO-based MTF bias) ─────

// ─── JDA Signal (Pine Script JDAv85-FSVZO & ZLEMA Pro v1.1 Reference Math) ─────

function ema(arr, period) {
  const k = 2 / (period + 1);
  const result = [];
  if (arr.length === 0) return result;
  let cur = arr[0];
  result.push(cur);
  for (let i = 1; i < arr.length; i++) {
    cur = arr[i] * k + cur * (1 - k);
    result.push(cur);
  }
  return result;
}

function sma(arr, period) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) {
      result.push(arr[i]);
    } else {
      const sum = arr.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0);
      result.push(sum / period);
    }
  }
  return result;
}

function atr(highs, lows, closes, period) {
  if (closes.length === 0) return [];
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const result = [];
  let cur = tr[0];
  result.push(cur);
  const k = 1 / period;
  for (let i = 1; i < tr.length; i++) {
    cur = tr[i] * k + cur * (1 - k);
    result.push(cur);
  }
  return result;
}

function highest(arr, period) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - period + 1);
    const val = Math.max(...arr.slice(start, i + 1));
    result.push(val);
  }
  return result;
}

// ATR from candlestick data in [closeTime, close, low, high] format
function calculateATRFromCandles(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][3]);
    const low = parseFloat(candles[i][2]);
    const prevClose = parseFloat(candles[i - 1][1]);
    if (isNaN(high) || isNaN(low) || isNaN(prevClose)) continue;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period) return 0;
  const tr = [highs[0] - lows[0]];
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push((up > down && up > 0) ? up : 0);
    minusDM.push((down > up && down > 0) ? down : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const rma = (arr, len) => {
    const res = [];
    let cur = arr[0];
    res.push(cur);
    const k = 1 / len;
    for (let i = 1; i < arr.length; i++) {
      cur = arr[i] * k + cur * (1 - k);
      res.push(cur);
    }
    return res;
  };

  const str = rma(tr, period);
  const sdmPlus = rma(plusDM, period);
  const sdmMinus = rma(minusDM, period);

  const dx = [];
  for (let i = 0; i < n; i++) {
    const pDI = str[i] > 0.00001 ? (sdmPlus[i] / str[i] * 100) : 0;
    const mDI = str[i] > 0.00001 ? (sdmMinus[i] / str[i] * 100) : 0;
    const sum = pDI + mDI;
    dx.push(sum > 0.00001 ? (Math.abs(pDI - mDI) / sum * 100) : 0);
  }

  const adx = rma(dx, period);
  return adx[adx.length - 1] || 0;
}

function jda_zlema(closes, len) {
  const lag = Math.floor((len - 1) / 2);
  const data = [];
  for (let i = 0; i < closes.length; i++) {
    const val = closes[i - lag] !== undefined ? closes[i - lag] : closes[i];
    data.push(closes[i] + (closes[i] - val));
  }
  return ema(data, len);
}

function getZlemaEngine(highs, lows, closes, z_len = 34, z_mult = 1.2) {
  const zl = jda_zlema(closes, z_len);
  const _atr = atr(highs, lows, closes, z_len);
  const vol = highest(_atr, z_len * 3).map(v => v * z_mult);

  const n = closes.length;
  const status = [];
  const neutral = [];
  const above = [];
  const crossUp = [false];
  const crossDown = [false];

  for (let i = 0; i < n; i++) {
    const zlVal = zl[i];
    const volVal = vol[i];
    const closeVal = closes[i];

    const st = closeVal > zlVal + volVal ? 1 : (closeVal < zlVal - volVal ? -1 : 0);
    status.push(st);
    neutral.push(closeVal <= zlVal + volVal && closeVal >= zlVal - volVal);
    above.push(closeVal > zlVal);

    if (i > 0) {
      const prevZl = zl[i - 1];
      const prevVol = vol[i - 1];
      const prevClose = closes[i - 1];

      crossUp.push(prevClose <= prevZl + prevVol && closeVal > zlVal + volVal);
      crossDown.push(prevClose >= prevZl - prevVol && closeVal < zlVal - volVal);
    }
  }

  let trendVal = 0;
  const trend = [];
  for (let i = 0; i < n; i++) {
    if (crossUp[i]) trendVal = 1;
    else if (crossDown[i]) trendVal = -1;
    trend.push(trendVal);
  }

  return { zl, vol, crossUp, crossDown, status, neutral, above, trend };
}

function calculateZDeltaRaw(closes, volumes, trend, crossUp, crossDown) {
  const n = closes.length;
  let z_up_vol = 0;
  let z_down_vol = 0;

  for (let i = 1; i < n; i++) {
    const z_changed = (trend[i] !== trend[i - 1] && trend[i] !== 0);
    if (z_changed) {
      z_up_vol = 0;
      z_down_vol = 0;
    } else {
      const prevClose = closes[i - 1];
      const closeVal = closes[i];
      const volVal = volumes[i];

      const volume_buy = closeVal > prevClose ? volVal : (closeVal < prevClose ? 0 : volVal / 2);
      const volume_sell = closeVal < prevClose ? volVal : (closeVal > prevClose ? 0 : volVal / 2);

      z_up_vol += volume_buy;
      z_down_vol += volume_sell;
    }
  }

  const z_avg_vol = (z_up_vol + z_down_vol) / 2;
  const z_delta_raw = z_avg_vol !== 0 ? ((z_up_vol - z_down_vol) / z_avg_vol * 100) : 0;
  return z_delta_raw;
}

function calculateVZO(closes, volumes, len = 9, f_len = 31, s_len = 3) {
  const n = closes.length;
  
  const volSma = [];
  for (let i = 0; i < n; i++) {
    if (i < len - 1) {
      volSma.push(volumes[i]);
    } else {
      const sum = volumes.slice(i - len + 1, i + 1).reduce((s, x) => s + x, 0);
      volSma.push(sum / len);
    }
  }

  const relVol = volumes.map((v, i) => v / (volSma[i] || 1));
  const smoothedVol = ema(relVol, s_len);

  const changes = [0];
  for (let i = 1; i < n; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const smoothedChange = ema(changes, s_len);

  const mom = smoothedChange.map((sc, i) => sc * smoothedVol[i]);
  const smoothedMom = ema(mom, s_len);

  const posMom = ema(smoothedMom.map(m => Math.max(m, 0)), len);
  const negMom = ema(smoothedMom.map(m => Math.abs(Math.min(m, 0))), len);

  const vzoRaw = [];
  for (let i = 0; i < n; i++) {
    const ratio = negMom[i] > 0.00001 ? (posMom[i] / negMom[i]) : 1.0;
    vzoRaw.push(100.0 * (ratio - 1.0) / (ratio + 1.0));
  }

  const emaVzoS = ema(vzoRaw, s_len);
  const emaVzoF = ema(vzoRaw, f_len);
  const vzo = [];
  for (let i = 0; i < n; i++) {
    const val = emaVzoS[i] * 0.6 + emaVzoF[i] * 0.4;
    vzo.push(Math.min(Math.max(val, -100), 100));
  }

  const signal = sma(vzo, 3);
  return { vzo, signal };
}

async function fetchJDASignal() {
  try {
    const intervals = ['15m', '1h', '4h', '1d', '1w'];
    const fetchKlines = async (interval) => {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&limit=200`;
      const res = await fetchBinance(url);
      if (!res.ok) throw new Error(`HTTP error ${res.status} for ${interval}`);
      return await res.json();
    };

    const klinesList = await Promise.all(intervals.map(fetchKlines));
    const timeframes = {};

    const tfState = (v, s) => {
      if (v > 40 && v > s) return "BULL +";
      if (v > 0 && v > s) return "BULL";
      if (v < -40 && v < s) return "BEAR +";
      if (v < 0 && v < s) return "BEAR";
      return "RANGE";
    };

    const tfStr = s => (s === 'BULL +' || s === 'BEAR +') ? 'STRONG' : s === 'RANGE' ? 'WEAK' : 'MODERATE';

    const closes = {};
    const highs = {};
    const lows = {};
    const volumes = {};

    intervals.forEach((interval, idx) => {
      const klines = klinesList[idx];
      if (Array.isArray(klines)) {
        closes[interval] = klines.map(k => parseFloat(k[4]));
        highs[interval] = klines.map(k => parseFloat(k[2]));
        lows[interval] = klines.map(k => parseFloat(k[3]));
        volumes[interval] = klines.map(k => parseFloat(k[5]));
      } else {
        closes[interval] = [];
        highs[interval] = [];
        lows[interval] = [];
        volumes[interval] = [];
      }
    });

    intervals.forEach((interval) => {
      const cls = closes[interval];
      const hgs = highs[interval];
      const lws = lows[interval];
      const vls = volumes[interval];

      if (cls.length < 50) {
        timeframes[interval] = { vzo: 0, signal: 0, state: 'RANGE', trend: 0, status: 0, above: false, strength: 'WEAK', zone: 'NORMAL', neutralCount20: 0, z_delta_raw: 0 };
        return;
      }

      // Calculate VZO (9, 31, 3)
      const { vzo, signal } = calculateVZO(cls, vls, 9, 31, 3);
      const vzoVal = vzo[vzo.length - 1];
      const sigVal = signal[signal.length - 1];

      // Calculate ZLEMA Engine (34, 1.2)
      const { zl, vol, crossUp, crossDown, status, neutral, above, trend } = getZlemaEngine(hgs, lws, cls, 34, 1.2);
      const currentStatus = status[status.length - 1];
      const currentAbove = above[above.length - 1];
      
      let trendVal = currentStatus;
      if (currentStatus === 0) {
        trendVal = currentAbove ? 1 : -1;
      }

      const neutralCount20 = neutral.slice(-20).filter(x => x).length;

      // Calculate Z Delta Raw
      const z_delta_raw = calculateZDeltaRaw(cls, vls, trend, crossUp, crossDown);

      timeframes[interval] = {
        vzo: Math.round(vzoVal * 10) / 10,
        signal: Math.round(sigVal * 10) / 10,
        state: tfState(vzoVal, sigVal),
        trend: trendVal,
        status: currentStatus,
        above: currentAbove,
        strength: tfStr(tfState(vzoVal, sigVal)),
        zone: vzoVal > 60 ? 'OB' : (vzoVal < -60 ? 'OS' : 'NORMAL'),
        neutralCount20,
        z_delta_raw
      };
    });

    const v15 = timeframes['15m'].vzo;
    const s15 = timeframes['15m'].signal;
    const v1h = timeframes['1h'].vzo;
    const s1h = timeframes['1h'].signal;
    const v4h = timeframes['4h'].vzo;
    const v1d = timeframes['1d'].vzo;
    const vw = timeframes['1w'].vzo;

    // CONFIDENCE & PHASE DETECTION (JDA Weights Engine)
    const total_w = 0.50 + 0.30 + 0.10 + 0.05 + 0.05; // 1.0
    const dirScore = v15 * 0.50 + v1h * 0.30 + v4h * 0.10 + v1d * 0.05 + vw * 0.05;
    let conf = Math.min(Math.abs(dirScore), 100);
    const aligned = (v15 > 0 && v4h > 0) || (v15 < 0 && v4h < 0);

    const zb4h = timeframes['4h'].neutralCount20;
    let phase_text = "NEUTRAL";
    if (zb4h >= 15) {
      phase_text = "SQUEEZE";
    } else if (v4h > 40) {
      phase_text = "STRONG BULL TREND";
    } else if (v4h < -40) {
      phase_text = "STRONG BEAR TREND";
    }

    if (!aligned) {
      conf = conf * (phase_text === "SQUEEZE" ? 0.9 : phase_text === "NEUTRAL" ? 0.75 : 0.6);
    }

    const confLevel = conf >= 65 ? "HIGH" : (conf >= 60 ? "MEDIUM" : "LOW");
    const bias = v4h > 10 ? "BULLISH" : (v4h < -10 ? "BEARISH" : "NEUTRAL");

    // FILTERS
    // 4H EMA 50
    const ema4h_50 = ema(closes['4h'], 50);
    const ema200_htf_val = ema4h_50[ema4h_50.length - 1];
    
    // We assume current close is 15m close
    const closes15m = closes['15m'];
    const currentPrice = closes15m[closes15m.length - 1];

    const ema200_long_ok = currentPrice > ema200_htf_val;
    const ema200_short_ok = currentPrice < ema200_htf_val;

    // ADX on 15M
    const adx_val = calculateADX(highs['15m'], lows['15m'], closes15m, 14);
    const adx_ok = adx_val >= 25;

    // EMA 13 and SMA 50 on 15M
    const ema15m_13 = ema(closes15m, 13);
    const sma15m_50 = sma(closes15m, 50);
    const cross_long_ok = ema15m_13[ema15m_13.length - 1] > sma15m_50[sma15m_50.length - 1];
    const cross_short_ok = ema15m_13[ema15m_13.length - 1] < sma15m_50[sma15m_50.length - 1];

    // Reversal trigger conditions: 1H VZO crossover
    const { vzo: vzoHist1h, signal: sigHist1h } = calculateVZO(closes['1h'], volumes['1h'], 9, 31, 3);
    const len1h = vzoHist1h.length;
    const crossUpVzo1h = len1h >= 2 && vzoHist1h[len1h - 1] > sigHist1h[len1h - 1] && vzoHist1h[len1h - 2] <= sigHist1h[len1h - 2];
    const crossDnVzo1h = len1h >= 2 && vzoHist1h[len1h - 1] < sigHist1h[len1h - 1] && vzoHist1h[len1h - 2] >= sigHist1h[len1h - 2];

    const currentLow15m = lows['15m'][lows['15m'].length - 1];
    const currentHigh15m = highs['15m'][highs['15m'].length - 1];
    const ema15m_20 = ema(closes15m, 20);
    const currentEma20_15m = ema15m_20[ema15m_20.length - 1];

    const no_squeeze = phase_text !== "SQUEEZE";

    const rev_long = v1h < -50 && crossUpVzo1h && currentLow15m <= currentEma20_15m && v4h < 0 && conf >= 60 && no_squeeze && ema200_long_ok && adx_ok && cross_long_ok;
    const rev_short = v1h > 50 && crossDnVzo1h && currentHigh15m >= currentEma20_15m && v4h > 0 && conf >= 60 && no_squeeze && ema200_short_ok && adx_ok && cross_short_ok;

    const z_delta_raw = timeframes['15m'].z_delta_raw;
    const tf_long = v15 > s15 && dirScore > 0 && conf >= 60 && z_delta_raw > 0 && v4h > 0 && no_squeeze && ema200_long_ok && adx_ok && cross_long_ok;
    const tf_short = v15 < s15 && dirScore < 0 && conf >= 60 && z_delta_raw < 0 && v4h < 0 && no_squeeze && ema200_short_ok && adx_ok && cross_short_ok;

    let action = "WAIT";
    if (rev_long) {
      action = "LONG (REVERSAL)";
    } else if (rev_short) {
      action = "SHORT (REVERSAL)";
    } else if (tf_long) {
      action = "LONG";
    } else if (tf_short) {
      action = "SHORT";
    }

    const is_ct = (action === "LONG" && v4h < 0) || (action === "SHORT" && v4h > 0);
    const mode_display = "BOTH" + (conf >= 65 ? " | HIGH CONF" : (conf >= 60 ? " | MED CONF" : " | LOW CONF"));
    const finalCall = action === "WAIT" ? ("WAIT — Conf: " + Math.round(conf) + "% (" + confLevel + ")") : (action + (is_ct ? " (COUNTER)" : " (TREND)") + " | " + mode_display);

    return {
      timeframes,
      dirScore: Math.round(dirScore * 10) / 10,
      conf: Math.round(conf),
      confLevel,
      phase: phase_text,
      marketBias: bias,
      action,
      aligned,
      finalCall,
      emaFilter: { value: Math.round(ema200_htf_val), status: currentPrice > ema200_htf_val ? "ABOVE ✅" : "BELOW 🚫" },
      adxFilter: { value: Math.round(adx_val * 10) / 10, status: adx_ok ? "TRENDING ✅" : "CHOPPY 🚫" },
      crossFilter: { status: cross_long_ok ? "GOLDEN ✅" : "DEATH 🚫" },
      fetchTime: Date.now()
    };
  } catch (e) {
    console.error('[JDA] Error:', e.stack || e.message);
    return {
      timeframes: {
        '15m': { vzo: 0, state: 'RANGE', trend: 0, status: -1, above: false, strength: 'WEAK', zone: 'NORMAL' },
        '1h': { vzo: 0, state: 'RANGE', trend: 0, status: -1, above: false, strength: 'WEAK', zone: 'NORMAL' },
        '4h': { vzo: 0, state: 'RANGE', trend: 0, status: -1, above: false, strength: 'WEAK', zone: 'NORMAL' },
        '1d': { vzo: 0, state: 'RANGE', trend: 0, status: -1, above: false, strength: 'WEAK', zone: 'NORMAL' },
        '1w': { vzo: 0, state: 'RANGE', trend: 0, status: -1, above: false, strength: 'WEAK', zone: 'NORMAL' }
      },
      dirScore: 0,
      conf: 0,
      phase: 'NEUTRAL',
      marketBias: 'NEUTRAL',
      action: 'WAIT',
      fetchTime: Date.now()
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SWEEP PREDICTION ENGINE
// ════════════════════════════════════════════════════════════════════════════
function predictSweepTargets(heatmapData, metrics) {
  try {
    if (!heatmapData || !heatmapData.series) return null;
    const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');
    const candleSeries  = heatmapData.series.find(s => s.type === 'candlestick_raw')
                       || heatmapData.series.find(s => s.type === 'candlestick');
    if (!heatmapSeries || !candleSeries || !candleSeries.data.length) return null;
    const yAxisData = heatmapData.yAxis || [];
    const lastCandle = candleSeries.data[candleSeries.data.length - 1];
    const currentPrice = parseFloat(lastCandle[1]);
    if (!currentPrice || isNaN(currentPrice)) return null;

    const latestXIdx = heatmapData.xAxis.length - 1;
    const volumeByY = {};
    heatmapSeries.data.forEach(item => {
      const v = Array.isArray(item) ? item : (item.value || []);
      const xIdx = parseInt(v[0], 10);
      const yIdx = parseInt(v[1], 10);
      const val  = parseFloat(v[2] || 0);
      if (!isNaN(yIdx) && xIdx === latestXIdx && val > 0) {
        volumeByY[yIdx] = val;
      }
    });

    const pools = [];
    yAxisData.forEach((priceStr, idx) => {
      const price  = parseFloat(priceStr);
      if (isNaN(price)) return;

      const volume = volumeByY[idx] || 0;
      if (!price || volume === 0) return;
      const dist    = ((price - currentPrice) / currentPrice) * 100;
      const absDist = Math.abs(dist);
      if (absDist < 0.05 || absDist > 10) return;
      pools.push({ price, volume, dist, absDist, side: price > currentPrice ? 'RESISTANCE' : 'SUPPORT' });
    });
    if (pools.length === 0) return null;

    const allVols = pools.map(p => p.volume).sort((a, b) => b - a);
    const minVol  = allVols[Math.floor(allVols.length * 0.15)] || 0;
    const quality = pools.filter(p => p.volume >= minVol);
    const resistance = quality.filter(p => p.side === 'RESISTANCE').sort((a, b) => a.absDist - b.absDist);
    const support    = quality.filter(p => p.side === 'SUPPORT').sort((a, b) => a.absDist - b.absDist);

    let upBias = 1.0, downBias = 1.0;
    const cvd      = metrics.spotCvd1h || 0;
    const funding  = parseFloat(metrics.fundingRate) || 0;
    const lsRatio  = parseFloat(metrics.longShortRatio) || 1.5;
    const topRatio = parseFloat(metrics.topTraderRatio) || lsRatio;
    const jdaV1h   = metrics.jdaV1h || 0;
    const jdaV4h   = metrics.jdaV4h || 0;

    if (cvd > 0) upBias *= 1.25; else downBias *= 1.25;
    if (funding > 0.0002) downBias *= 1.20; else if (funding < -0.0002) upBias *= 1.20;
    if (lsRatio > 1.8) downBias *= 1.30; else if (lsRatio < 1.2) upBias *= 1.20;
    if (topRatio < lsRatio - 0.2) downBias *= 1.15; else if (topRatio > lsRatio + 0.2) upBias *= 1.15;
    if (jdaV1h > 20) upBias *= 1.20; else if (jdaV1h < -20) downBias *= 1.20;
    if (jdaV4h > 10) upBias *= 1.10; else if (jdaV4h < -10) downBias *= 1.10;

    const scorePool = p => (p.volume / Math.pow(p.absDist, 1.5)) * (p.side === 'RESISTANCE' ? upBias : downBias);
    const scored = quality.map(p => ({ ...p, score: scorePool(p) })).sort((a, b) => b.score - a.score);
    const hotPool = scored[0] || null;
    const cascadePool = hotPool ? scored.filter(p => p.side === hotPool.side && Math.abs(p.price - hotPool.price) > 1).sort((a,b) => a.absDist - b.absDist)[0] : null;

    const upScore   = resistance.reduce((s, p) => s + scorePool(p), 0);
    const downScore = support.reduce((s, p) => s + scorePool(p), 0);
    const total     = upScore + downScore || 1;
    const upProb    = Math.round((upScore / total) * 100);
    const downProb  = 100 - upProb;

    const reasons = [];
    if (cvd > 500000) reasons.push('CVD Futures +' + (cvd/1e6).toFixed(1) + 'M');
    else if (cvd < -500000) reasons.push('CVD Futures ' + (cvd/1e6).toFixed(1) + 'M');
    if (funding > 0.0002) reasons.push('Funding +' + (funding*100).toFixed(4) + '%');
    else if (funding < -0.0002) reasons.push('Funding ' + (funding*100).toFixed(4) + '%');
    if (lsRatio > 1.8) reasons.push('L/S ' + lsRatio.toFixed(2) + ' → long crowded');
    if (jdaV1h > 20) reasons.push('VZO 1H BULL+ (' + jdaV1h.toFixed(0) + '%)');
    else if (jdaV1h < -20) reasons.push('VZO 1H BEAR+ (' + jdaV1h.toFixed(0) + '%)');

    const fmt = p => p ? { price: Math.round(p.price), volume: Math.round(p.volume / 1e6), distPct: p.dist.toFixed(2) + '%', side: p.side } : null;
    return {
      direction: upProb >= downProb ? 'UP' : 'DOWN',
      upProb, downProb,
      confidence: Math.max(upProb, downProb),
      hotPool: fmt(hotPool),
      cascadePool: fmt(cascadePool),
      nearestResistance: fmt(resistance[0]),
      nearestSupport: fmt(support[0]),
      reasons,
      currentPrice: Math.round(currentPrice),
      timestamp: Date.now()
    };
  } catch(e) {
    console.error('[SweepPredict] Error:', e.message);
    return null;
  }
}

async function runBotCycle() {
  if (isHeatmapScrapingBusy) {
    console.log('[Background Bot] Scrape already in progress, skipping background cycle.');
    return;
  }

  isHeatmapScrapingBusy = true;
  try {
    const settings = loadSettings();
    console.log('[Background Bot] Running scheduled scraper and trade evaluation cycle...');
    
    // Fetch Binance Metrics in parallel to save time
    const results = await Promise.allSettled([
      fetchBinanceOI(),
      fetchBinanceSpotCVD(),
      fetchJDASignal(),
      fetchBinanceFundingRate(),
      fetchBinanceLongShortRatio(),
      fetchBinance15mKlines()
    ]);
        const val = (i, def) => results[i].status === 'fulfilled' ? results[i].value : def;
    const oiData     = val(0, { currentOI: 0, currentOIVal: 0, oiChange1h: 0, oiChange15m: 0 });
    const cvdVal     = val(1, { cvd1h: 0, cvd15m: 0 });
    const jdaSig     = val(2, null);
    const fundingData = val(3, { fundingRate: 0, premiumRate: 0 });
    const lsRatioData = val(4, { ratio: 1.0, long: 0.5, short: 0.5, topRatio: 1.0, topLong: 0.5, topShort: 0.5 });
    const klines15m  = val(5, null);
    if (jdaSig) jdaSignalCache = jdaSig;
    const failedCalls = results.filter(r => r.status === 'rejected').length;
    if (failedCalls > 0) console.log('[Background Bot] ' + failedCalls + ' API call(s) failed, continuing with available data.');
    
    botMetrics = {
      ...botMetrics,
      openInterest: oiData.currentOIVal,
      openInterestBtc: oiData.currentOI,
      oiChange1h: oiData.oiChange1h,
      oiChange15m: oiData.oiChange15m || 0,
      spotCvd1h: cvdVal.cvd1h || 0,
      spotCvd15m: cvdVal.cvd15m || 0,
      spotCvdFutures: 0,
      spotCvdSpot: cvdVal.cvd1h || 0,
      // JDA MTF engine replaces EMA20/50 — VZO + ZLEMA based trend
      trend1h: (jdaSig?.timeframes?.['1h']?.state || '').includes('BULL') ? 'BULLISH' : (jdaSig?.timeframes?.['1h']?.state || '').includes('BEAR') ? 'BEARISH' : 'RANGING',
      trend4h: (jdaSig?.timeframes?.['4h']?.state || '').includes('BULL') ? 'BULLISH' : (jdaSig?.timeframes?.['4h']?.state || '').includes('BEAR') ? 'BEARISH' : 'RANGING',
      strength1h: (jdaSig?.timeframes?.['1h']?.state === 'BULL+' || jdaSig?.timeframes?.['1h']?.state === 'BEAR+') ? 'STRONG' : jdaSig?.timeframes?.['1h']?.state === 'RANGE' ? 'WEAK' : 'MODERATE',
      strength4h: (jdaSig?.timeframes?.['4h']?.state === 'BULL+' || jdaSig?.timeframes?.['4h']?.state === 'BEAR+') ? 'STRONG' : jdaSig?.timeframes?.['4h']?.state === 'RANGE' ? 'WEAK' : 'MODERATE',
      // Probability score from JDA VZO — normalized ±10 (replaces EMA-based score)
      score1h: Math.min(10, Math.max(-10, (jdaSig?.timeframes?.['1h']?.vzo || 0) / 10)),
      score4h: Math.min(10, Math.max(-10, (jdaSig?.timeframes?.['4h']?.vzo || 0) / 10)),
      // JDA-specific fields for HTF filter and display
      jdaV15m:      jdaSig?.timeframes?.['15m']?.vzo || 0,
      jdaV1h:       jdaSig?.timeframes?.['1h']?.vzo  || 0,
      jdaV4h:       jdaSig?.timeframes?.['4h']?.vzo  || 0,
      jdaV1d:       jdaSig?.timeframes?.['1d']?.vzo  || 0,
      jdaV1w:       jdaSig?.timeframes?.['1w']?.vzo  || 0,
      jdaZlema1h:   jdaSig?.timeframes?.['1h']?.trend || 0,
      jdaZlema4h:   jdaSig?.timeframes?.['4h']?.trend || 0,
      jdaPhase:     jdaSig?.phase,
      jdaConf:      jdaSig?.conf,
      jdaMarketBias: jdaSig?.marketBias,
      jdaAction:    jdaSig?.action,
      jdaDirScore:  jdaSig?.dirScore,
      fundingRate: fundingData.fundingRate,
      premiumRate: fundingData.premiumRate || 0,
      longShortRatio: lsRatioData.ratio,
      longAccount: lsRatioData.long,
      shortAccount: lsRatioData.short,
      topTraderRatio: lsRatioData.topRatio || lsRatioData.ratio,
      topTraderLong: lsRatioData.topLong || lsRatioData.long,
      topTraderShort: lsRatioData.topShort || lsRatioData.short
    };
    // Compute sweep prediction from cached heatmap data whenever metrics update
    if (heatmapDataCache) {
      const _hd = heatmapDataCache.data || heatmapDataCache;
      const _hd2 = (_hd && _hd.data) ? _hd.data : _hd;
      sweepPredictionCache = predictSweepTargets(_hd2, botMetrics);
      if (sweepPredictionCache) console.log('[SweepPredict] Updated from cache:', sweepPredictionCache.direction, sweepPredictionCache.confidence + '%', 'Hot:$' + (sweepPredictionCache.hotPool ? sweepPredictionCache.hotPool.price : 'none'));
    }
    botMetrics = { ...botMetrics
    };

    const isScraperEnabled = !settings.disableScraper && process.env.DISABLE_SCRAPER !== 'true';
    let result = heatmapDataCache;

    if (isScraperEnabled) {
      try {
        result = await runWithCdpLock(() => scrapeHeatMap(true)); // force refresh to get latest data from CoinGlass!
        heatmapDataCache = cleanSweptLevels(result);
        lastHeatmapFetchTime = Date.now();
        saveCacheToDisk('heatmap24h_cache.json', heatmapDataCache);
      } catch (scrapeErr) {
        console.warn('[Background Bot] CoinGlass scrape failed, trying fallback to cached data:', scrapeErr.message);
        if (heatmapDataCache) {
          result = heatmapDataCache;
        } else {
          throw new Error('No heatmap data available (scrape failed and no cache exists)');
        }
      }
    } else {
      console.log('[Background Bot] Scraper is disabled. Using pushed heatmap cache.');
    }

    if (result && result.data) {
      if (isScraperEnabled) {
        // Run evaluations and strategy only on local instance (master mode)
        evaluateActiveTradesBackend(result.data, klines15m);
        evaluateActiveJdaTradesBackend(result.data);
        const oldPhase = botPhaseState?.phase;
        autoTradeStrategyBackend(result.data, klines15m);
        autoJdaTradeStrategyBackend(result.data, klines15m);
        const newPhase = botPhaseState?.phase;
        setBotPhaseState(botPhaseState, oldPhase);

        // Push bot phase state, metrics, and sweep history to VPS
        pushToVps('/api/bot-phase/update', {
          botPhaseState,
          botMetrics: {
            reversalProbability: botMetrics.reversalProbability,
            probabilityBreakdown: botMetrics.probabilityBreakdown
          },
          sweepHistory
        }).catch(err => console.error('[VPS Push] Failed to push bot phase:', err.message));

        if (lastTelegramPhase === null) {
          lastTelegramPhase = oldPhase || 'INITIALIZING';
        }

        if (newPhase && newPhase !== lastTelegramPhase) {
          const prevPhase = lastTelegramPhase;
          lastTelegramPhase = newPhase;

          // Skip TRADE_EXECUTED because it sends its own custom detailed alert
          if (newPhase !== 'TRADE_EXECUTED') {
            let shouldAlert = false;
            let icon = '🔔';

            if (newPhase === 'ALERT') {
              shouldAlert = true;
              icon = '⚠️';
            } else if (newPhase === 'SWEEP_REJECTED') {
              shouldAlert = true;
              icon = '⚙️';
            } else if (newPhase === 'COOLDOWN') {
              shouldAlert = true;
              icon = '⏳';
            } else if (newPhase === 'DISABLED') {
              shouldAlert = true;
              icon = '🔴';
            } else if (newPhase === 'MAX_ACTIVE') {
              shouldAlert = true;
              icon = '🔒';
            } else if (newPhase === 'STANDBY') {
              // Only notify returning to standby if we were previously in an active alert/cooldown/rejected state
              if (prevPhase === 'ALERT' || prevPhase === 'COOLDOWN' || prevPhase === 'SWEEP_REJECTED') {
                shouldAlert = true;
                icon = '🟢';
              }
            }

            if (shouldAlert) {
              sendTelegramAlert(
                `${icon} <b>LSR Bot Status: ${newPhase}</b>\n` +
                `────────────────────\n` +
                `${botPhaseState.message}`
              );
            }
          }
        }
      } else {
        console.log('[Background Bot] Running in view-only mode on VPS. Skipping trade evaluations and strategy.');
      }
      const _sweepInput = result.data.data || result.data;
      console.log('[SweepPredict] Input series:', _sweepInput && _sweepInput.series ? _sweepInput.series.length : 'NO_SERIES', 'yAxis:', _sweepInput && _sweepInput.yAxis ? _sweepInput.yAxis.length : 0);
      sweepPredictionCache = predictSweepTargets(_sweepInput, botMetrics);
      console.log('[SweepPredict] Result:', sweepPredictionCache ? sweepPredictionCache.direction + ' ' + sweepPredictionCache.confidence + '%' : 'NULL');
    } else {
      console.log('[Background Bot] No heatmap data cache available. Skipping trade evaluations.');
    }

    // Scrape 3D heatmap in background after main cycle
    if (isScraperEnabled) {
      try {
        const r3d = await runWithCdpLock(() => scrapeHeatMap3D());
        if (r3d.period === '3d') {
          heatmap3DCache = cleanSweptLevels(r3d);
          lastHeatmap3DFetchTime = Date.now();
          const hd3 = heatmap3DCache.data;
          if (hd3) {
            if (!hd3.series) hd3.series = [];
            if (!hd3.series.some(s => s.type === 'candlestick' || s.type === 'candlestick_raw')) {
              const mainData = heatmapDataCache?.data?.data || heatmapDataCache?.data || heatmapDataCache;
              const cs2d = mainData?.series?.find(s => s.type === 'candlestick' || s.type === 'candlestick_raw');
              if (cs2d) hd3.series.push(cs2d);
            }
          }
          sweepPrediction3DCache = predictSweepTargets(hd3, botMetrics);
          console.log('[Heatmap3D] OK. Sweep3D:', sweepPrediction3DCache ? sweepPrediction3DCache.direction + ' ' + sweepPrediction3DCache.confidence + '%' : 'NULL');
          saveCacheToDisk('heatmap3d_cache.json', heatmap3DCache);
        } else {
          console.warn('[Heatmap3D] Period switch to 3D failed (got 24h-fallback), skipping cache update to avoid polluting 3D data.');
        }
      } catch(e) {
        console.error('[Heatmap3D] Error:', e.message);
        if (heatmap3DCache) {
          try {
            const hd3 = heatmap3DCache.data?.data || heatmap3DCache.data || heatmap3DCache;
            if (hd3) {
              if (!hd3.series) hd3.series = [];
              if (!hd3.series.some(s => s.type === 'candlestick' || s.type === 'candlestick_raw')) {
                const mainData = heatmapDataCache?.data?.data || heatmapDataCache?.data || heatmapDataCache;
                const cs2d = mainData?.series?.find(s => s.type === 'candlestick' || s.type === 'candlestick_raw');
                if (cs2d) hd3.series.push(cs2d);
              }
            }
            sweepPrediction3DCache = predictSweepTargets(hd3, botMetrics);
            console.log('[Heatmap3D] Updated Sweep3D from cache fallback:', sweepPrediction3DCache ? sweepPrediction3DCache.direction + ' ' + sweepPrediction3DCache.confidence + '%' : 'NULL');
          } catch (fallbackErr) {
            console.error('[Heatmap3D] Fallback Sweep3D computation failed:', fallbackErr.message);
          }
        }
      }
    } else {
      // Re-compute 3D prediction from cache if we have it
      if (heatmap3DCache) {
        try {
          const hd3 = heatmap3DCache.data?.data || heatmap3DCache.data || heatmap3DCache;
          sweepPrediction3DCache = predictSweepTargets(hd3, botMetrics);
          console.log('[Heatmap3D] Re-computed Sweep3D from pushed cache:', sweepPrediction3DCache ? sweepPrediction3DCache.direction + ' ' + sweepPrediction3DCache.confidence + '%' : 'NULL');
        } catch (err) {
          console.error('[Heatmap3D] Failed to compute Sweep3D from cache:', err.message);
        }
      }
    }

    // Scrape Coinbase Premium, Depth Delta, and Whale Orders sequentially in background
    if (isScraperEnabled) {
      try {
        console.log('[Background Bot] Running scheduled Coinbase Premium scrape...');
        const rPremium = await runWithCdpLock(() => scrapeCoinbasePremium());
        cbPremiumCache = rPremium;
        lastCbPremiumFetchTime = Date.now();
        saveCacheToDisk('cb_premium_cache.json', cbPremiumCache);
      } catch (e) {
        console.error('[Background Bot] Coinbase Premium scrape error:', e.message);
      }

      try {
        console.log('[Background Bot] Running scheduled Depth Delta scrape...');
        const rDelta = await runWithCdpLock(() => scrapeDepthDelta());
        depthDeltaCache = rDelta;
        lastDepthDeltaFetchTime = Date.now();
        saveCacheToDisk('depth_delta_cache.json', depthDeltaCache);
      } catch (e) {
        console.error('[Background Bot] Depth Delta scrape error:', e.message);
      }

      try {
        console.log('[Background Bot] Running scheduled Whale Orders scrape...');
        const rWhales = await runWithCdpLock(() => scrapeWhaleOrders());
        whaleOrdersCache = rWhales;
        lastWhaleOrdersFetchTime = Date.now();
        saveCacheToDisk('whale_orders_cache.json', whaleOrdersCache);
      } catch (e) {
        console.error('[Background Bot] Whale Orders scrape error:', e.message);
      }

      try {
        console.log('[Background Bot] Running scheduled Whale vs Retail Delta scrape...');
        const rWhaleDelta = await runWithCdpLock(() => scrapeWhaleRetailDelta());
        whaleRetailDeltaCache = rWhaleDelta;
        lastWhaleRetailDeltaFetchTime = Date.now();
        saveCacheToDisk('whale_retail_delta_cache.json', whaleRetailDeltaCache);
      } catch (e) {
        console.error('[Background Bot] Whale vs Retail Delta scrape error:', e.message);
      }

      try {
        console.log('[Background Bot] Running scheduled Top Trader Long/Short scrape...');
        const rTopTrader = await runWithCdpLock(() => scrapeTopTraderLs());
        topTraderLsCache = rTopTrader;
        lastTopTraderLsFetchTime = Date.now();
        saveCacheToDisk('top_trader_ls_cache.json', topTraderLsCache);
      } catch (e) {
        console.error('[Background Bot] Top Trader Long/Short scrape error:', e.message);
      }
    }

    console.log('[Background Bot] Cycle completed successfully. Metrics:', JSON.stringify(botMetrics));
  } catch (error) {
    console.error('[Background Bot] Cycle error:', error.message);
  } finally {
    isHeatmapScrapingBusy = false;
  }
}

async function startBackgroundBot() {
  const settings = loadSettings();
  const isScraperEnabled = !settings.disableScraper && process.env.DISABLE_SCRAPER !== 'true';

  if (isScraperEnabled) {
    console.log('Background bot cycle scheduler started. Running every 30 seconds.');
  } else {
    console.log('Background bot cycle scheduler started (Query/REST-only mode). Running every 30 seconds.');
  }
  
  // Run once immediately on startup
  setTimeout(async () => {
    await runBotCycle();
  }, 5000); // 5 seconds grace period after boot

  setInterval(async () => {
    await runBotCycle();
  }, 30000); // 30 seconds
}

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`JDA Trade Monitor Dashboard listening at http://localhost:${PORT}`);
  console.log(`Make sure Chrome is running with remote debugging`);
  console.log(`on port 9222 before triggering a refresh.`);
  console.log(`==================================================`);

  // Start background bot 24/7 worker
  startBackgroundBot().catch(e => console.error('Failed to start background bot:', e));

  // Trigger initial sync of trades to VPS on startup
  try {
    const initialTrades = loadTrades();
    pushToVps('/api/trades/sync', { trades: initialTrades }).catch(console.error);
    const initialJdaTrades = loadJdaTrades();
    pushToVps('/api/jda-trades/sync', { trades: initialJdaTrades }).catch(console.error);
  } catch (err) {
    console.error('Failed to trigger initial sync:', err.message);
  }

  // Warm-up ETF cache 90s after start (after first heatmap scrape finishes)
  setTimeout(async () => {
    const settings = loadSettings();
    if (settings.disableScraper || process.env.DISABLE_SCRAPER === 'true') {
      console.log('[ETF] Scraper is disabled, skipping ETF cache warm-up.');
      return;
    }
    if (!etfDataCache) {
      console.log('[ETF] Warming up cache...');
      try {
        const tickerResp = await fetchBinance('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
        const tickerData = await tickerResp.json();
        const btcPrice = parseFloat(tickerData.price) || 65000;
        const result = await scrapeCoinGlass('/etf/bitcoin', false);
        etfDataCache = result;
        lastFetchTime = Date.now();
        saveCacheToDisk('etf_cache.json', etfDataCache);
        console.log('[ETF] Cache warmed up successfully.');

        // Send initial ETF alerts to Telegram on warm-up
        const etfAlertInfo = buildEtfAlerts(result, btcPrice);
        if (etfAlertInfo) {
          lastEtfAlertState = etfAlertInfo.stateKey;
          if (etfAlertInfo.stateKey !== 'stable') {
            const header = `📊 <b>ETF Monitor Started</b>\n${'─'.repeat(20)}\n`;
            sendTelegramAlert(header + etfAlertInfo.alerts.join('\n\n'));
            console.log(`[ETF Alert] Initial state: ${etfAlertInfo.stateKey}`);
          } else {
            console.log(`[ETF Alert] Initial state: stable (alert suppressed to avoid spam)`);
          }
        }
      } catch (e) { console.error('[ETF] Warm-up failed:', e.message); }
    }
  }, 90000);
});

// Auto-Deploy Validation Check: Pushed by Antigravity at 2026-06-20 17:01 (Test)
