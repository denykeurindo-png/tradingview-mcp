import WebSocket from 'ws';
import fs from 'fs';

async function inspect() {
  try {
    const res = await fetch('http://localhost:9222/json');
    const tabs = await res.json();
    const tvTab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com/chart'));
    if (!tvTab) {
      console.log('No tradingview tab found.');
      return;
    }
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
            const elements = Array.from(document.querySelectorAll('*'));
            const match = elements.find(el => el.innerText && el.innerText.includes('JDAv85-FSVZO & ZLEMA') && el.className && el.className.includes('study-'));
            if (match) {
              return {
                className: match.className,
                innerText: match.innerText,
                innerHTML: match.innerHTML
              };
            }
            return 'Not found';
          })()
        `;
        const evalRes = await cdp('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
        const result = evalRes?.result?.value;
        fs.writeFileSync('scratch/inspect_innerHTML_output.json', JSON.stringify(result, null, 2));
        console.log('Written output to scratch/inspect_innerHTML_output.json');
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
