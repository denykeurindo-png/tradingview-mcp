import WebSocket from 'ws';

async function inspect() {
  try {
    const res = await fetch('http://localhost:9222/json');
    const tabs = await res.json();
    const tvTab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
    if (!tvTab) {
      console.log('No tradingview tab found.');
      return;
    }
    console.log('Connecting to tab:', tvTab.title);
    const ws = new WebSocket(tvTab.webSocketDebuggerUrl);
    ws.on('open', async () => {
      let _mid = 1;
      const cdp = (method, params = {}) => new Promise((res, rej) => {
        const id = _mid++;
        ws.send(JSON.stringify({ id, method, params }));
        const t = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 5000);
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

      try {
        const evalExpr = `
          (() => {
            const studyItems = Array.from(document.querySelectorAll('[class*="study-"], .pane-legend-item'));
            const studyEl = studyItems.find(el => el.innerText && el.innerText.includes('JDAv85'));
            if (!studyEl) return { error: 'JDAv85 study element not found' };

            const getValueByTitle = (substring) => {
              const el = studyEl.querySelector(\`[data-test-id-value-title*="\${substring}"], [title*="\${substring}"]\`);
              if (!el) return null;
              const valEl = el.querySelector('[class*="valueValue-"]') || el;
              return valEl.innerText || '';
            };

            return {
              dir: getValueByTitle('dir'),
              entry: getValueByTitle('entry'),
              tp2: getValueByTitle('tp2') || getValueByTitle('tp1') || getValueByTitle('tp'),
              sl: getValueByTitle('sl')
            };
          })()
        `;
        const evalRes = await cdp('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
        console.log('Parsed values:', evalRes?.result?.value);
      } catch (err) {
        console.error('Error during eval:', err);
      } finally {
        ws.close();
      }
    });
  } catch (e) {
    console.error('Error connecting to debugger:', e);
  }
}

inspect();
