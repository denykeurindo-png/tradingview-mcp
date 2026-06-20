import { Client } from 'ssh2';

const cmd = process.argv.slice(2).join(' ') || 'echo "no command specified"';
console.log(`[VPS Exec] Running command on VPS: "${cmd}"`);

const conn = new Client();
conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('[VPS Exec] Error:', err.message);
      conn.end();
      process.exit(1);
    }
    stream.on('close', (code) => {
      conn.end();
      process.exit(code);
    }).on('data', (data) => {
      process.stdout.write(data.toString());
    }).stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });
  });
}).on('error', (err) => {
  console.error('[VPS Exec] Connection error:', err.message);
  process.exit(1);
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
