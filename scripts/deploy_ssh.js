import { Client } from 'ssh2';

console.log('[Deploy] Initiating SSH connection to VPS...');

const conn = new Client();
conn.on('ready', () => {
  console.log('[Deploy] SSH connection ready!');
  const cmd = 'git config --global --add safe.directory /home/binance/tradingview-mcp && cd tradingview-mcp && git pull origin main && pm2 restart trading-dashboard';
  console.log(`[Deploy] Executing commands: ${cmd}`);
  
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('[Deploy] Execution failed:', err.message);
      conn.end();
      process.exit(1);
    }
    
    stream.on('close', (code, signal) => {
      console.log(`[Deploy] Connection closed. Exit code: ${code}`);
      conn.end();
      process.exit(code);
    }).on('data', (data) => {
      process.stdout.write('[VPS] ' + data);
    }).stderr.on('data', (data) => {
      process.stderr.write('[VPS ERROR] ' + data);
    });
  });
}).on('error', (err) => {
  console.error('[Deploy] SSH connection error:', err.message);
  process.exit(1);
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
