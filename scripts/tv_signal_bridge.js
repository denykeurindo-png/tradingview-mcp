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
    const res = await fetch(`${VPS_URL}/api/jda-trades`);
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

          const response = await fetch(`${VPS_URL}/api/jda-trades/webhook`, {
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
          const response = await fetch(`${VPS_URL}/api/jda-trades/webhook`, {
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

let isBridgeScrapingBusy = false;

async function bridgeHeatmaps() {
  if (isBridgeScrapingBusy) {
    console.log('[Bridge] Scrape already in progress, skipping heatmap cycle.');
    return;
  }
  isBridgeScrapingBusy = true;

  let ws = null;
  try {
    const res = await fetch('http://localhost:9222/json');
    const tabs = await res.json();
    
    // Find a single coinglass heatmap tab
    const cgTab = tabs.find(t => t.type === 'page' && t.url?.includes('LiquidationHeatMap'));
    if (!cgTab) {
      console.log('[Bridge] Peringatan: Tab CoinGlass Liquidation Heatmap tidak ditemukan.');
      isBridgeScrapingBusy = false;
      return;
    }

    ws = new WebSocket(cgTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS timeout')), 3000);
      ws.on('open', () => { clearTimeout(t); resolve(); });
      ws.on('error', (err) => { clearTimeout(t); reject(err); });
    });

    let msgId = 1;
    const cdp = (method, params = {}) => new Promise((resOpt, rejOpt) => {
      const id = msgId++;
      ws.send(JSON.stringify({ id, method, params }));
      const t = setTimeout(() => rejOpt(new Error(`CDP timeout: ${method}`)), 15000);
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
    await cdp('Page.enable');

    const triggerClickExpr = `
      function triggerEvents(el) {
        var names = ['mouseenter', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'];
        names.forEach(function(n) {
          if (n === 'focus') el.focus();
          else el.dispatchEvent(new MouseEvent(n, { bubbles: true, cancelable: true, view: window }));
        });
      }
    `;

    async function selectPeriod(periodName) {
      // 1. Check if the active period is already what we want
      const checkCurrent = await cdp('Runtime.evaluate', {
        expression: `(function() {
          var P_PERIOD = /^\\d+\\s*(hour|day|week|month|h|d|w|m)s?$/i;
          var btns = Array.from(document.querySelectorAll('button'));
          for (var i = 0; i < btns.length; i++) {
            var txt = (btns[i].innerText || btns[i].textContent || '').trim();
            if (P_PERIOD.test(txt)) {
              return txt;
            }
          }
          return null;
        })()`,
        returnByValue: true
      });

      const currentPeriodText = checkCurrent?.result?.value;
      if (currentPeriodText) {
        const targetRegex = new RegExp('^' + periodName.replace(' ', '\\\\s*') + '$', 'i');
        if (targetRegex.test(currentPeriodText)) {
          console.log(`[Bridge] Periode sudah sesuai: ${currentPeriodText}. Tidak perlu klik.`);
          return true;
        }
      }

      // 2. Open the dropdown by clicking the button showing the current period text
      const dropdownClick = await cdp('Runtime.evaluate', {
        expression: `(function() {
          ${triggerClickExpr}
          var P_PERIOD = /^\\d+\\s*(hour|day|week|month|h|d|w|m)s?$/i;
          var btns = Array.from(document.querySelectorAll('button'));
          for (var i = 0; i < btns.length; i++) {
            var txt = (btns[i].innerText || btns[i].textContent || '').trim();
            if (P_PERIOD.test(txt)) {
              var r = btns[i].getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                triggerEvents(btns[i]);
                return JSON.stringify({ success: true, text: txt });
              }
            }
          }
          return JSON.stringify({ success: false });
        })()`,
        returnByValue: true
      });

      const dropdownRes = JSON.parse(dropdownClick?.result?.value || '{}');
      if (!dropdownRes.success) {
        console.warn(`[Bridge] Gagal menemukan tombol dropdown period.`);
        return false;
      }

      await new Promise(r => setTimeout(r, 2000));

      // 3. Click option in dropdown menu
      const dropdownItemClick = await cdp('Runtime.evaluate', {
        expression: `(function() {
          ${triggerClickExpr}
          var targetRegex = new RegExp('^' + '${periodName}'.replace(' ', '\\\\s*') + '$', 'i');
          var allElems = Array.from(document.querySelectorAll('li, button, div, span, a'));
          for (var i = 0; i < allElems.length; i++) {
            var txt = (allElems[i].innerText || allElems[i].textContent || '').trim();
            if (targetRegex.test(txt)) {
              var r = allElems[i].getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.left > 0 && r.top > 0) {
                triggerEvents(allElems[i]);
                return JSON.stringify({ success: true, text: txt });
              }
            }
          }
          return JSON.stringify({ success: false });
        })()`,
        returnByValue: true
      });

      const dropdownItemRes = JSON.parse(dropdownItemClick?.result?.value || '{}');
      return !!dropdownItemRes.success;
    }

    async function waitForPeriod(expect3d) {
      for (let attempt = 0; attempt < 10; attempt++) {
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
        const is3d = info.spanHours >= 48;
        if (expect3d === is3d) return true;
        await new Promise(r => setTimeout(r, 1000));
      }
      return false;
    }

    async function scrapeHeatmapData() {
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
      const raw = evalRes?.result?.value;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && !parsed.error && parsed.series && parsed.series.length > 0) {
        return parsed;
      }
      return null;
    }

    async function sendToVps(period, parsedData) {
      const postUrl = `${VPS_URL}/api/heatmap-data/update`;
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period,
          data: parsedData
        })
      });
      const resJson = await response.json();
      if (resJson.success) {
        console.log(`\n[Bridge] Sukses mengirim data Heatmap (${period}) ke VPS.`);
      } else {
        console.error(`\n[Bridge] Gagal mengirim data Heatmap (${period}): ${resJson.error}`);
      }
    }

    // Step 1: Scrape 24h
    console.log('\n[Bridge] Mengaktifkan periode 24h...');
    const status24h = await selectPeriod('24 hour');
    console.log(`[Bridge] 24h selectPeriod result: ${status24h}`);
    const update24h = await waitForPeriod(false);
    console.log(`[Bridge] 24h period update status: ${update24h}`);
    const data24h = await scrapeHeatmapData();
    if (data24h) {
      const xa = data24h.xAxis || [];
      const t0 = new Date(xa[0]).getTime();
      const t1 = new Date(xa[xa.length-1]).getTime();
      const span = Math.round((t1-t0)/3600000);
      console.log(`[Bridge] Scraped 24h data. Bars: ${xa.length}, Span: ${span}h`);
      await sendToVps('24h', data24h);
    } else {
      console.warn('[Bridge] Gagal scrape data Heatmap 24h.');
    }

    // Step 2: Scrape 3d
    console.log('[Bridge] Mengaktifkan periode 3d...');
    const status3d = await selectPeriod('3 day');
    console.log(`[Bridge] 3d selectPeriod result: ${status3d}`);
    const update3d = await waitForPeriod(true);
    console.log(`[Bridge] 3d period update status: ${update3d}`);
    const data3d = await scrapeHeatmapData();
    if (data3d) {
      const xa = data3d.xAxis || [];
      const t0 = new Date(xa[0]).getTime();
      const t1 = new Date(xa[xa.length-1]).getTime();
      const span = Math.round((t1-t0)/3600000);
      console.log(`[Bridge] Scraped 3d data. Bars: ${xa.length}, Span: ${span}h`);
      await sendToVps('3d', data3d);
    } else {
      console.warn('[Bridge] Gagal scrape data Heatmap 3d.');
    }

    // Step 3: Switch back to 24h (reset view)
    console.log('[Bridge] Mengembalikan periode ke 24h...');
    const statusReset = await selectPeriod('24 hour');
    console.log(`[Bridge] Reset selectPeriod result: ${statusReset}`);
    await waitForPeriod(false);

  } catch (e) {
    console.error('\n[Bridge Heatmap Error]:', e.message);
  } finally {
    if (ws) {
      try { ws.close(); } catch (wsErr) {}
    }
    isBridgeScrapingBusy = false;
  }
}

runBridge();
