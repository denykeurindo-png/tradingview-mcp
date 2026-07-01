// Imports LSR bot event history into a queryable SQLite database:
//   1. The raw pm2 stdout log (tv-monitor-out.log) — unstructured, no timestamps
//      before 2026-07-01 (pm2 log_date_format was only added then). Events from
//      before that are inserted with timestamp = NULL and rely on `seq` (original
//      line order) for chronological ordering.
//   2. src/dashboard/sweep_history.json — structured, real timestamps.
//
// Safe to re-run: it wipes and rebuilds both source partitions each time, so
// re-running never produces duplicates. Schema must stay in sync with the
// live-insert setup in src/dashboard/server.js (insertSweepEventToDb).
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../src/dashboard/sweep_events.db');
const PM2_LOG_PATH = path.join(os.homedir(), '.pm2/logs/tv-monitor-out.log');
const SWEEP_HISTORY_PATH = path.join(__dirname, '../src/dashboard/sweep_history.json');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS sweep_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER,
    timestamp INTEGER,
    phase TEXT,
    direction TEXT,
    pool_price REAL,
    pool_side TEXT,
    pool_distance TEXT,
    pool_volume REAL,
    message TEXT,
    source TEXT,
    reversal_prob REAL,
    rr_actual REAL,
    min_prob REAL,
    min_rr REAL
  );
  CREATE INDEX IF NOT EXISTS idx_phase ON sweep_events(phase);
  CREATE INDEX IF NOT EXISTS idx_source ON sweep_events(source);
  CREATE INDEX IF NOT EXISTS idx_seq ON sweep_events(seq);

  DROP VIEW IF EXISTS sweep_events_staged;
  CREATE VIEW sweep_events_staged AS
  SELECT
    id, seq, timestamp, phase, direction, pool_price, pool_side, pool_distance, pool_volume,
    message, source, reversal_prob, rr_actual, min_prob, min_rr,
    CASE phase
      WHEN 'STANDBY'           THEN 'ACTIVE'
      WHEN 'ALERT'             THEN 'PASS'
      WHEN 'SWEEP_DETECTED'    THEN 'PASS'
      WHEN 'SWEEP_REJECTED'    THEN 'PASS'
      WHEN 'TRADE_EXECUTED'    THEN 'PASS'
      WHEN 'CONFLICTING_SWEEP' THEN 'PASS'
      ELSE NULL
    END AS stage1_pool_detect,
    CASE phase
      WHEN 'ALERT'             THEN 'ACTIVE'
      WHEN 'SWEEP_DETECTED'    THEN 'PASS'
      WHEN 'SWEEP_REJECTED'    THEN 'PASS'
      WHEN 'TRADE_EXECUTED'    THEN 'PASS'
      WHEN 'CONFLICTING_SWEEP' THEN 'PASS'
      ELSE 'IDLE'
    END AS stage2_price_alert,
    CASE phase
      WHEN 'SWEEP_DETECTED'    THEN 'DETECTED'
      WHEN 'SWEEP_REJECTED'    THEN 'PASS'
      WHEN 'TRADE_EXECUTED'    THEN 'PASS'
      WHEN 'CONFLICTING_SWEEP' THEN 'CONFLICT'
      ELSE 'IDLE'
    END AS stage3_sweep_detect,
    CASE phase
      WHEN 'SWEEP_DETECTED' THEN 'CHECKING'
      WHEN 'SWEEP_REJECTED' THEN 'REJECTED'
      WHEN 'TRADE_EXECUTED' THEN 'ALL_PASS'
      ELSE 'IDLE'
    END AS stage4_filter_gates,
    CASE phase
      WHEN 'TRADE_EXECUTED' THEN 'LIVE'
      WHEN 'COOLDOWN'       THEN 'COOLDOWN'
      WHEN 'MAX_ACTIVE'     THEN 'MAX_ACTIVE'
      ELSE 'IDLE'
    END AS stage5_trade_active
  FROM sweep_events;
`);

// ─── Part 1: historical unstructured pm2 log ────────────────────────────────
function classifyAndParse(line) {
  const msg = line.replace(/^.*\[LSR Bot\]\s*/, '').trim();
  const base = { pool_side: null, pool_distance: null, reversal_prob: null, rr_actual: null, min_prob: null, min_rr: null };

  let m;
  if (/TRADE EXECUTED/.test(msg)) {
    m = msg.match(/(LONG|SHORT) Entry:\$([\d.]+) TP:\$([\d.]+) SL:\$([\d.]+) R:R 1:([\d.]+)/);
    return { ...base, phase: 'TRADE_EXECUTED', direction: m?.[1] || null, pool_price: m ? parseFloat(m[2]) : null, rr_actual: m ? parseFloat(m[5]) : null, message: msg };
  }
  if (/FORCE_SKIP/.test(msg)) {
    m = msg.match(/for (LONG|SHORT) at \$([\d.]+)/);
    return { ...base, phase: 'SWEEP_REJECTED', direction: m?.[1] || null, pool_price: m ? parseFloat(m[2]) : null, message: msg };
  }
  if (/SWEEP_REJECTED/.test(msg)) {
    const rrM   = msg.match(/R:R ([\d.]+) < min ([\d.]+) for (LONG|SHORT) at \$([\d.]+)/);
    const probM = msg.match(/Reversal Prob (\d+)% < min (\d+)% for (LONG|SHORT) at \$([\d.]+)/);
    if (rrM) {
      return { ...base, phase: 'SWEEP_REJECTED', direction: rrM[3], pool_price: parseFloat(rrM[4]), rr_actual: parseFloat(rrM[1]), min_rr: parseFloat(rrM[2]), message: msg };
    }
    if (probM) {
      return { ...base, phase: 'SWEEP_REJECTED', direction: probM[3], pool_price: parseFloat(probM[4]), reversal_prob: parseFloat(probM[1]), min_prob: parseFloat(probM[2]), message: msg };
    }
    m = msg.match(/for (LONG|SHORT) at \$([\d.]+)/);
    return { ...base, phase: 'SWEEP_REJECTED', direction: m?.[1] || null, pool_price: m ? parseFloat(m[2]) : null, message: msg };
  }
  if (/CONFLICTING_SWEEP/.test(msg)) {
    m = msg.match(/(LONG|SHORT) at \$([\d.]+)/);
    return { ...base, phase: 'CONFLICTING_SWEEP', direction: m?.[1] || null, pool_price: m ? parseFloat(m[2]) : null, message: msg };
  }
  if (/COOLDOWN/.test(msg)) {
    m = msg.match(/(LONG|SHORT)/);
    return { ...base, phase: 'COOLDOWN', direction: m?.[1] || null, pool_price: null, message: msg };
  }
  if (/POOL_CHANGED/.test(msg)) {
    return { ...base, phase: 'POOL_CHANGED', direction: null, pool_price: null, message: msg };
  }
  if (/^ALERT/.test(msg)) {
    m = msg.match(/(RESISTANCE|SUPPORT) pool \$([\d.]+) \(([\d.]+)%\)/);
    const probM = msg.match(/Preview prob: (\d+)%/);
    return { ...base, phase: 'ALERT', direction: null, pool_price: m ? parseFloat(m[2]) : null, pool_side: m?.[1] || null, pool_distance: m ? m[3] + '%' : null, reversal_prob: probM ? parseFloat(probM[1]) : null, message: msg };
  }
  if (/^STANDBY/.test(msg)) {
    m = msg.match(/nearest pool \$([\d.]+) \(([\d.]+)%\)/);
    const probM = msg.match(/Preview prob: (\d+)%/);
    return { ...base, phase: 'STANDBY', direction: null, pool_price: m ? parseFloat(m[1]) : null, pool_distance: m ? m[2] + '%' : null, reversal_prob: probM ? parseFloat(probM[1]) : null, message: msg };
  }
  if (/Hit TP|Hit SL|AUTO-CUT TRIGGERED|Breakeven/.test(msg)) {
    m = msg.match(/(LONG|SHORT)/);
    const priceMatch = msg.match(/\$([\d.]+)/);
    return { ...base, phase: 'POSITION_MGMT', direction: m?.[1] || null, pool_price: priceMatch ? parseFloat(priceMatch[1]) : null, message: msg };
  }
  return null; // unrecognized [LSR Bot] line (e.g. "Sweep pool: ..." detail line) — skip
}

console.log('[Import] Clearing previous pm2_log rows...');
db.exec(`DELETE FROM sweep_events WHERE source = 'pm2_log'`);

if (!fs.existsSync(PM2_LOG_PATH)) {
  console.log(`[Import] pm2 log not found at ${PM2_LOG_PATH}, skipping historical import.`);
} else {
  console.log('[Import] Reading pm2 log (this is a large file, may take a moment)...');
  const raw = fs.readFileSync(PM2_LOG_PATH, 'utf8');
  const lines = raw.split('\n');

  const insert = db.prepare(`
    INSERT INTO sweep_events (seq, timestamp, phase, direction, pool_price, pool_side, pool_distance, pool_volume, message, source, reversal_prob, rr_actual, min_prob, min_rr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pm2_log', ?, ?, ?, ?)
  `);

  let seq = 0;
  let inserted = 0;
  db.exec('BEGIN');
  for (const line of lines) {
    if (!line.includes('[LSR Bot]')) continue;
    const p = classifyAndParse(line);
    if (!p) continue;
    seq++;
    // Real timestamp if pm2's log_date_format prefix is present (added 2026-07-01 onward)
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):/);
    const timestamp = tsMatch ? new Date(tsMatch[1].replace(' ', 'T')).getTime() : null;
    insert.run(seq, timestamp, p.phase, p.direction, p.pool_price, p.pool_side, p.pool_distance, null, p.message, p.reversal_prob, p.rr_actual, p.min_prob, p.min_rr);
    inserted++;
  }
  db.exec('COMMIT');
  console.log(`[Import] Inserted ${inserted} historical events from pm2 log (source='pm2_log', no reliable timestamp except where pm2 timestamp prefix was present).`);
}

// ─── Part 2: current structured sweep_history.json ──────────────────────────
console.log("[Import] Clearing previous sweep_history_json rows...");
db.exec(`DELETE FROM sweep_events WHERE source = 'sweep_history_json'`);

if (!fs.existsSync(SWEEP_HISTORY_PATH)) {
  console.log('[Import] sweep_history.json not found, skipping.');
} else {
  const events = JSON.parse(fs.readFileSync(SWEEP_HISTORY_PATH, 'utf8'));
  const insert2 = db.prepare(`
    INSERT INTO sweep_events (seq, timestamp, phase, direction, pool_price, pool_side, pool_distance, pool_volume, message, source, reversal_prob, rr_actual, min_prob, min_rr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sweep_history_json', ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  const chronological = events.slice().reverse(); // oldest first, so seq increases with time like the pm2 partition
  chronological.forEach((e, idx) => {
    const direction = e.sweepCandidate?.direction || null;
    let reversalProb = e.sweepCandidate?.prob ?? null;
    if (reversalProb == null && e.probabilityBreakdown) {
      const sum = Object.entries(e.probabilityBreakdown)
        .filter(([k]) => k !== 'depthDeltaVal' && k !== 'premiumVal')
        .reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
      reversalProb = Math.round(sum);
    }
    const rrActual = e.sweepCandidate?.rr ?? null;
    insert2.run(idx + 1, e.timestamp, e.phase, direction, e.nearestPool, e.nearestPoolSide, e.nearestPoolDistance, e.nearestPoolVolume, e.message, reversalProb, rrActual, null, null);
  });
  db.exec('COMMIT');
  console.log(`[Import] Inserted ${chronological.length} events from sweep_history.json (source='sweep_history_json', real timestamps).`);
}

const total = db.prepare('SELECT COUNT(*) as c FROM sweep_events').get();
console.log(`[Import] Done. Total rows in sweep_events: ${total.c}`);
db.close();
