import { Client } from 'ssh2';
import fs from 'fs';

const vpsScript = `
import { WebSocket } from 'ws';
import fs from 'fs';

async function main() {
  try {
    const tabsResp = await fetch('http://localhost:9222/json');
    const tabs = await tabsResp.json();
    const tab = tabs.find(t => t.type === 'page' && t.url.includes('coinglass.com'));
    if (!tab) {
      console.error('No CoinGlass tab found.');
      process.exit(1);
    }
    console.log('Connecting to WebSocket:', tab.webSocketDebuggerUrl);
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Page.captureScreenshot',
        params: {}
      }));
    });
    ws.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.id === 1) {
        if (data.error) {
          console.error('Screenshot error:', data.error);
        } else {
          fs.writeFileSync('vps_chrome.png', Buffer.from(data.result.data, 'base64'));
          console.log('Screenshot saved to vps_chrome.png');
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
main();
`;

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH connection ready!');
  // Write the script to the VPS project scratch folder
  conn.exec('cat > ~/tradingview-mcp/scratch/capture.js', (err, stream) => {
    if (err) throw err;
    stream.on('close', () => {
      console.log('Capture script written to VPS.');
      // Execute the script
      conn.exec('node ~/tradingview-mcp/scratch/capture.js', (err2, stream2) => {
        if (err2) throw err2;
        stream2.on('close', (code) => {
          console.log('Capture script completed on VPS with code:', code);
          // Download the screenshot
          conn.exec('cat ~/tradingview-mcp/vps_chrome.png | base64', (err3, stream3) => {
            if (err3) throw err3;
            let b64 = '';
            stream3.on('data', (d) => b64 += d.toString());
            stream3.on('close', () => {
              b64 = b64.replace(/\s/g, '');
              if (b64.length > 0) {
                fs.writeFileSync('C:/Users/Server-Home/.gemini/antigravity-ide/brain/24ff50b6-1bdf-4787-b254-fa8df17719ec/vps_chrome.png', Buffer.from(b64, 'base64'));
                console.log('Successfully saved screenshot to artifacts/vps_chrome.png');
              } else {
                console.error('Downloaded screenshot is empty.');
              }
              conn.end();
            });
          });
        });
        stream2.stdout.on('data', (d) => console.log('VPS stdout:', d.toString()));
        stream2.stderr.on('data', (d) => console.error('VPS stderr:', d.toString()));
      });
    });
    stream.write(vpsScript);
    stream.end();
  });
}).on('error', (err) => {
  console.error('SSH Error:', err.message);
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
