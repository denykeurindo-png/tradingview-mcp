import { Client } from 'ssh2';

const conn = new Client();
conn.on('ready', () => {
  console.log('[SSH] Connection established.');
  
  // We want to see:
  // 1. Recent pm2 logs (specifically look for [JDA Webhook] or [TradingView Webhook])
  // 2. The most recent trades in trades.json
  const cmd = 'tail -n 100 ~/.pm2/logs/trading-dashboard-out.log';
  
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('[SSH] Command execution failed:', err);
      conn.end();
      return;
    }
    
    let output = '';
    stream.on('data', (data) => {
      output += data.toString();
    }).on('close', () => {
      console.log('=== PM2 OUT LOG ===');
      console.log(output);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.error('[SSH] Connection error:', err);
}).connect({
  host: '103.55.37.239',
  port: 22,
  username: 'binance',
  password: '!Yurika01'
});
