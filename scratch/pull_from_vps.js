import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const filesToPull = [
  'src/dashboard/public/app.js',
  'src/dashboard/public/heatmap.html',
  'src/dashboard/public/heatmap.js',
  'src/dashboard/public/index.html',
  'src/dashboard/public/raw-data.html',
  'src/dashboard/public/raw-data.js',
  'src/dashboard/public/style.css',
  'src/dashboard/server.js'
];

console.log('[Pull] Connecting to VPS...');
const conn = new Client();

conn.on('ready', () => {
  console.log('[Pull] SSH connection established.');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('[Pull] SFTP error:', err.message);
      conn.end();
      process.exit(1);
    }

    let completed = 0;
    filesToPull.forEach(file => {
      const remotePath = `/home/binance/tradingview-mcp/${file}`;
      const localPath = path.join(process.cwd(), file);
      
      // Ensure local directory exists
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      console.log(`[Pull] Downloading ${file}...`);
      sftp.fastGet(remotePath, localPath, {}, (downloadErr) => {
        if (downloadErr) {
          console.error(`[Pull] Error downloading ${file}:`, downloadErr.message);
        } else {
          console.log(`[Pull] Successfully downloaded ${file}`);
        }
        
        completed++;
        if (completed === filesToPull.length) {
          console.log('[Pull] All downloads complete. Closing connection.');
          conn.end();
        }
      });
    });
  });
}).on('error', (err) => {
  console.error('[Pull] SSH connection error:', err.message);
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
