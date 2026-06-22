import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const scripts = [
  ['patch_jda_server.py', '/tmp/patch_jda_server.py'],
  ['patch_jda_frontend.py', '/tmp/patch_jda_frontend.py'],
];

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error(err); conn.end(); return; }

    let pending = scripts.length;
    for (const [local, remote] of scripts) {
      const content = fs.readFileSync(path.join(process.cwd(), 'scratch', local), 'utf8');
      const ws = sftp.createWriteStream(remote);
      ws.write(content); ws.end();
      ws.on('close', () => {
        if (--pending === 0) runPatches();
      });
    }
  });
});

function runPatches() {
  const cmds = scripts.map(([, r]) => 'python3 ' + r).join(' && ');
  conn.exec(cmds, (err, stream) => {
    if (err) { console.error(err); conn.end(); return; }
    stream.on('close', () => conn.end());
    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stderr.write(d.toString()));
  });
}

conn.on('error', e => { console.error(e); process.exit(1); })
    .connect({ host: '103.55.37.239', port: 22, username: 'binance', password: '!Yurika01' });
