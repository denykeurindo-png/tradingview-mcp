// Backfills real historical OHLC candles from Binance (source of truth, independent
// of CoinGlass's own heatmap candle resolution) into sweep_events.db, for backtesting
// sweep-detection / SL-TP / probability logic changes against known price action.
//
// Usage: node scripts/backfill_candles_to_db.js [days] [interval]
//   days      default 60
//   interval  default 15m (Binance kline interval string)
//
// Safe to re-run: INSERT OR IGNORE keyed on (timeframe, open_time), so re-running
// just fills any gaps / extends the range without duplicating rows.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../src/dashboard/sweep_events.db');
const SYMBOL = 'BTCUSDT';

const days = parseInt(process.argv[2], 10) || 60;
const interval = process.argv[3] || '15m';

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    open_time INTEGER,
    timeframe TEXT,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    source TEXT,
    UNIQUE(timeframe, open_time)
  );
  CREATE INDEX IF NOT EXISTS idx_candles_time ON candles(open_time);
  CREATE INDEX IF NOT EXISTS idx_candles_tf ON candles(timeframe);
`);

const insert = db.prepare(`
  INSERT OR IGNORE INTO candles (open_time, timeframe, open, high, low, close, source)
  VALUES (?, ?, ?, ?, ?, ?, 'binance_backfill')
`);

const endTime = Date.now();
const startTime = endTime - days * 24 * 60 * 60 * 1000;
const LIMIT = 1500;

console.log(`[Backfill] Fetching ${SYMBOL} ${interval} candles for the last ${days} days...`);

let cursor = startTime;
let totalInserted = 0;
let totalFetched = 0;

while (cursor < endTime) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${cursor}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[Backfill] Fetch failed: HTTP ${res.status}`);
    break;
  }
  const klines = await res.json();
  if (!Array.isArray(klines) || klines.length === 0) break;

  db.exec('BEGIN');
  for (const k of klines) {
    const [openTime, open, high, low, close] = k;
    insert.run(openTime, interval, parseFloat(open), parseFloat(high), parseFloat(low), parseFloat(close));
    totalInserted++;
  }
  db.exec('COMMIT');
  totalFetched += klines.length;

  const lastOpenTime = klines[klines.length - 1][0];
  console.log(`[Backfill] Fetched ${klines.length} candles up to ${new Date(lastOpenTime).toISOString()} (${totalFetched} total so far)`);

  if (klines.length < LIMIT) break; // reached the end
  cursor = lastOpenTime + 1;
  await new Promise(r => setTimeout(r, 200)); // be polite to the API
}

const total = db.prepare(`SELECT COUNT(*) c FROM candles WHERE timeframe = ?`).get(interval);
console.log(`[Backfill] Done. ${totalFetched} candles fetched, ${totalInserted} insert attempts, ${total.c} total ${interval} candles now in DB.`);
db.close();
