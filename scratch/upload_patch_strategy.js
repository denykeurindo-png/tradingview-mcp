import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
const s = fs.readFileSync(path.join(process.cwd(), 'scratch/inspect_dom.py'), 'utf8');
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    const ws = sftp.createWriteStream('/tmp/inspect_dom.py');
    ws.write(s); ws.end();
    ws.on('close', () => conn.exec(
      'pip install websocket-client -q 2>/dev/null; python3 /tmp/inspect_dom.py',
      (e, st) => {
        st.on('close', () => conn.end());
        st.on('data', d => process.stdout.write(d.toString()));
        st.stderr.on('data', d => process.stderr.write(d.toString()));
      }
    ));
  });
}).on('error', e => { console.error(e); process.exit(1); })
  .connect({ host: '103.55.37.239', port: 22, username: 'binance', password: '!Yurika01' });
