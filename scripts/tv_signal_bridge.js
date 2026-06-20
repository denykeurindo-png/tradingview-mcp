import WebSocket from 'ws';

const VPS_URL = 'http://103.55.37.239:4000';
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
      // Mengekstrak teks legenda indikator dari layar chart
      const evalExpr = `
        (() => {
          const legendItems = Array.from(document.querySelectorAll('[class*="legend-item-"], .pane-legend-item'));
          for (const item of legendItems) {
            const text = item.innerText || '';
            if (text.includes('JDAv85') && text.includes('_sig_dir')) {
              return text;
            }
          }
          const statusLines = Array.from(document.querySelectorAll('.pane-legend-line, [class*="legend-line-"]'));
          for (const line of statusLines) {
            const text = line.innerText || '';
            if (text.includes('JDAv85') && text.includes('_sig_dir')) {
              return text;
            }
          }
          return null;
        })()
      `;

      const evalRes = await cdp('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
      const rawText = evalRes?.result?.value;

      if (!rawText) {
        console.log('[Bridge] Menunggu indikator JDAv85 ditambahkan ke chart...');
        return;
      }

      // Parsing data sinyal menggunakan regex
      const dirMatch   = rawText.match(/_sig_dir:?\s*([-.\d]+)/);
      const entryMatch = rawText.match(/_sig_entry:?\s*([-.\d]+)/);
      const tpMatch    = rawText.match(/_sig_tp2:?\s*([-.\d]+)/);
      const slMatch    = rawText.match(/_sig_sl:?\s*([-.\d]+)/);

      if (!dirMatch || !entryMatch) {
        console.log('[Bridge] Indikator ditemukan, tetapi data sinyal belum ter-plot.');
        return;
      }

      const dir = parseInt(dirMatch[1], 10);
      const entry = parseFloat(entryMatch[1]);
      const tp = tpMatch ? parseFloat(tpMatch[1]) : 0;
      const sl = slMatch ? parseFloat(slMatch[1]) : 0;

      // Status log berkala
      process.stdout.write(`\r[Bridge Monitoring] Dir: ${dir} | Entry: $${entry} | TP: $${tp} | SL: $${sl}`);

      // Deteksi perubahan sinyal
      if (dir !== lastState.dir || entry !== lastState.entry) {
        console.log(`\n[Bridge] Deteksi perubahan sinyal! (Dir Lama: ${lastState.dir} -> Dir Baru: ${dir})`);

        if (dir === 1 || dir === -1) {
          const direction = dir === 1 ? 'LONG' : 'SHORT';
          console.log(`[Bridge] Mengirim trade ${direction} ke VPS...`);

          const response = await fetch(`${VPS_URL}/api/trades/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              direction,
              entry,
              tp,
              sl,
              capital: 1000,
              riskPercent: 1.0,
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
          const response = await fetch(`${VPS_URL}/api/trades/cut`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              closePrice: entry
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
}

runBridge();
