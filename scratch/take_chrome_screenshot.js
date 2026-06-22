import WebSocket from 'ws';
import fs from 'fs';

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
    await cdp('Page.enable');
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(screenshot.data, 'base64');
    fs.writeFileSync('c:\\Gemini\\Tv\\scratch\\chrome_screenshot.png', buffer);
    console.log('Screenshot saved to c:\\Gemini\\Tv\\scratch\\chrome_screenshot.png');
  } catch (e) {
    console.error('Error:', e);
  } finally {
    ws.close();
  }
}

main();
