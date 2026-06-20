import { Client } from 'ssh2';
import fs from 'fs';
import { WebSocket } from 'ws';

// This script will run on the VPS to capture a screenshot of Chromium
const scriptOnVps = `
import WebSocket from 'ws';
import fs from 'fs';

async function capture() {
  try {
    const tabsResp = await fetch('http://localhost:9222/json');
    const tabs = await tabsResp.json();
    const tab = tabs.find(t => t.type === 'page' && t.url.includes('coinglass.com'));
    if (!tab) {
      console.error('No coinglass tab found in Chrome.');
      process.exit(1);
    }
    console.log('Connecting to tab:', tab.title);
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Page.captureScreenshot',
        params: { format: 'png' }
      }));
    });
    ws.on('message', (data) => {
      const res = JSON.parse(data.toString());
      if (res.id === 1) {
        if (res.error) {
          console.error('Capture failed:', res.error);
        } else {
          fs.writeFileSync('vps_chrome.png', Buffer.from(res.result.data, 'base64'));
          console.log('Screenshot captured and saved to vps_chrome.png');
        }
        ws.close();
        process.exit(0);
      }
    });
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}
capture();
`;

const conn = new Client();
conn.on('ready', () => {
  // First, write the script file to the VPS
  conn.exec('cat > /tmp/capture_vps.js', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Script written to VPS.');
      // Execute the script on VPS
      conn.exec('node /tmp/capture_vps.js', (err2, stream2) => {
        if (err2) throw err2;
        stream2.on('close', (code2) => {
          console.log('Capture script executed on VPS. Code:', code2);
          // Download the screenshot
          conn.exec('cat ~/vps_chrome.png | base64', (err3, stream3) => {
            if (err3) throw err3;
            let base64Data = '';
            stream3.on('data', (chunk) => { base64Data += chunk.toString(); });
            stream3.on('close', () => {
              base64Data = base64Data.replace(/\\s/g, '');
              fs.writeFileSync('C:/Users/Server-Home/.gemini/antigravity-ide/brain/24ff50b6-1bdf-4787-b254-fa8df17719ec/vps_chrome.png', Buffer.from(base64Data, 'base64'));
              console.log('Downloaded VPS screenshot to artifacts/vps_chrome.png');
              conn.end();
            });
          });
        });
        stream2.stdout.on('data', (d) => console.log('VPS stdout:', d.toString()));
        stream2.stderr.on('data', (d) => console.error('VPS stderr:', d.toString()));
      });
    });
    stream.write(scriptOnVps);
    stream.end();
  });
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
