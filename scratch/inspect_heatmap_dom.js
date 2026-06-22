import WebSocket from 'ws';

async function main() {
  const listResp = await fetch('http://127.0.0.1:9222/json');
  const tabs = await listResp.json();
  let tab = tabs.find(t => t.type === 'page' && t.url?.includes('coinglass.com'));
  let navigated = false;

  if (!tab) {
    tab = tabs.find(t => t.type === 'page' && t.url?.startsWith('http') && !t.url?.includes('devtools'));
    if (!tab) {
      console.error('No HTTP tab found.');
      process.exit(1);
    }
    navigated = true;
  }

  console.log('Connecting to tab:', tab.url);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));

  let msgId = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = msgId++;
    const t = setTimeout(() => rej(new Error('CDP timeout: ' + method)), 30000);
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
    await cdp('Page.enable');

    if (navigated || !tab.url.includes('LiquidationHeatMap')) {
      console.log('Navigating to LiquidationHeatMap...');
      await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap' });
      await new Promise(r => setTimeout(r, 10000));
    }

    console.log('Clicking 3 day button...');
    const clickRes = await cdp('Runtime.evaluate', {
      expression: `
        (() => {
          function rc(el) {
            ['mousedown','mouseup','click'].forEach(ev =>
              el.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window}))
            );
          }
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          var node;
          while (node = walker.nextNode()) {
            if (/^3\\s*day$/i.test(node.nodeValue.trim())) {
              var parent = node.parentElement;
              rc(parent);
              if (parent.parentElement) rc(parent.parentElement);
              return 'Clicked 3 day';
            }
          }
          return '3 day text not found';
        })()
      `,
      returnByValue: true
    });
    console.log('Click result:', clickRes?.result?.value);

    // Wait 5 seconds for render
    await new Promise(r => setTimeout(r, 5000));

    console.log('Inspecting chart component options...');
    const inspectRes = await cdp('Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector('.echarts-for-react');
          if (!el) return { error: 'No .echarts-for-react element found' };
          
          const keys = Object.keys(el);
          const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
          if (!fiberKey) return { error: 'No React fiber key found on element' };

          let fiber = el[fiberKey];
          let option = null;
          let propsFound = false;
          while (fiber) {
            if (fiber.memoizedProps) {
              propsFound = true;
              if (fiber.memoizedProps.option) {
                option = fiber.memoizedProps.option;
                break;
              }
            }
            fiber = fiber.return;
          }

          if (!option) {
            return { 
              error: 'React fiber option not found', 
              propsFound, 
              keys: Object.keys(el[fiberKey]?.memoizedProps || {}) 
            };
          }

          return {
            hasXAxis: !!option.xAxis,
            hasYAxis: !!option.yAxis,
            seriesKeys: option.series ? option.series.map(s => ({ name: s.name, type: s.type, hasData: !!s.data, dataLen: s.data ? s.data.length : 0 })) : null,
            visualMap: option.visualMap ? { min: option.visualMap.min, max: option.visualMap.max } : null
          };
        })()
      `,
      returnByValue: true
    });

    console.log('Inspection Result:', JSON.stringify(inspectRes?.result?.value, null, 2));

  } catch (e) {
    console.error('Error:', e);
  } finally {
    ws.close();
  }
}

main();
