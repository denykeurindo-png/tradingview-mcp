import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
const s = fs.readFileSync(path.join(process.cwd(), 'scratch/fix_appjs2.py'), 'utf8');
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    const ws = sftp.createWriteStream('/tmp/fix_appjs2.py');
    ws.write(s); ws.end();
    ws.on('close', () => conn.exec(
      'python3 /tmp/fix_appjs2.py && node --check /home/binance/tradingview-mcp/src/dashboard/public/app.js 2>&1 && echo SYNTAX_OK',
      (e, st) => {
        st.on('close', () => conn.end());
        st.on('data', d => process.stdout.write(d.toString()));
        st.stderr.on('data', d => process.stderr.write(d.toString()));
      }
    ));
  });
}).on('error', e => { console.error(e); process.exit(1); })
  .connect({ host: '103.55.37.239', port: 22, username: 'binance', password: '!Yurika01' });
