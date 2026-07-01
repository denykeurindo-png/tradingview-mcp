import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localTradesFile = path.join(__dirname, '../src/dashboard/trades.json');
const remoteTradesFile = '/home/binance/tradingview-mcp/src/dashboard/trades.json';

// Read SSH credentials from deploy_ssh.js config (same host/user/pass)
const SSH_HOST = '103.55.37.239';
const SSH_USER = 'binance';
const deployContent = fs.readFileSync(path.join(__dirname, 'deploy_ssh.js'), 'utf8');
const passMatch = deployContent.match(/password:\s*'([^']+)'/);
if (!passMatch) { console.error('Cannot read SSH password from deploy_ssh.js'); process.exit(1); }
const SSH_PASS = passMatch[1];

if (!fs.existsSync(localTradesFile)) {
  console.error(`Local trades file not found at ${localTradesFile}`);
  process.exit(1);
}

console.log('[Deploy Trades] Initiating SSH connection to VPS...');

const conn = new Client();
conn.on('ready', () => {
  console.log('[Deploy Trades] SSH connection ready!');
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('[Deploy Trades] SFTP session failed:', err.message);
      conn.end();
      process.exit(1);
    }
    
    console.log('[Deploy Trades] SFTP session opened. Uploading trades.json...');
    
    const readStream = fs.createReadStream(localTradesFile);
    const writeStream = sftp.createWriteStream(remoteTradesFile);
    
    writeStream.on('close', () => {
      console.log(`[Deploy Trades] Successfully uploaded trades.json to VPS at ${remoteTradesFile}!`);
      
      // Restart pm2 trading-dashboard to ensure server loads new trades
      console.log('[Deploy Trades] Restarting PM2 trading-dashboard...');
      conn.exec('pm2 restart trading-dashboard', (err, stream) => {
        if (err) {
          console.error('[Deploy Trades] PM2 restart execution failed:', err.message);
          conn.end();
          process.exit(1);
        }
        
        stream.on('close', (code) => {
          console.log(`[Deploy Trades] PM2 restarted. Exit code: ${code}`);
          conn.end();
          process.exit(code);
        }).on('data', (data) => {
          process.stdout.write('[VPS] ' + data);
        });
      });
    });
    
    writeStream.on('error', (err) => {
      console.error('[Deploy Trades] SFTP upload error:', err.message);
      conn.end();
      process.exit(1);
    });
    
    readStream.pipe(writeStream);
  });
}).on('error', (err) => {
  console.error('[Deploy Trades] SSH connection error:', err.message);
  process.exit(1);
}).connect({
  host: SSH_HOST,
  port: 22,
  username: SSH_USER,
  password: SSH_PASS
});
