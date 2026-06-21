import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.use(express.json());

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
  const PUBLIC_PATHS = ['/login', '/auth/login', '/auth/logout', '/api/tradingview/webhook'];
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

// Login page route
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
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

// Page-specific scraping locks
let isEtfScrapingBusy = false;
let isHeatmapScrapingBusy = false;

// Serial queue/mutex for Chrome remote debugging (CDP) interactions
let cdpMutex = Promise.resolve();

async function runWithCdpLock(fn) {
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

// Heatmap 3D cache
let heatmap3DCache = null;
let lastHeatmap3DFetchTime = null;
let sweepPrediction3DCache = null;



// ─── Heatmap 3D Scraper ──────────────────────────────────────────────────────
// Uses the existing CoinGlass tab; navigates to heatmap and selects "3 day" period.
let heatmap3DTabId = null;
async function scrapeHeatMap3D() {
  const listResp = await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(5000) });
  const tabs = await listResp.json();

  // Use existing CoinGlass tab, otherwise fall back to any active tab and navigate
  let tab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('coinglass.com')) || null;
  let navigated = false;

  if (!tab) {
    // Fallback: Try any active http/https tab
    tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
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
      await new Promise(r => setTimeout(r, 2000));
    }

    // Select "3 day" via React fiber onChange (most reliable for React-managed state)
    const clickResult = await cdp('Runtime.evaluate', {
      expression: `
        (async function() {
          function rc(el) {
            ['mousedown','mouseup','click'].forEach(ev =>
              el.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window}))
            );
          }

          // Walk all elements looking for "24 hour" text
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          var nodes24 = [];
          var node;
          while (node = walker.nextNode()) {
            if (/^24\\s*hour$/i.test(node.nodeValue.trim())) nodes24.push(node.parentElement);
          }

          if (nodes24.length === 0) {
            var all = Array.from(document.querySelectorAll('*'));
            var el = all.find(e => /^24\\s*hour$/i.test(Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.nodeValue).join('').trim()));
            if (el) nodes24.push(el);
          }

          if (nodes24.length === 0) {
            return 'no 24h text node; page title=' + document.title.slice(0,40);
          }

          var el24 = nodes24[0];
          var node2 = el24;
          for (var i = 0; i < 10; i++) {
            rc(node2);
            if (!node2.parentElement || node2 === document.body) break;
            node2 = node2.parentElement;
          }
          await new Promise(r => setTimeout(r, 2500));

          // Find "3 day" text node
          var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          var day3El = null;
          while (node = walker2.nextNode()) {
            if (/^3\\s*day$/i.test(node.nodeValue.trim())) { day3El = node.parentElement; break; }
          }

          if (day3El) {
            rc(day3El);
            if (day3El.parentElement) rc(day3El.parentElement);
            await new Promise(r => setTimeout(r, 1000));
            return 'clicked 3day: ' + day3El.tagName;
          }

          return 'no 3day found';
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    console.log('[Heatmap3D] Period select result:', clickResult?.result?.value);
    
    // Wait up to 45s for chart to update to 3D period (xAxis data length > 150)
    let chartUpdated = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await cdp('Runtime.evaluate', {
        expression: `(function(){
          var el=document.querySelector('.echarts-for-react');
          if(!el) return 0;
          var keys=Object.keys(el),fk=keys.find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactContainer$'));
          if(!fk) return 0;
          var f=el[fk],opt=null;
          while(f){if(f.memoizedProps&&f.memoizedProps.option){opt=f.memoizedProps.option;break;}f=f.return;}
          if(!opt||!opt.xAxis) return 0;
          var xa=Array.isArray(opt.xAxis)?opt.xAxis[0].data:opt.xAxis.data;
          return xa ? xa.length : 0;
        })()`,
        returnByValue: true
      });
      const newVal = parseInt(check?.result?.value, 10) || 0;
      if (newVal > 150) {
        console.log('[Heatmap3D] Chart updated to 3D period after', (attempt+1)*3, 's. xAxis length:', newVal);
        chartUpdated = true;
        break;
      }
      console.log('[Heatmap3D] Waiting for 3D chart update... attempt', attempt+1, 'xAxis length:', newVal);
    }
    if (!chartUpdated) console.log('[Heatmap3D] Chart did not update to 3D period - scraping current state');

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
                      series: option.series.map(s => ({ name: s.name, type: s.type, data: s.data })),
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

    return { data: parsed, timestamp: new Date().toISOString(), period: '3d' };
  } finally {
    if (navigated && savedUrl) {
      console.log(`[Heatmap3D] Restoring original URL: ${savedUrl}`);
      await cdp('Page.navigate', { url: savedUrl }).catch(e => console.error('[Heatmap3D] Failed to navigate back:', e));
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

  if (isHeatmapScrapingBusy) {
    if (heatmapDataCache) return res.json({ success: true, source: "stale-cache", data: heatmapDataCache });
    return res.status(409).json({ success: false, error: "A scrape is already in progress, please wait." });
  }

  isHeatmapScrapingBusy = true;
  try {
    console.log('Starting CoinGlass Heatmap scrape...');
    const result = await runWithCdpLock(() => scrapeHeatMap(forceRefresh));
    heatmapDataCache = result;
    lastHeatmapFetchTime = Date.now();
    res.json({ success: true, source: 'live', data: result });
  } catch (error) {
    console.error('Heatmap scrape error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    isHeatmapScrapingBusy = false;
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

  if (isEtfScrapingBusy) {
    return res.status(409).json({ success: false, error: 'A scrape is already in progress, please wait.' });
  }

  isEtfScrapingBusy = true;
  try {
    console.log('Starting CoinGlass scrape...');
    const result = await runWithCdpLock(() => scrapeCoinGlass('/etf/bitcoin', forceRefresh));
    etfDataCache = result;
    lastFetchTime = Date.now();
    res.json({ success: true, source: 'live', data: result, btcPrice });
  } catch (error) {
    console.error('Scrape error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    isEtfScrapingBusy = false;
  }
});

// ─── JSON Database Persistence ──────────────────────────────
const TRADES_FILE = path.join(__dirname, 'trades.json');

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
    minRR: 2.0,
    maxActive: 1,
    minDist: 0.3,
    maxDist: 8.0,
    autoTradeEnabled: true,
    sweepConfirmCandles: 3,
    minPoolVolumeRatio: 0.15,
    cooldownMinutes: 60,
    telegramBotToken: '',
    telegramChatId: '',
    authUsername: 'admin',
    authPassword: 'admin123'
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
    minReversalProbability: parseIntNum(newSettings.minReversalProbability, current.minReversalProbability || 65),
    maxActive: parseIntNum(newSettings.maxActive, current.maxActive),
    minDist: parseNum(newSettings.minDist, current.minDist),
    maxDist: parseNum(newSettings.maxDist, current.maxDist),
    autoTradeEnabled: newSettings.autoTradeEnabled !== undefined ? !!newSettings.autoTradeEnabled : current.autoTradeEnabled,
    sweepConfirmCandles: parseIntNum(newSettings.sweepConfirmCandles, current.sweepConfirmCandles),
    minPoolVolumeRatio: parseNum(newSettings.minPoolVolumeRatio, current.minPoolVolumeRatio),
    cooldownMinutes: parseIntNum(newSettings.cooldownMinutes, current.cooldownMinutes),
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

// TradingView Webhook Endpoint
app.post('/api/tradingview/webhook', (req, res) => {
  const data = req.body;
  console.log('[TradingView Webhook] Received payload:', JSON.stringify(data));

  if (!data || !data.action) {
    return res.status(400).json({ success: false, error: 'Missing action parameter' });
  }

  const trades = loadTrades();
  const settings = loadSettings();

  if (data.action === 'buy' || data.action === 'sell') {
    const direction = data.direction || (data.action === 'buy' ? 'LONG' : 'SHORT');
    const entry = parseFloat(data.entry || 0);
    const tp = parseFloat(data.tp || 0);
    const sl = parseFloat(data.sl || 0);

    if (!entry || !tp || !sl) {
      return res.status(400).json({ success: false, error: 'Missing entry, tp, or sl' });
    }

    const activeTrades = trades.filter(t => t.status === 'ACTIVE');
    if (activeTrades.length >= settings.maxActive) {
      console.log('[TradingView Webhook] Max active trades reached, skipping entry.');
      return res.status(400).json({ success: false, error: 'Max active trades reached' });
    }

    const slDistance = Math.abs(((entry - sl) / entry) * 100);
    const tpDistance = Math.abs(((tp - entry) / entry) * 100);
    const rr = (tpDistance / slDistance).toFixed(1);

    const riskUsd = settings.capital * (settings.riskPercent / 100);
    const positionSizeUsd = riskUsd / (slDistance / 100);

    const newTrade = {
      id: 'T' + Date.now(),
      time: new Date().toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      direction,
      entry,
      tp,
      sl,
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
        `PnL: <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</code> (${trade.pnl >= 0 ? '+' : ''}Bs. ${(trade.pnl * 6.96).toFixed(2)})\n` +
        `Note: ${trade.note}`
      );
    } else {
      res.status(404).json({ success: false, error: 'No active trade found to exit' });
    }
  } else {
    res.status(400).json({ success: false, error: 'Unknown action' });
  }
});

// ─── Binance Metric State & Fetchers ──────────────────────────
let botMetrics = {
  openInterest: 0,
  oiChange1h: 0,
  spotCvd1h: 0,
  trend1h: 'UNKNOWN',
  trend4h: 'UNKNOWN',
  fundingRate: 0,
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
    const res = await fetch('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=13');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const currentOIVal = parseFloat(data[data.length - 1].sumOpenInterestValue);
      const startOIVal = parseFloat(data[0].sumOpenInterestValue);
      const currentOI = parseFloat(data[data.length - 1].sumOpenInterest);
      const diffPercent = ((currentOIVal - startOIVal) / startOIVal) * 100;
      return {
        currentOI,
        currentOIVal,
        oiChange1h: isNaN(diffPercent) ? 0 : diffPercent
      };
    }
  } catch (err) {
    console.error('[Binance API] Error fetching OI:', err.message);
  }
  return { currentOI: 0, currentOIVal: 0, oiChange1h: 0 };
}

async function fetchBinanceSpotCVD() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=12');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      let cumulativeDelta = 0;
      data.forEach(k => {
        const totalVal = parseFloat(k[7]);
        const takerBuyVal = parseFloat(k[10]);
        if (!isNaN(totalVal) && !isNaN(takerBuyVal)) {
          const delta = 2 * takerBuyVal - totalVal;
          cumulativeDelta += delta;
        }
      });
      return cumulativeDelta;
    }
  } catch (err) {
    console.error('[Binance API] Error fetching Spot CVD:', err.message);
  }
  return 0;
}

async function fetchBinanceHTFTrend() {
  try {
    // 1h Klines
    const res1h = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=210');
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
    const res4h = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=210');
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
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.lastFundingRate !== undefined) {
      return parseFloat(data.lastFundingRate);
    }
  } catch (err) {
    console.error('[Binance API] Error fetching Funding Rate:', err.message);
  }
  return 0;
}

async function fetchBinanceLongShortRatio() {
  try {
    const res = await fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1');
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

function calculateReversalProbability(sweepDetail, oiChange, spotCVD, trend1h, trend4h, fundingRate, longShortRatio) {
  let score = 40; // Base probability start at 40%

  // 1. Liquidation Pool Volume (Up to 15 points)
  const volBillions = sweepDetail.volume / 1e9;
  score += Math.min(15, volBillions * 3);

  // 2. Rejection Strength / Wick Depth (Up to 15 points)
  score += Math.min(15, sweepDetail.rejectionStrength * 15);

  // 3. Open Interest change (Up to 10 points)
  if (oiChange < 0) {
    score += Math.min(10, Math.abs(oiChange) * 3);
  } else {
    score -= Math.min(10, oiChange * 2);
  }

  // 4. Spot CVD Divergence (Up to 10 points)
  if (sweepDetail.direction === 'LONG' && spotCVD > 0) {
    score += 10;
  } else if (sweepDetail.direction === 'SHORT' && spotCVD < 0) {
    score += 10;
  } else {
    score -= 5;
  }

  // 5. HTF Trend Alignment (Up to 10 points)
  if (sweepDetail.direction === 'LONG') {
    if (trend1h === 'BULLISH') score += 5;
    if (trend4h === 'BULLISH') score += 5;
    if (trend1h === 'BEARISH') score -= 5;
  } else if (sweepDetail.direction === 'SHORT') {
    if (trend1h === 'BEARISH') score += 5;
    if (trend4h === 'BEARISH') score += 5;
    if (trend1h === 'BULLISH') score -= 5;
  }

  // 6. Funding Rate (Up to 10 points)
  const fundingNum = parseFloat(fundingRate) || 0;
  if (sweepDetail.direction === 'LONG') {
    if (fundingNum < 0) {
      score += Math.min(10, Math.abs(fundingNum) * 20000);
    } else if (fundingNum > 0.0005) {
      score -= Math.min(10, (fundingNum - 0.0005) * 10000);
    }
  } else if (sweepDetail.direction === 'SHORT') {
    if (fundingNum > 0) {
      score += Math.min(10, fundingNum * 20000);
    } else if (fundingNum < -0.0005) {
      score -= Math.min(10, Math.abs(fundingNum + 0.0005) * 10000);
    }
  }

  // 7. Long/Short Ratio (Up to 10 points)
  const lsRatio = parseFloat(longShortRatio) || 1.0;
  if (sweepDetail.direction === 'LONG') {
    if (lsRatio < 1.3) {
      score += Math.min(10, (1.3 - lsRatio) * 25);
    } else if (lsRatio > 1.8) {
      score -= Math.min(10, (lsRatio - 1.8) * 10);
    }
  } else if (sweepDetail.direction === 'SHORT') {
    if (lsRatio > 1.6) {
      score += Math.min(10, (lsRatio - 1.6) * 12.5);
    } else if (lsRatio < 1.1) {
      score -= Math.min(10, (1.1 - lsRatio) * 20);
    }
  }

  // Bound the score between 10% and 99%
  return Math.max(10, Math.min(99, Math.round(score)));
}

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

// ─── Global Bot Phase State (for API reporting) ─────────────
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

// API endpoint for bot phase status

app.get('/api/sweep-prediction', (req, res) => {
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

app.get('/api/bot-status', async (req, res) => {
  const settings = loadSettings();
  
  let btcPrice = 65000; // default fallback
  try {
    const tickerResp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const tickerData = await tickerResp.json();
    btcPrice = parseFloat(tickerData.price) || 65000;
  } catch (e) {
    console.error('Failed to fetch BTC price from Binance for bot-status, using default fallback:', e.message);
  }

  res.json({
    success: true,
    btcPrice,
    data: {
      ...botPhaseState,
      metrics: botMetrics,
      autoTradeEnabled: settings.autoTradeEnabled,
      strategy: 'Liquidity Sweep Reversal (LSR)',
      settings: {
        minRR: settings.minRR,
        maxActive: settings.maxActive,
        sweepConfirmCandles: settings.sweepConfirmCandles || 3,
        cooldownMinutes: settings.cooldownMinutes || 60,
        minPoolVolumeRatio: settings.minPoolVolumeRatio || 0.15,
        minReversalProbability: settings.minReversalProbability || 65
      }
    }
  });
});

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
  const activeTrades = trades.filter(t => t.status === 'ACTIVE');
  if (activeTrades.length >= settings.maxActive) {
    botPhaseState = {
      ...botPhaseState,
      phase: 'MAX_ACTIVE',
      message: `Max active trades reached (${activeTrades.length}/${settings.maxActive}). Monitoring only.`,
      lastUpdate: new Date().toISOString()
    };
    return;
  }

  const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');
  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) return;

  const yAxisData = heatmapData.yAxis || [];
  
  // ─── Step 1: Build volume map per price level ─────────────
  const volumeByY = {};
  heatmapSeries.data.forEach(item => {
    const v = Array.isArray(item) ? item : (item.value || []);
    const yIdx = parseInt(v[1], 10);
    const val = parseFloat(v[2] || 0);
    if (!isNaN(yIdx)) {
      volumeByY[yIdx] = (volumeByY[yIdx] || 0) + val;
    }
  });

  // ─── Step 2: Determine volume threshold (top pools only) ──
  const allVolumes = Object.values(volumeByY).filter(v => v > 0).sort((a, b) => b - a);
  const volumeRatio = settings.minPoolVolumeRatio || 0.15;
  const topCutoffIndex = Math.max(1, Math.floor(allVolumes.length * volumeRatio));
  const minPoolVolume = allVolumes[topCutoffIndex - 1] || 0;

  // ─── Step 3: Find nearest HIGH-volume pool on each side ───
  let nearestAbove = null, nearestBelow = null;
  
  yAxisData.forEach((priceStr, idx) => {
    const p = parseFloat(priceStr);
    if (isNaN(p)) return;
    
    const volume = volumeByY[idx] || 0;
    if (volume < minPoolVolume) return; // Only consider top pools
    
    const distPercent = ((p - currentPrice) / currentPrice) * 100;
    const absDist = Math.abs(distPercent);
    
    if (absDist < 0.1 || absDist > settings.maxDist) return; // Too close or too far
    
    if (p > currentPrice) {
      if (!nearestAbove || absDist < Math.abs(nearestAbove.distance)) {
        nearestAbove = { price: p, yIdx: idx, distance: distPercent, volume };
      }
    } else {
      if (!nearestBelow || absDist < Math.abs(nearestBelow.distance)) {
        nearestBelow = { price: p, yIdx: idx, distance: distPercent, volume };
      }
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
      phase: 'STANDBY',
      nearestPool: null,
      nearestPoolDistance: null,
      nearestPoolVolume: null,
      nearestPoolSide: null,
      sweepCandidate: null,
      message: `No qualifying HIGH pools found near $${currentPrice.toFixed(0)}. Waiting...`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] STANDBY — No qualifying pools near price $${currentPrice.toFixed(0)}`);
    return;
  }

  const poolSide = closestPool.distance > 0 ? 'RESISTANCE' : 'SUPPORT';
  
  // ─── Step 5: Sweep Detection across recent candles ────────
  const sweepCandidates = [];
  
  // Check ALL qualifying pools (not just nearest) for sweeps
  yAxisData.forEach((priceStr, idx) => {
    const p = parseFloat(priceStr);
    if (isNaN(p)) return;
    
    const volume = volumeByY[idx] || 0;
    if (volume < minPoolVolume) return; // Only top pools
    
    const distPercent = ((p - currentPrice) / currentPrice) * 100;
    const absDist = Math.abs(distPercent);
    if (absDist > settings.maxDist) return;
    
    // Check if this pool was already swept by OLDER candles (stale sweep = skip)
    const alreadySweptOld = olderCandles.some(c => {
      const cLow = parseFloat(c[2]);
      const cHigh = parseFloat(c[3]);
      return p >= cLow && p <= cHigh;
    });
    if (alreadySweptOld) return;
    
    // Check if any RECENT candle swept this pool with a rejection
    for (const candle of recentCandles) {
      const cClose = parseFloat(candle[1]);
      const cLow = parseFloat(candle[2]);
      const cHigh = parseFloat(candle[3]);
      if (isNaN(cClose) || isNaN(cLow) || isNaN(cHigh)) continue;
      
      if (p < currentPrice) {
        // Pool BELOW price: wick went down to sweep, but price closed ABOVE pool → LONG reversal
        if (cLow <= p && cClose > p) {
          const wickDepth = Math.abs(((cLow - p) / p) * 100);
          const rejectionStrength = Math.abs(((cClose - cLow) / cLow) * 100);
          sweepCandidates.push({
            price: p,
            yIdx: idx,
            volume,
            direction: 'LONG',
            distFromPrice: absDist,
            wickDepth,
            rejectionStrength,
            sweepLow: cLow,
            sweepHigh: cHigh,
            sweepClose: cClose,
            // Score: higher volume + stronger rejection + deeper wick = better
            score: volume * (1 + rejectionStrength) * (1 + wickDepth)
          });
          break; // One sweep per pool is enough
        }
      } else {
        // Pool ABOVE price: wick went up to sweep, but price closed BELOW pool → SHORT reversal
        if (cHigh >= p && cClose < p) {
          const wickDepth = Math.abs(((cHigh - p) / p) * 100);
          const rejectionStrength = Math.abs(((cHigh - cClose) / cHigh) * 100);
          sweepCandidates.push({
            price: p,
            yIdx: idx,
            volume,
            direction: 'SHORT',
            distFromPrice: absDist,
            wickDepth,
            rejectionStrength,
            sweepLow: cLow,
            sweepHigh: cHigh,
            sweepClose: cClose,
            score: volume * (1 + rejectionStrength) * (1 + wickDepth)
          });
          break;
        }
      }
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
        message: `⚠️ Price $${currentPrice.toFixed(0)} approaching ${poolSide} pool at $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}% away). Watching for sweep...`,
        lastUpdate: new Date().toISOString()
      };
      console.log(`[LSR Bot] ALERT — Price approaching ${poolSide} pool $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}%)`);
    } else {
      // STANDBY phase: price in mid-range, no qualifying sweep
      botPhaseState = {
        phase: 'STANDBY',
        nearestPool: closestPool.price,
        nearestPoolDistance: closestPool.distance.toFixed(2) + '%',
        nearestPoolVolume: closestPool.volume,
        nearestPoolSide: poolSide,
        sweepCandidate: null,
        message: `Waiting in mid-range. Nearest ${poolSide} pool: $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}%). No sweep yet.`,
        lastUpdate: new Date().toISOString()
      };
      console.log(`[LSR Bot] STANDBY — Mid-range at $${currentPrice.toFixed(0)}, nearest pool $${closestPool.price.toFixed(0)} (${nearDist.toFixed(2)}%)`);
    }
    return;
  }

  // ─── Step 7: Sweep detected! Pick the best one ───────────
  sweepCandidates.sort((a, b) => b.score - a.score);
  const bestSweep = sweepCandidates[0];
  
  const direction = bestSweep.direction;
  const entry = currentPrice;

  // ─── Step 8: Calculate SL (behind sweep wick + 0.1% buffer) ─
  const slBuffer = entry * 0.001; // 0.1% buffer behind sweep wick
  let sl = direction === 'LONG' 
    ? (bestSweep.sweepLow - slBuffer) 
    : (bestSweep.sweepHigh + slBuffer);

  let slDistance = Math.abs(((entry - sl) / entry) * 100);
  
  // Safety: minimum SL distance to prevent extreme leverage
  if (slDistance < 0.15) {
    slDistance = 0.2;
    sl = direction === 'LONG' ? (entry * (1 - 0.002)) : (entry * (1 + 0.002));
  }

  // ─── Step 9: Calculate TP (largest opposing unswept pool) ──
  let tp = 0;
  let maxOpposingVolume = 0;

  yAxisData.forEach((priceStr, idx) => {
    const p = parseFloat(priceStr);
    if (isNaN(p)) return;

    const isOpposing = direction === 'LONG' ? (p > currentPrice) : (p < currentPrice);
    if (!isOpposing) return;

    // Pastikan pool target belum tersapu oleh semua candle
    const swept = cs.data.some(c => p >= parseFloat(c[2]) && p <= parseFloat(c[3]));
    if (swept) return;

    const volume = volumeByY[idx] || 0;
    if (volume > maxOpposingVolume) {
      maxOpposingVolume = volume;
      tp = p;
    }
  });

  if (tp === 0) {
    // Fallback: 2x SL distance
    const fallbackDist = slDistance * 2;
    tp = direction === 'LONG' ? (entry * (1 + fallbackDist / 100)) : (entry * (1 - fallbackDist / 100));
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
  const prob = calculateReversalProbability(bestSweep, botMetrics.oiChange1h, botMetrics.spotCvd1h, botMetrics.trend1h, botMetrics.trend4h, botMetrics.fundingRate, botMetrics.longShortRatio);
  botMetrics.reversalProbability = prob; // cache the latest calculated probability for reporting

  const minProb = settings.minReversalProbability || 65;
  if (prob < minProb) {
    botPhaseState = {
      phase: 'SWEEP_REJECTED',
      nearestPool: bestSweep.price,
      nearestPoolDistance: bestSweep.distFromPrice.toFixed(2) + '%',
      nearestPoolVolume: bestSweep.volume,
      nearestPoolSide: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
      sweepCandidate: { direction, entry, tp, sl, rr, prob },
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
      sweepCandidate: { direction, entry, tp, sl, rr, prob },
      message: `Sweep ${direction} at $${bestSweep.price.toFixed(0)} detected but in cooldown. Waiting...`,
      lastUpdate: new Date().toISOString()
    };
    console.log(`[LSR Bot] COOLDOWN — ${direction} trade recently executed near this TP zone`);
    return;
  }

  // ─── Step 12: EXECUTE TRADE ───────────────────────────────
  const riskUsd = settings.capital * (settings.riskPercent / 100);
  const positionSizeUsd = riskUsd / (slDistance / 100);

  // Track TP pool initial volume for shrinkage detection
  let initialTpVolume = null;
  let closestTpYIdx = -1, minTpDiff = Infinity;
  yAxisData.forEach((priceStr, idx) => {
    const p = parseFloat(priceStr);
    const diff = Math.abs(p - tp);
    if (diff < minTpDiff) {
      minTpDiff = diff;
      closestTpYIdx = idx;
    }
  });
  if (closestTpYIdx !== -1) {
    initialTpVolume = volumeByY[closestTpYIdx] || 0;
  }

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
    sweepCandidate: { direction, entry: newTrade.entry, tp: newTrade.tp, sl: newTrade.sl, rr, prob },
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
  const klinesRes = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=25');
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
  const depthRes = await fetch('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=500');
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
    const res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=20');
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

function jda_ema(vals, period) {
  const k = 2 / (period + 1); let r = vals[0] || 0;
  for (let i = 1; i < vals.length; i++) r = (vals[i] || 0) * k + r * (1 - k);
  return r;
}

async function fetchJDASignal() {
  try {
    const [k1h, k4h] = await Promise.all([
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60').then(r=>r.json()),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=60').then(r=>r.json()),
    ]);

    const vzo = klines => {
      const c = klines.map(k=>parseFloat(k[4])), v = klines.map(k=>parseFloat(k[5]));
      const sma = arr => arr.reduce((s,x)=>s+x,0)/arr.length;
      const rv = v.map((vi,i)=>vi/(sma(v.slice(Math.max(0,i-9),i+1))||1));
      const dc = c.map((ci,i)=>i===0?0:ci-c[i-1]);
      const mom = dc.map((d,i)=>d*rv[i]);
      const pm = mom.map(m=>Math.max(m,0)), nm = mom.map(m=>Math.abs(Math.min(m,0)));
      const pa = jda_ema(pm,9), na = jda_ema(nm,9);
      const ratio = na>0.00001 ? pa/na : (pa>0.00001?100:1);
      return Math.min(100,Math.max(-100,100*(ratio-1)/(ratio+1)));
    };

    const v1h = Array.isArray(k1h) ? vzo(k1h) : 0;
    const v4h = Array.isArray(k4h) ? vzo(k4h) : 0;
    const dirScore = v1h*0.30 + v4h*0.10;
    const bias = v4h > 10 ? 'BULLISH' : v4h < -10 ? 'BEARISH' : 'NEUTRAL';

    const tfState = v => v > 40 ? 'BULL+' : v > 0 ? 'BULL' : v < -40 ? 'BEAR+' : v < 0 ? 'BEAR' : 'RANGE';
    const tfTrend = s => s.includes('BULL') ? 'BULLISH' : s.includes('BEAR') ? 'BEARISH' : 'RANGING';
    const tfStr   = s => (s === 'BULL+' || s === 'BEAR+') ? 'STRONG' : s === 'RANGE' ? 'WEAK' : 'MODERATE';
    const tfScore = (v, dir) => dir === 'LONG' ? Math.min(10,Math.max(-10,v/10)) : -Math.min(10,Math.max(-10,v/10));

    return {
      timeframes: {
        '15m': { vzo:0, state:'RANGE', trend:'RANGING', strength:'WEAK' },
        '1h':  { vzo:Math.round(v1h*10)/10, state:tfState(v1h), trend:tfTrend(tfState(v1h)), strength:tfStr(tfState(v1h)) },
        '4h':  { vzo:Math.round(v4h*10)/10, state:tfState(v4h), trend:tfTrend(tfState(v4h)), strength:tfStr(tfState(v4h)) },
        '1d':  { vzo:0, state:'RANGE', trend:'RANGING', strength:'WEAK' },
        '1w':  { vzo:0, state:'RANGE', trend:'RANGING', strength:'WEAK' },
      },
      dirScore: Math.round(dirScore*10)/10,
      conf: Math.min(Math.abs(dirScore), 100),
      confLevel: Math.abs(dirScore)>=65?'HIGH':Math.abs(dirScore)>=60?'MEDIUM':'LOW',
      phase: v4h > 40 ? 'STRONG BULL TREND' : v4h < -40 ? 'STRONG BEAR TREND' : 'NEUTRAL',
      marketBias: bias,
      action: 'WAIT',
      fetchTime: Date.now()
    };
  } catch(e) {
    console.error('[JDA] Error:', e.message);
    return { timeframes:{'1h':{vzo:0,state:'RANGE'},'4h':{vzo:0,state:'RANGE'}}, dirScore:0, conf:0, phase:'NEUTRAL', marketBias:'NEUTRAL', action:'WAIT', fetchTime:Date.now() };
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

    const volumeByY = {};
    heatmapSeries.data.forEach(item => {
      const v = Array.isArray(item) ? item : (item.value || []);
      const yIdx = parseInt(v[1], 10);
      const val  = parseFloat(v[2] || 0);
      if (!isNaN(yIdx) && val > 0) volumeByY[yIdx] = (volumeByY[yIdx] || 0) + val;
    });

    const pools = [];
    yAxisData.forEach((priceStr, idx) => {
      const price  = parseFloat(priceStr);
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
    const oiData     = val(0, { currentOI: 0, currentOIVal: 0, oiChange1h: 0 });
    const cvdVal     = val(1, { futures: 0, spot: 0 });
    const jdaSig     = val(2, null);
    const fundingRate = val(3, 0);
    const lsRatioData = val(4, { ratio: 1.0, long: 0.5, short: 0.5, topRatio: 1.0, topLong: 0.5, topShort: 0.5 });
    const klines15m  = val(5, null);
    if (jdaSig) jdaSignalCache = jdaSig;
    const failedCalls = results.filter(r => r.status === 'rejected').length;
    if (failedCalls > 0) console.log('[Background Bot] ' + failedCalls + ' API call(s) failed, continuing with available data.');
    
    botMetrics = {
      ...botMetrics,
      openInterest: oiData.currentOI,
      oiChange1h: oiData.oiChange1h,
      spotCvd1h: (cvdVal && cvdVal.futures) || cvdVal || 0,
      spotCvdFutures: (cvdVal && cvdVal.futures) || 0,
      spotCvdSpot: (cvdVal && cvdVal.spot) || 0,
      // JDA MTF engine replaces EMA20/50 — VZO + ZLEMA based trend
      trend1h: (jdaSig.timeframes['1h']?.state || '').includes('BULL') ? 'BULLISH' : (jdaSig.timeframes['1h']?.state || '').includes('BEAR') ? 'BEARISH' : 'RANGING',
      trend4h: (jdaSig.timeframes['4h']?.state || '').includes('BULL') ? 'BULLISH' : (jdaSig.timeframes['4h']?.state || '').includes('BEAR') ? 'BEARISH' : 'RANGING',
      strength1h: (jdaSig.timeframes['1h']?.state === 'BULL+' || jdaSig.timeframes['1h']?.state === 'BEAR+') ? 'STRONG' : jdaSig.timeframes['1h']?.state === 'RANGE' ? 'WEAK' : 'MODERATE',
      strength4h: (jdaSig.timeframes['4h']?.state === 'BULL+' || jdaSig.timeframes['4h']?.state === 'BEAR+') ? 'STRONG' : jdaSig.timeframes['4h']?.state === 'RANGE' ? 'WEAK' : 'MODERATE',
      // Probability score from JDA VZO — normalized ±10 (replaces EMA-based score)
      score1h: Math.min(10, Math.max(-10, (jdaSig.timeframes['1h']?.vzo || 0) / 10)),
      score4h: Math.min(10, Math.max(-10, (jdaSig.timeframes['4h']?.vzo || 0) / 10)),
      // JDA-specific fields for HTF filter and display
      jdaV15m:      jdaSig.timeframes['15m']?.vzo || 0,
      jdaV1h:       jdaSig.timeframes['1h']?.vzo  || 0,
      jdaV4h:       jdaSig.timeframes['4h']?.vzo  || 0,
      jdaV1d:       jdaSig.timeframes['1d']?.vzo  || 0,
      jdaV1w:       jdaSig.timeframes['1w']?.vzo  || 0,
      jdaZlema1h:   jdaSig.timeframes['1h']?.trend || 0,
      jdaZlema4h:   jdaSig.timeframes['4h']?.trend || 0,
      jdaPhase:     jdaSig.phase,
      jdaConf:      jdaSig.conf,
      jdaMarketBias: jdaSig.marketBias,
      jdaAction:    jdaSig.action,
      jdaDirScore:  jdaSig.dirScore,
      fundingRate: fundingRate,
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

    const result = await runWithCdpLock(() => scrapeHeatMap(true)); // force refresh to get latest data from CoinGlass!
    heatmapDataCache = result;
    lastHeatmapFetchTime = Date.now();

    // Run evaluations and strategy
    evaluateActiveTradesBackend(result.data, klines15m);
    autoTradeStrategyBackend(result.data, klines15m);
    const _sweepInput = result.data.data || result.data;
    console.log('[SweepPredict] Input series:', _sweepInput && _sweepInput.series ? _sweepInput.series.length : 'NO_SERIES', 'yAxis:', _sweepInput && _sweepInput.yAxis ? _sweepInput.yAxis.length : 0);
    sweepPredictionCache = predictSweepTargets(_sweepInput, botMetrics);
    console.log('[SweepPredict] Result:', sweepPredictionCache ? sweepPredictionCache.direction + ' ' + sweepPredictionCache.confidence + '%' : 'NULL');

    // Scrape 3D heatmap in background after main cycle
    try {
      const r3d = await runWithCdpLock(() => scrapeHeatMap3D());
      heatmap3DCache = r3d;
      lastHeatmap3DFetchTime = Date.now();
      const hd3 = r3d.data;
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
    } catch(e) {
      console.error('[Heatmap3D] Error:', e.message);
    }

    console.log('[Background Bot] Cycle completed successfully. Metrics:', JSON.stringify(botMetrics));
  } catch (error) {
    console.error('[Background Bot] Cycle error:', error.message);
  } finally {
    isHeatmapScrapingBusy = false;
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
  console.log(`Make sure Chrome is running with remote debugging`);
  console.log(`on port 9222 before triggering a refresh.`);
  console.log(`==================================================`);

  // Start background bot 24/7 worker
  startBackgroundBot().catch(e => console.error('Failed to start background bot:', e));

  // Warm-up ETF cache 90s after start (after first heatmap scrape finishes)
  setTimeout(async () => {
    if (!etfDataCache) {
      console.log('[ETF] Warming up cache...');
      try {
        const tickerResp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
        const tickerData = await tickerResp.json();
        const btcPrice = parseFloat(tickerData.price) || 65000;
        const result = await scrapeCoinGlass('/etf/bitcoin', false);
        etfDataCache = result;
        lastFetchTime = Date.now();
        console.log('[ETF] Cache warmed up successfully.');
      } catch (e) { console.error('[ETF] Warm-up failed:', e.message); }
    }
  }, 90000);
});

// Auto-Deploy Validation Check: Pushed by Antigravity at 2026-06-20 17:01 (Test)
