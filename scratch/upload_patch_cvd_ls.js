import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const script = fs.readFileSync(path.join(process.cwd(), 'scratch/patch_cvd_ls.py'), 'utf8');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error(err); conn.end(); return; }
    const ws = sftp.createWriteStream('/tmp/patch_cvd_ls.py');
    ws.write(script); ws.end();
    ws.on('close', () => {
      conn.exec('python3 /tmp/patch_cvd_ls.py', (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        stream.on('close', () => conn.end());
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
      });
    });
  });
}).on('error', e => { console.error(e); process.exit(1); })
  .connect({ host: '103.55.37.239', port: 22, username: 'binance', password: '!Yurika01' });
