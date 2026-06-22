import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const script = fs.readFileSync(path.join(process.cwd(), 'scratch/inspect_3day.js'), 'utf8');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error(err); conn.end(); return; }
    const ws = sftp.createWriteStream('/home/binance/tradingview-mcp/scratch/inspect_3day.js');
    ws.write(script); ws.end();
    ws.on('close', () => {
      conn.exec('cd /home/binance/tradingview-mcp && node scratch/inspect_3day.js', (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        stream.on('close', () => conn.end());
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
      });
    });
  });
}).on('error', e => { console.error(e.message); process.exit(1); })
  .connect({ host: '103.55.37.239', port: 22, username: 'binance', password: '!Yurika01' });
