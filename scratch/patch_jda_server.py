with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

# Replace entire scrapeHeatMap3D function with simpler, more reliable version
old_fn_start = '// ─── Heatmap 3D Scraper — dedicated tab approach ────────────────────────────\n// Uses a second Chrome tab kept alive with 3D period selected.'
old_fn_end = '\n// ─── Order Book Key Levels'

fn_start = src.find(old_fn_start)
fn_end = src.find(old_fn_end, fn_start)

NEW_FN = r"""// ─── Heatmap 3D Scraper ──────────────────────────────────────────────────────
// Uses the existing CoinGlass tab; navigates to heatmap and selects "3 day" period.
let heatmap3DTabId = null;

async function scrapeHeatMap3D() {
  const listResp = await fetch('http://localhost:9222/json/list', { signal: AbortSignal.timeout(5000) });
  const tabs = await listResp.json();

  // Use existing CoinGlass tab (has session cookies)
  const tab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('coinglass.com')) || null;
  if (!tab) throw new Error('No CoinGlass tab found for 3D scrape');

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

  // Select "3 day" period
  const clickResult = await cdp('Runtime.evaluate', {
    expression: `
      (async function() {
        function rc(el) {
          ['mousedown','mouseup','click'].forEach(ev =>
            el.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window}))
          );
        }

        // Walk all elements looking for "24 hour" text (using textContent — no innerText needed)
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var nodes24 = [];
        var node;
        while (node = walker.nextNode()) {
          if (/^24\\s*hour$/i.test(node.nodeValue.trim())) nodes24.push(node.parentElement);
        }

        if (nodes24.length === 0) {
          // Fallback: any element whose direct text content is "24 hour"
          var all = Array.from(document.querySelectorAll('*'));
          var el = all.find(e => /^24\\s*hour$/i.test(Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.nodeValue).join('').trim()));
          if (el) nodes24.push(el);
        }

        if (nodes24.length === 0) {
          return 'no 24h text node; page title=' + document.title.slice(0,40) + '; body text sample=' + document.body.innerText.slice(0,100).replace(/\\n/g,' ');
        }

        var el24 = nodes24[0];
        // Click el24 and ancestors up to 10 levels
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

        return 'no 3day found (clicked 24h el: ' + el24.tagName + ')';
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('[Heatmap3D] Period select result:', clickResult?.result?.value);

  // Wait for chart to re-render with 3D data
  await new Promise(r => setTimeout(r, 5000));

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
  if (!val) throw new Error('No 3D data returned');
  const parsed = JSON.parse(val);
  if (parsed.error) throw new Error('3D scrape: ' + parsed.error);

  return { data: parsed, timestamp: new Date().toISOString(), period: '3d' };
}

"""

if fn_start >= 0 and fn_end > fn_start:
    src = src[:fn_start] + NEW_FN + src[fn_end:]
    print('replaced scrapeHeatMap3D, len:', len(src))
else:
    print('ERROR: markers not found', fn_start, fn_end)

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)
print('done')
