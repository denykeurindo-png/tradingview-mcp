with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

# ══ 1. Add 3D cache variables after existing heatmap cache vars ══
old_cache = """// Heatmap cache variables
let heatmapDataCache = null;
let lastHeatmapFetchTime = null;
let isFetchingHeatmap = false;"""

new_cache = """// Heatmap cache variables
let heatmapDataCache = null;
let lastHeatmapFetchTime = null;
let isFetchingHeatmap = false;

// Heatmap 3D cache
let heatmap3DCache = null;
let lastHeatmap3DFetchTime = null;
let sweepPrediction3DCache = null;"""

cnt = src.count(old_cache)
src = src.replace(old_cache, new_cache, 1)
print('cache vars:', cnt)

# ══ 2. Add scrapeHeatMap3D() function after scrapeHeatMap() close ══
# Find the end of scrapeHeatMap function by looking for the next async function
SCRAPE3D = r"""
// ─── Heatmap 3D Scraper — selects "3 day" period before scraping ─────────────
async function scrapeHeatMap3D() {
  // Reuse the same Chrome tab as the 24H scraper
  const tabsResponse = await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(5000) });
  const tabs = await tabsResponse.json();
  const tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com')) || null;
  if (!tab) throw new Error('No CoinGlass tab found for 3D scrape');

  const ws = await new Promise((resolve, reject) => {
    const WebSocket = (await import('ws')).default;
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 4000);
  });

  let msgId = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = msgId++;
    const t = setTimeout(() => rej(new Error('CDP timeout: ' + method)), 30000);
    ws.once('message', function handler(raw) {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        clearTimeout(t);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else {
        ws.once('message', handler);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await cdp('Runtime.enable');

  // Click "3 day" period on the CoinGlass heatmap page
  const clickResult = await cdp('Runtime.evaluate', {
    expression: `
      (async function() {
        // Find all elements that contain period text
        var allText = document.querySelectorAll('*');
        var found = false;
        for (var el of allText) {
          if (el.children.length === 0 && /^(24|24h|24 hour)$/i.test(el.textContent.trim())) {
            var parent = el.closest('[class*="select"], [class*="picker"], [class*="dropdown"]') || el.parentElement;
            if (parent) { parent.click(); el.click(); found = true; break; }
          }
        }
        await new Promise(r => setTimeout(r, 900));
        // Click "3 day" option
        var opts = Array.from(document.querySelectorAll('[class*="option"], [class*="item"], li'));
        var dayOpt = opts.find(o => /3\\s*day/i.test(o.textContent.trim()) && o.offsetParent);
        if (dayOpt) { dayOpt.click(); return 'clicked 3day'; }
        return 'option not found (found=' + found + ')';
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('[Heatmap3D] Period select result:', clickResult?.result?.value);

  // Wait for chart to re-render with 3D data
  await new Promise(r => setTimeout(r, 3500));

  // Scrape the chart data (same extraction as scrapeHeatMap)
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
                  option = fiber.memoizedProps.option; break;
                }
                fiber = fiber.return;
              }
              if (option && option.series && option.series.length > 0) {
                resolve(JSON.stringify({
                  xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data : option.xAxis.data) : null,
                  yAxis: option.yAxis ? (Array.isArray(option.yAxis) ? option.yAxis[0].data : option.yAxis.data) : null,
                  series: option.series.map(s => ({ name: s.name, type: s.type, data: s.data })),
                  visualMap: option.visualMap ? { min: option.visualMap.min, max: option.visualMap.max } : null
                }));
                return;
              }
            }
          }
          if (Date.now() - start < 30000) setTimeout(check, 2000);
          else resolve(JSON.stringify({ error: 'timeout' }));
        }
        setTimeout(check, 2000);
      })
    `,
    awaitPromise: true,
    returnByValue: true
  });

  ws.close();

  const val = result?.result?.value;
  if (!val) throw new Error('Failed to get 3D heatmap data');
  const parsed = JSON.parse(val);
  if (parsed.error) throw new Error('3D scrape failed: ' + parsed.error);

  // Restore period back to 24H
  // (will naturally reset on next page reload)

  return { data: parsed, timestamp: new Date().toISOString(), period: '3d' };
}

"""

# Insert before the bot status variables
insert_anchor = '// Dedicated Liquidation Heatmap Scraper using React Fiber ECharts extraction'
cnt2 = src.count(insert_anchor)
src = src.replace(insert_anchor, SCRAPE3D + insert_anchor, 1)
print('scrapeHeatMap3D:', cnt2)

# ══ 3. Add /api/heatmap-data-3d endpoint ══
api3d = """app.get('/api/heatmap-data-3d', async (req, res) => {
  if (heatmap3DCache && lastHeatmap3DFetchTime && (Date.now() - lastHeatmap3DFetchTime < 600000)) {
    return res.json({ success: true, source: 'cache', data: heatmap3DCache });
  }
  if (heatmap3DCache) {
    return res.json({ success: true, source: 'stale-cache', data: heatmap3DCache });
  }
  res.status(503).json({ success: false, error: 'No 3D data yet, please wait for next cycle.' });
});

"""
anchor3d = "app.get('/api/heatmap-data',"
cnt3 = src.count(anchor3d)
src = src.replace(anchor3d, api3d + anchor3d, 1)
print('/api/heatmap-data-3d endpoint:', cnt3)

# ══ 4. Scrape 3D in bot cycle (after 24H scrape) ══
old_cycle = "    sweepPredictionCache = predictSweepTargets(_sweepInput, botMetrics);\n    console.log('[SweepPredict] Result:', sweepPredictionCache ? sweepPredictionCache.direction + ' ' + sweepPredictionCache.confidence + '%' : 'NULL');\n\n    console.log('[Background Bot] Cycle completed successfully."
new_cycle = """    sweepPredictionCache = predictSweepTargets(_sweepInput, botMetrics);
    console.log('[SweepPredict] Result:', sweepPredictionCache ? sweepPredictionCache.direction + ' ' + sweepPredictionCache.confidence + '%' : 'NULL');

    // Scrape 3D heatmap (non-blocking, every cycle but won't block main cycle)
    scrapeHeatMap3D().then(r3d => {
      heatmap3DCache = r3d;
      lastHeatmap3DFetchTime = Date.now();
      const hd3 = r3d.data;
      sweepPrediction3DCache = predictSweepTargets(hd3, botMetrics);
      console.log('[Heatmap3D] Scraped OK. Sweep3D:', sweepPrediction3DCache ? sweepPrediction3DCache.direction + ' ' + sweepPrediction3DCache.confidence + '%' : 'NULL');
    }).catch(e => console.error('[Heatmap3D] Scrape error:', e.message));

    console.log('[Background Bot] Cycle completed successfully."""
cnt4 = src.count(old_cycle)
src = src.replace(old_cycle, new_cycle, 1)
print('bot cycle 3D scrape:', cnt4)

# ══ 5. Add 3D to sweep prediction endpoint ══
old_ep = "  res.json({ success: true, data: sweepPredictionCache });"
new_ep = "  res.json({ success: true, data: sweepPredictionCache, data3d: sweepPrediction3DCache });"
cnt5 = src.count(old_ep)
src = src.replace(old_ep, new_ep, 1)
print('sweep endpoint 3D:', cnt5)

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)
print('server.js DONE')
