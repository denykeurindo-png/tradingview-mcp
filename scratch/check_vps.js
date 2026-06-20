import { Client } from 'ssh2';

console.log('[VPS Check] Initiating SSH connection to VPS...');

const conn = new Client();
conn.on('ready', () => {
  console.log('[VPS Check] SSH connection ready!');
  const cmd = 'pm2 status && echo "=== OUT LOGS ===" && tail -n 40 ~/.pm2/logs/trading-dashboard-out.log && echo "=== ERROR LOGS ===" && tail -n 40 ~/.pm2/logs/trading-dashboard-error.log';
  console.log(`[VPS Check] Executing: ${cmd}\n`);
  
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('[VPS Check] Execution failed:', err.message);
      conn.end();
      process.exit(1);
    }
    
    // Timeout connection after 10 seconds to make sure it closes
    const timeout = setTimeout(() => {
      console.log('\n[VPS Check] Stream timeout, closing connection.');
      conn.end();
      process.exit(0);
    }, 10000);

    stream.on('close', (code, signal) => {
      clearTimeout(timeout);
      console.log(`\n[VPS Check] Connection closed. Exit code: ${code}`);
      conn.end();
      process.exit(code);
    }).on('data', (data) => {
      process.stdout.write(data.toString());
    }).stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });
  });
}).on('error', (err) => {
  console.error('[VPS Check] SSH connection error:', err.message);
  process.exit(1);
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
