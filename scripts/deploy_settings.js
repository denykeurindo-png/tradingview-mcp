import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(__dirname, '../src/dashboard/settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Read SSH credentials from deploy_ssh.js config (same host/user/pass)
const SSH_HOST = '103.55.37.239';
const SSH_USER = 'binance';
const SSH_PASS_FILE = path.join(__dirname, 'deploy_ssh.js');
const deployContent = fs.readFileSync(SSH_PASS_FILE, 'utf8');
const passMatch = deployContent.match(/password:\s*'([^']+)'/);
if (!passMatch) { console.error('Cannot read SSH password from deploy_ssh.js'); process.exit(1); }
const SSH_PASS = passMatch[1];

const jsonContent = JSON.stringify(settings, null, 2);
const remotePath = '/home/binance/tradingview-mcp/src/dashboard/settings.json';

console.log('[Settings Deploy] Connecting to VPS...');
console.log('[Settings Deploy] Applying:');
console.log(`  minReversalProbability    : ${settings.minReversalProbability}%`);
console.log(`  sweepConfirmCandles       : ${settings.sweepConfirmCandles}`);
console.log(`  minCoinbasePremiumForLongs: ${settings.minCoinbasePremiumForLongs}`);

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error('[Settings Deploy] SFTP error:', err.message); conn.end(); process.exit(1); }

    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on('close', () => {
      console.log('[Settings Deploy] settings.json uploaded to VPS.');
      // Restart dashboard to pick up new settings
      conn.exec('pm2 restart trading-dashboard', (err2, stream) => {
        if (err2) { console.error(err2.message); conn.end(); return; }
        stream.on('close', (code) => {
          console.log(`[Settings Deploy] pm2 restart done. Exit: ${code}`);
          conn.end();
          process.exit(code);
        }).on('data', d => process.stdout.write('[VPS] ' + d))
          .stderr.on('data', d => process.stdout.write('[VPS] ' + d));
      });
    });
    writeStream.on('error', e => { console.error('[Settings Deploy] Write error:', e.message); conn.end(); });
    writeStream.write(jsonContent);
    writeStream.end();
  });
}).on('error', err => {
  console.error('[Settings Deploy] SSH error:', err.message);
  process.exit(1);
}).connect({ host: SSH_HOST, port: 22, username: SSH_USER, password: SSH_PASS });
