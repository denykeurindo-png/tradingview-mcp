import WebSocket from 'ws';

async function testScraper() {
  const tabsResponse = await fetch('http://localhost:9222/json');
  const tabs = await tabsResponse.json();
  
  let tab = tabs.find(t => t.type === 'page' && (t.url?.includes('coinglass.com') || t.url?.includes('error-view')));
  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
  }
  
  if (!tab) {
    console.error('No suitable tab found.');
    return;
  }

  const originalUrl = tab.url;
  console.log(`Connecting to tab: ${tab.title} (${tab.url})`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);

  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  console.log('Connected!');

  let mid = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = mid++;
    ws.send(JSON.stringify({ id, method, params }));
    const handler = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === id) {
        ws.off('message', handler);
        if (m.error) rej(m.error);
        else res(m.result);
      }
    };
    ws.on('message', handler);
  });

  await cdp('Page.enable');

  console.log('Navigating to liquidation heatmap page...');
  await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap' });

  console.log('Waiting 25 seconds for chart rendering...');
  await new Promise(resolve => setTimeout(resolve, 25000));

  console.log('Extracting options axes details...');
  const result = await cdp('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          const el = document.querySelector('.echarts-for-react');
          if (!el) return JSON.stringify({ error: 'Element .echarts-for-react not found' });
          
          const keys = Object.keys(el);
          const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
          if (!fiberKey) return JSON.stringify({ error: 'React fiber key not found' });
          
          let fiber = el[fiberKey];
          let option = null;
          while (fiber) {
            if (fiber.memoizedProps && fiber.memoizedProps.option) {
              option = fiber.memoizedProps.option;
              break;
            }
            fiber = fiber.return;
          }
          
          if (!option) return JSON.stringify({ error: 'Option not found' });
          
          // Let's dump all keys and some values from xAxis and yAxis
          const dumpAxis = (axis) => {
            if (!axis) return null;
            if (Array.isArray(axis)) {
              return axis.map(a => ({
                type: a.type,
                min: a.min,
                max: a.max,
                keys: Object.keys(a),
                dataLength: a.data ? a.data.length : 0,
                dataSample: a.data ? a.data.slice(0, 5) : null
              }));
            }
            return {
              type: axis.type,
              min: axis.min,
              max: axis.max,
              keys: Object.keys(axis),
              dataLength: axis.data ? axis.data.length : 0,
              dataSample: axis.data ? axis.data.slice(0, 5) : null
            };
          };

          return JSON.stringify({
            xAxis: dumpAxis(option.xAxis),
            yAxis: dumpAxis(option.yAxis),
            visualMap: option.visualMap ? {
              min: option.visualMap.min,
              max: option.visualMap.max,
              keys: Object.keys(option.visualMap)
            } : null
          });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `,
    returnByValue: true
  });

  console.log('Axes Analysis:');
  console.log(JSON.stringify(JSON.parse(result.result.value), null, 2));

  console.log('Restoring original URL:', originalUrl);
  await cdp('Page.navigate', { url: originalUrl });
  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('Done!');
  ws.close();
}

testScraper().catch(console.error);
