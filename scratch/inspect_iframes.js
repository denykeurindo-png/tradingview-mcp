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
        // Evaluate iframes on the page
        const evalExpr = `
          (() => {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            return iframes.map(f => ({
              id: f.id,
              className: f.className,
              src: f.src,
              name: f.name
            }));
          })()
        `;
        const evalRes = await cdp('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
        console.log('Iframes:', JSON.stringify(evalRes?.result?.value, null, 2));

        // Let's also check all elements with text containing 'JDAv85' but this time inspect any iframes if we can
        const evalExpr2 = `
          (() => {
            const results = [];
            function search(doc, path = 'main') {
              try {
                const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
                let node = walker.nextNode();
                while (node) {
                  if (node.innerText && node.innerText.includes('JDAv85')) {
                    results.push({
                      path,
                      tagName: node.tagName,
                      className: node.className,
                      text: node.innerText.substring(0, 150)
                    });
                  }
                  node = walker.nextNode();
                }
              } catch (e) {
                results.push({ path, error: e.message });
              }

              // Search iframes
              try {
                const iframes = doc.querySelectorAll('iframe');
                iframes.forEach((iframe, idx) => {
                  try {
                    if (iframe.contentDocument) {
                      search(iframe.contentDocument, path + ' -> iframe[' + idx + '] (id=' + iframe.id + ')');
                    }
                  } catch (e) {
                    results.push({ path: path + ' -> iframe[' + idx + ']', error: 'Same-origin block: ' + e.message });
                  }
                });
              } catch(e) {}
            }
            search(document);
            return results;
          })()
        `;
        const evalRes2 = await cdp('Runtime.evaluate', { expression: evalExpr2, returnByValue: true });
        console.log('Search Results:', JSON.stringify(evalRes2?.result?.value, null, 2));
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
