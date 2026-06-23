import WebSocket from 'ws';

const VPS_URL = 'http://103.55.37.239';
const POLL_INTERVAL_MS = 5000; // Periksa setiap 5 detik

console.log('==========================================================');
console.log('       JDA TradingView Free Version Signal Bridge         ');
console.log(`       Target VPS: ${VPS_URL}`);
console.log('==========================================================');

let lastState = {
  dir: 0,
  entry: 0,
  tp: 0,
  sl: 0
};

let isTradeActive = false;

async function getTradingViewTab() {
  try {
    const res = await fetch('http://localhost:9222/json');
    const tabs = await res.json();
    const tvTab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
    if (!tvTab) {
      console.log('[Bridge] Peringatan: Tab chart TradingView tidak ditemukan. Pastikan browser membuka TradingView.');
      return null;
    }
    return tvTab;
  } catch (e) {
    console.error('[Bridge] Gagal terhubung ke port debug Chrome 9222. Apakah Chrome debug sudah aktif?');
    return null;
  }
}

async function runBridge() {
  // Sinkronisasi status aktif trade dari VPS
  try {
    const res = await fetch(`${VPS_URL}/api/trades`);
    if (res.ok) {
      const rawData = await res.json();
      const trades = Array.isArray(rawData) ? rawData : (rawData.data || []);
      isTradeActive = trades.some(t => t.status === 'ACTIVE');
      console.log(`[Bridge] Sinkronisasi VPS: Status trade aktif = ${isTradeActive}`);
    }
  } catch (e) {
    console.warn('[Bridge] Gagal sinkronisasi status aktif dari VPS, menggunakan default false:', e.message);
  }

  const tab = await getTradingViewTab();
  if (!tab) {
    setTimeout(runBridge, 10000);
    return;
  }

  console.log(`[Bridge] Menghubungkan ke tab TradingView: "${tab.title}"`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);

  ws.on('open', () => {
    console.log('[Bridge] WebSocket terhubung ke debugger TradingView.');
    startMonitoring(ws);
  });

  ws.on('error', (err) => {
    console.error('[Bridge] WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('[Bridge] Koneksi terputus. Menghubungkan ulang dalam 10 detik...');
    setTimeout(runBridge, 10000);
  });
}

function startMonitoring(ws) {
  let _mid = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = _mid++;
    ws.send(JSON.stringify({ id, method, params }));
    const t = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 10000);
    const handler = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === id) {
        clearTimeout(t);
        ws.off('message', handler);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      }
    };
    ws.on('message', handler);
  });

  const intervalId = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(intervalId);
      return;
    }

    try {
      // Mengekstrak data legenda indikator secara robust menggunakan properti data-test-id-value-title dan title
      const evalExpr = `
        (() => {
          const studyItems = Array.from(document.querySelectorAll('[class*="study-"], .pane-legend-item'));
          const studyEl = studyItems.find(el => el.innerText && el.innerText.includes('JDAv85'));
          if (!studyEl) return null;

          const getValueByTitle = (substring) => {
            const el = studyEl.querySelector(\`[data-test-id-value-title*="\${substring}"], [title*="\${substring}"]\`);
            if (!el) return null;
            const valEl = el.querySelector('[class*="valueValue-"]') || el;
            return valEl.innerText || '';
          };

          return {
            dir: getValueByTitle('dir'),
            entry: getValueByTitle('entry'),
            tp: getValueByTitle('tp2') || getValueByTitle('tp1') || getValueByTitle('tp'),
            sl: getValueByTitle('sl')
          };
        })()
      `;

      const evalRes = await cdp('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
      const signalData = evalRes?.result?.value;

      if (!signalData) {
        console.log('[Bridge] Menunggu indikator JDAv85 ditambahkan ke chart...');
        return;
      }

      const parseVal = (v) => {
        if (!v || v === '∅') return 0;
        const num = parseFloat(v);
        return isNaN(num) ? 0 : num;
      };

      const dir = Math.round(parseVal(signalData.dir));
      const entry = parseVal(signalData.entry);
      const tp = parseVal(signalData.tp);
      const sl = parseVal(signalData.sl);

      // Status log berkala
      process.stdout.write(`\r[Bridge Monitoring] Dir: ${dir} | Entry: $${entry} | TP: $${tp} | SL: $${sl}`);

      // Deteksi perubahan sinyal
      if (dir !== lastState.dir || entry !== lastState.entry) {
        console.log(`\n[Bridge] Deteksi perubahan sinyal! (Dir Lama: ${lastState.dir} -> Dir Baru: ${dir})`);

        if (dir === 1 || dir === -1) {
          const direction = dir === 1 ? 'LONG' : 'SHORT';
          console.log(`[Bridge] Mengirim trade ${direction} ke VPS...`);

          const response = await fetch(`${VPS_URL}/api/tradingview/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: dir === 1 ? 'buy' : 'sell',
              direction,
              entry,
              tp,
              sl,
              note: 'Auto-Trade (TV Legend Scraper - FREE Version)'
            })
          });

          const result = await response.json();
          if (result.success) {
            console.log(`[Bridge] Sukses mengirim trade ${direction} ke VPS.`);
            isTradeActive = true;
          } else {
            console.error(`[Bridge] Gagal mengirim trade: ${result.error}`);
          }
        } else if (dir === 0 && isTradeActive) {
          console.log('[Bridge] Sinyal kembali ke FLAT. Mengirim instruksi Cut/Close ke VPS...');
          const response = await fetch(`${VPS_URL}/api/tradingview/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'cut',
              close: entry,
              note: 'Auto-Trade Exit (TV Legend Scraper - FREE Version)'
            })
          });

          const result = await response.json();
          if (result.success) {
            console.log('[Bridge] Sukses menutup trade aktif di VPS.');
            isTradeActive = false;
          } else {
            console.error(`[Bridge] Gagal menutup trade: ${result.error}`);
          }
        }

        lastState = { dir, entry, tp, sl };
      }
    } catch (err) {
      console.error('\n[Bridge] Error pada tick monitor:', err.message);
    }
  }, POLL_INTERVAL_MS);

  // Heatmap bridge: scrape local CoinGlass tab and push to VPS every 60s
  setInterval(bridgeHeatmaps, 60000);
  bridgeHeatmaps(); // run once immediately
}

async function bridgeHeatmaps() {
  try {
    const res = await fetch('http://localhost:9222/json');
    const tabs = await res.json();
    
    // Find coinglass heatmap tabs
    const cgTabs = tabs.filter(t => t.type === 'page' && t.url?.includes('LiquidationHeatMap'));
    
    if (cgTabs.length === 0) {
      return;
    }
    
    for (const tab of cgTabs) {
      try {
        const period = tab.url.includes('period=3d') ? '3d' : '24h';
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('WS timeout')), 3000);
          ws.on('open', () => { clearTimeout(t); resolve(); });
          ws.on('error', (err) => { clearTimeout(t); reject(err); });
        });
        
        let msgId = 1;
        const cdp = (method, params = {}) => new Promise((resOpt, rejOpt) => {
          const id = msgId++;
          ws.send(JSON.stringify({ id, method, params }));
          const t = setTimeout(() => rejOpt(new Error(`CDP timeout: ${method}`)), 5000);
          const handler = (data) => {
            const m = JSON.parse(data.toString());
            if (m.id === id) {
              clearTimeout(t);
              ws.off('message', handler);
              if (m.error) rejOpt(new Error(m.error.message));
              else resOpt(m.result);
            }
          };
          ws.on('message', handler);
        });
        
        await cdp('Runtime.enable');
        const evalExpr = `
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
                if (fiber.memoizedProps && fiber.memoizedProps.option) { option = fiber.memoizedProps.option; break; }
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
            } catch (e) { return JSON.stringify({ error: e.message }); }
          })()
        `;
        
        const evalRes = await cdp('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
        ws.close();
        
        const raw = evalRes?.result?.value;
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && !parsed.error && parsed.series && parsed.series.length > 0) {
          const postUrl = `${VPS_URL}/api/heatmap-data/update`;
          const response = await fetch(postUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              period,
              data: parsed
            })
          });
          const resJson = await response.json();
          if (resJson.success) {
            console.log(`\n[Bridge] Sukses mengirim data Heatmap (${period}) ke VPS.`);
          } else {
            console.error(`\n[Bridge] Gagal mengirim data Heatmap (${period}): ${resJson.error}`);
          }
        }
      } catch (err) {
        console.error(`\n[Bridge Heatmap Inner Error] ${tab.url}:`, err.message);
      }
    }
  } catch (e) {
    console.error('\n[Bridge Heatmap Outer Error]:', e.message);
  }
}

runBridge();
