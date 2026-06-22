import WebSocket from 'ws';

async function main() {
  const listResp = await fetch('http://127.0.0.1:9222/json');
  const tabs = await listResp.json();
  const tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));

  if (!tab) {
    console.error('No CoinGlass tab found.');
    process.exit(1);
  }

  console.log('Connecting to tab:', tab.url);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));

  let msgId = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = msgId++;
    const t = setTimeout(() => rej(new Error('timeout')), 10000);
    const handler = raw => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        clearTimeout(t);
        ws.off('message', handler);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else {
        ws.once('message', handler);
      }
    };
    ws.once('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await cdp('Runtime.enable');

    const result = await cdp('Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector('.echarts-for-react');
          if (!el) return { error: 'No .echarts-for-react element found' };
          
          const keys = Object.keys(el);
          const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
          if (!fiberKey) return { error: 'No React fiber key found on element' };

          let fiber = el[fiberKey];
          let option = null;
          while (fiber) {
            if (fiber.memoizedProps && fiber.memoizedProps.option) {
              option = fiber.memoizedProps.option;
              break;
            }
            fiber = fiber.return;
          }

          if (!option) return { error: 'React fiber option not found' };

          return {
            xAxisType: typeof option.xAxis,
            xAxisIsArray: Array.isArray(option.xAxis),
            xAxisKeys: option.xAxis ? Object.keys(Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis) : null,
            xAxisDataSample: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis[0].data?.slice(0, 5) : option.xAxis.data?.slice(0, 5)) : null,
            yAxisType: typeof option.yAxis,
            yAxisIsArray: Array.isArray(option.yAxis),
            yAxisKeys: option.yAxis ? Object.keys(Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis) : null,
            yAxisDataLen: option.yAxis ? (Array.isArray(option.yAxis) ? option.yAxis[0].data?.length : option.yAxis.data?.length) : null,
            seriesLen: option.series ? option.series.length : 0
          };
        })()
      `,
      returnByValue: true
    });

    console.log('Inspection Result:', JSON.stringify(result?.result?.value, null, 2));

  } catch (e) {
    console.error('Error:', e);
  } finally {
    ws.close();
  }
}

main();
