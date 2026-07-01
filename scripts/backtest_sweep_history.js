/**
 * Backtest using actual pool levels from sweep_history.json
 *
 * Approach:
 * - Collect all unique liquidation pool levels (price + volume) from sweep_history
 * - Fetch Binance 15m klines for the full session period
 * - For each candle window, check ALL pools for sweep detection
 * - Apply new settings filters, simulate outcome forward
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── New settings after fix (mirrors settings.json) ───────────
const S = {
  capital:        5000,
  riskPercent:    1,
  minRR:          1.0,
  minProb:        60,
  minConfirm:     0,
  atrMult:        1.5,
  minSLPct:       0.8,
  sweepCandles:   3,
  maxTPPct:       2.0,
  cooldownMin:    15,
  minDist:        0.2,
  maxDist:        8.0,
  maxActive:      1,
  backtestDays:   3,
};
const cooldownCandles = Math.round(S.cooldownMin / 15);

// ─── Load sweep history ───────────────────────────────────────
const h = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../src/dashboard/sweep_history.json'), 'utf8'
));

// Collect unique pool levels with original SIDE from sweep_history
// SUPPORT pools → only LONG setups. RESISTANCE pools → only SHORT setups.
const poolMap = new Map(); // price (rounded) → { price, volume, side }
h.forEach(e => {
  if (!e.nearestPool || !e.nearestPoolVolume || !e.nearestPoolSide) return;
  const key = Math.round(e.nearestPool);
  const existing = poolMap.get(key);
  if (!existing || e.nearestPoolVolume > existing.volume) {
    poolMap.set(key, {
      price:  e.nearestPool,
      volume: e.nearestPoolVolume,
      side:   e.nearestPoolSide, // SUPPORT or RESISTANCE from history
    });
  }
});
const pools = [...poolMap.values()].sort((a, b) => a.price - b.price);

// Use the FULL real sweep_history session — no extrapolation beyond actual
// logged pool data (sweep_history.json caps at 200 events / ~last N hours).
const sessionStart  = Math.min(...h.map(e => e.timestamp));
const sessionEnd    = Math.max(...h.map(e => e.timestamp));
const now           = Date.now();
const backtestStart = sessionStart;

console.log('=== Sweep History Backtest (full available log) ===');
console.log('Sweep history session:', new Date(sessionStart).toISOString(), '→', new Date(sessionEnd).toISOString());
console.log('Total sweep_history events used:', h.length);
console.log('Unique pools from history:', pools.length);
pools.forEach(p => console.log(`  $${p.price.toFixed(0)} (${p.side}) vol=$${(p.volume/1e6).toFixed(1)}M`));

// ─── Fetch Binance 15m klines covering the full session, extended to now
// so trades opened near session-end have a chance to resolve (TP/SL) ──
const startMs = backtestStart - 15 * 60 * 1000 * 25;
const limit   = Math.min(1000, Math.ceil((now - startMs) / (15 * 60 * 1000)) + 10);

console.log(`\nFetching ${limit} Binance 15m candles (BTCUSDT futures)...`);
const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=${startMs}&limit=${limit}`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
const raw = await res.json();

// Normalize: [closeTime, close, low, high, open, volume, openTime]
const candles = raw.map(k => [
  parseInt(k[6]),     // [0] closeTime
  parseFloat(k[4]),   // [1] close
  parseFloat(k[3]),   // [2] low
  parseFloat(k[2]),   // [3] high
  parseFloat(k[1]),   // [4] open
  parseFloat(k[5]),   // [5] volume
  parseInt(k[0]),     // [6] openTime
]);
console.log(`Got ${candles.length} candles: ${new Date(candles[0][6]).toISOString().slice(0,16)} → ${new Date(candles[candles.length-1][0]).toISOString().slice(0,16)}\n`);

// ─── Helpers ──────────────────────────────────────────────────
function calcATR(slice) {
  const n = Math.min(14, slice.length - 1);
  if (n < 1) return null;
  let sum = 0;
  for (let i = slice.length - n; i < slice.length; i++) {
    const hi = slice[i][3], lo = slice[i][2], pc = slice[i-1][1];
    sum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
  }
  return sum / n;
}

function sign(n) { return n >= 0 ? '+' : ''; }
function fmt(n, d=0) { return n.toFixed(d); }

// ─── Main loop ────────────────────────────────────────────────
// Mirrors live bot behavior: per cycle, evaluate ALL pools, pick only the
// BEST-scoring sweep candidate (server.js Step 7), and enforce maxActive —
// no new entry while an existing simulated trade is still open.
const SW = S.sweepCandles;
const allEvents      = [];
const activeTrades   = []; // { closeIdx } of currently open simulated trades
let   lastTradeEndIdx = -999;

for (let i = 20; i <= candles.length - SW - 2; i++) {
  const windowEnd    = i + SW - 1;
  if (windowEnd >= candles.length) break;

  const lastC        = candles[windowEnd];
  const currentPrice = lastC[1];
  const windowTs     = lastC[0];

  if (windowTs < backtestStart) continue;

  // Resolve any active trades that have closed by this point in time
  for (let ai = activeTrades.length - 1; ai >= 0; ai--) {
    if (activeTrades[ai].closeIdx <= windowEnd) activeTrades.splice(ai, 1);
  }

  const recentCandles = candles.slice(i, i + SW);
  const olderCandles  = candles.slice(Math.max(0, i - 15), i);
  const atr           = calcATR(candles.slice(Math.max(0, windowEnd - 14), windowEnd + 1));

  // ── Step 1: collect ALL sweep candidates across all pools this cycle ──
  const candidates = [];
  for (const pObj of pools) {
    const p   = pObj.price;
    const vol = pObj.volume;

    const distPct = ((p - currentPrice) / currentPrice) * 100;
    const absDist = Math.abs(distPct);
    if (absDist < S.minDist || absDist > S.maxDist) continue;

    const direction = pObj.side === 'SUPPORT' ? 'LONG' : 'SHORT';
    if (direction === 'LONG'  && p >= currentPrice) continue;
    if (direction === 'SHORT' && p <= currentPrice) continue;

    const sweptOld = olderCandles.some(c =>
      direction === 'LONG' ? (c[2] <= p && c[1] > p) : (c[3] >= p && c[1] < p)
    );
    if (sweptOld) continue;

    const sweepIdx = recentCandles.findIndex(c =>
      direction === 'LONG' ? (c[2] <= p && c[1] > p) : (c[3] >= p && c[1] < p)
    );
    if (sweepIdx === -1) continue;

    const afterSweep = recentCandles.slice(sweepIdx + 1);
    const confirmCnt = afterSweep.filter(c => direction === 'LONG' ? c[1] > p : c[1] < p).length;
    if (confirmCnt < S.minConfirm) continue;

    const sw    = recentCandles[sweepIdx];
    const cLow  = sw[2], cHigh = sw[3], cClose = sw[1];
    const range = cHigh - cLow;

    const wickDepth = direction === 'LONG'
      ? Math.abs((cLow - p) / p * 100)
      : Math.abs((cHigh - p) / p * 100);
    const rejStr = range > 0
      ? (direction === 'LONG' ? (cClose - cLow) / range : (cHigh - cClose) / range)
      : 0;

    // Score like live bot: volume * (1+rejection) * (1+wick) * (1+confirm*0.2)
    const score = vol * (1 + rejStr) * (1 + wickDepth) * (1 + confirmCnt * 0.2);

    candidates.push({ pObj, p, vol, direction, cLow, cHigh, wickDepth, rejStr, score });
  }

  if (candidates.length === 0) continue;

  // ── Step 2: pick the single BEST sweep candidate (mirrors server.js bestSweep) ──
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const { direction, p, vol, cLow, cHigh, wickDepth, rejStr } = best;
  const entry = currentPrice;

  // SL
  const minBuf = entry * (S.minSLPct / 100);
  const atrBuf = atr ? atr * S.atrMult : minBuf;
  const slBuf  = Math.max(minBuf, atrBuf);
  let sl       = direction === 'LONG' ? cLow - slBuf : cHigh + slBuf;
  let slDist   = Math.abs((entry - sl) / entry * 100);
  if (slDist < S.minSLPct) {
    slDist = S.minSLPct;
    sl = direction === 'LONG' ? entry*(1-S.minSLPct/100) : entry*(1+S.minSLPct/100);
  }

  // TP
  const maxTpDist = entry * (S.maxTPPct / 100);
  const tp        = direction === 'LONG' ? entry + maxTpDist : entry - maxTpDist;
  const tpDist    = S.maxTPPct;
  const rr        = parseFloat((tpDist / slDist).toFixed(2));

  // Prob
  const volPts = Math.min(15, (vol / 1e6) * 0.75);
  const rejPts = Math.min(15, rejStr * 15);
  const prob   = Math.min(99, Math.round(40 + volPts + rejPts));

  // ── Step 3: filters (R:R → Prob → maxActive → cooldown) ──
  let skipReason = null;
  if (rr < S.minRR)          skipReason = `R:R ${rr} < ${S.minRR}`;
  else if (prob < S.minProb) skipReason = `Prob ${prob}% < ${S.minProb}%`;
  else if (activeTrades.length >= S.maxActive) skipReason = `MaxActive (${activeTrades.length}/${S.maxActive})`;
  else if (i - lastTradeEndIdx < cooldownCandles) skipReason = `Cooldown`;

  const event = {
    timeStr:   new Date(lastC[0]).toISOString().slice(0,16).replace('T',' '),
    direction,
    pool:      parseFloat(p.toFixed(0)),
    poolVol:   parseFloat((vol/1e6).toFixed(1)),
    entry:     parseFloat(entry.toFixed(0)),
    sl:        parseFloat(sl.toFixed(0)),
    tp:        parseFloat(tp.toFixed(0)),
    slDist:    parseFloat(slDist.toFixed(2)),
    tpDist,
    rr,
    prob,
    wickDepth: parseFloat(wickDepth.toFixed(3)),
    rejStr:    parseFloat(rejStr.toFixed(3)),
    skipReason,
    outcome:   skipReason ? 'SKIPPED' : null,
    pnl:       0,
    entryTimestamp: lastC[0],
  };

  if (!skipReason) {
    let outcome = 'ACTIVE', closePrice = null, closeTimestamp = null, closeIdx = candles.length - 1;
    for (let k = windowEnd + 1; k < Math.min(windowEnd + 300, candles.length); k++) {
      const kH = candles[k][3], kL = candles[k][2];
      if (direction === 'LONG') {
        if (kL <= sl) { outcome = 'HIT_SL'; closePrice = sl; closeTimestamp = candles[k][0]; closeIdx = k; break; }
        if (kH >= tp) { outcome = 'HIT_TP'; closePrice = tp; closeTimestamp = candles[k][0]; closeIdx = k; break; }
      } else {
        if (kH >= sl) { outcome = 'HIT_SL'; closePrice = sl; closeTimestamp = candles[k][0]; closeIdx = k; break; }
        if (kL <= tp) { outcome = 'HIT_TP'; closePrice = tp; closeTimestamp = candles[k][0]; closeIdx = k; break; }
      }
    }
    const riskUsd = S.capital * S.riskPercent / 100;
    const pnl = outcome === 'HIT_TP' ? riskUsd * rr : outcome === 'HIT_SL' ? -riskUsd : 0;
    event.outcome         = outcome;
    event.closePrice      = closePrice;
    event.closeTimestamp  = closeTimestamp;
    event.pnl             = parseFloat(pnl.toFixed(2));
    event.riskUsd         = riskUsd;
    event.positionSizeUsd = parseFloat((riskUsd / (slDist / 100)).toFixed(0));

    // Register as active until it resolves (enforces maxActive going forward)
    activeTrades.push({ closeIdx });
    if (outcome !== 'ACTIVE') lastTradeEndIdx = windowEnd;
  }
  allEvents.push(event);
}

const deduped = allEvents; // one event per cycle already — no per-pool duplicates

// ─── Print results (only executed + skipped-by-maxActive/cooldown shown compactly) ──
console.log('Time             | Dir  | Pool   |Vol$M| Entry | SL    | TP    |slDist|  R:R | Prob | Outcome         |   PnL');
console.log('-----------------|------|--------|-----|-------|-------|-------|------|------|------|-----------------|------');

let wins=0, losses=0, skips=0, totalPnl=0;
deduped.forEach(e => {
  const res = e.skipReason ? `SKIP:${e.skipReason.slice(0,12)}` : (e.outcome || 'ACTIVE');
  const pnlStr = e.pnl !== 0 ? `${sign(e.pnl)}$${Math.abs(e.pnl).toFixed(2)}` : '';
  if (e.pnl > 0) wins++;
  if (e.pnl < 0) losses++;
  if (e.skipReason) skips++;
  totalPnl += e.pnl;

  console.log(
    `${e.timeStr} | ${e.direction.padEnd(4)} | $${String(e.pool).padStart(5)} |${String(e.poolVol).padStart(4)}M` +
    `| $${String(e.entry).padStart(5)}` +
    `| $${String(e.sl).padStart(5)}` +
    `| $${String(e.tp).padStart(5)}` +
    `|${String(e.slDist).padStart(5)}%` +
    `|${String(e.rr).padStart(5)}` +
    `|${String(e.prob).padStart(4)}%` +
    `| ${res.padEnd(15)}` +
    `| ${pnlStr}`
  );
});

const executed = wins + losses;
console.log('\n═══════════════════════════════════════════════');
console.log(`Events detected:   ${deduped.length} (${skips} skipped, ${executed} executed)`);
if (executed > 0) {
  console.log(`  HIT_TP (wins):  ${wins}`);
  console.log(`  HIT_SL (losses):${losses}`);
  console.log(`  Win rate:       ${(wins/executed*100).toFixed(1)}%`);
  const pnlStr = (totalPnl >= 0 ? '+' : '-') + '$' + Math.abs(totalPnl).toFixed(2);
  const avgStr = (totalPnl/executed >= 0 ? '+' : '-') + '$' + Math.abs(totalPnl/executed).toFixed(2);
  console.log(`  Total PnL:      ${pnlStr}`);
  console.log(`  Per trade avg:  ${avgStr}`);
}

// ─── Import to Trade Journal ──────────────────────────────────
// Import all non-SKIPPED events (HIT_TP, HIT_SL, ACTIVE) as backtest trades
const toImport = deduped.filter(e => !e.skipReason);
if (toImport.length === 0) {
  console.log('\nNo trades to import.');
  process.exit(0);
}

console.log(`\n─── Importing ${toImport.length} trades to journal... ───`);

const AUTH = Buffer.from('admin:admin123').toString('base64');
let imported = 0, failed = 0;

for (const e of toImport) {
  const ts = e.entryTimestamp || Date.now();
  const id = 'T_BT_' + ts + '_' + e.pool;

  const payload = {
    id,
    timestamp:        ts,
    time:             new Date(ts).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
    direction:        e.direction,
    tf:               '15m',
    entry:            e.entry,
    tp:               e.tp,
    sl:               e.sl,
    capital:          S.capital,
    riskPercent:      S.riskPercent,
    riskUsd:          e.riskUsd || S.capital * S.riskPercent / 100,
    positionSizeUsd:  e.positionSizeUsd || 0,
    tpDistance:       e.tpDist,
    slDistance:       e.slDist,
    status:           (e.outcome === 'HIT_TP' || e.outcome === 'HIT_SL') ? e.outcome : 'ACTIVE',
    pnl:              e.pnl || 0,
    closeTimestamp:   e.closeTimestamp || null,
    note:             `[Backtest] Pool $${e.pool} ${e.direction} | R:R ${e.rr} | Prob ${e.prob}% | Vol $${e.poolVol}M`,
  };

  try {
    const r = await fetch('http://localhost:4000/api/trades/add', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + AUTH },
      body:    JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.success) {
      console.log(`  ✅ ${e.timeStr} ${e.direction} $${e.pool} → ${e.outcome || 'ACTIVE'} (PnL: ${e.pnl >= 0 ? '+' : ''}$${e.pnl})`);
      imported++;
    } else {
      console.log(`  ❌ ${e.timeStr} ${e.direction} $${e.pool} → ${data.error}`);
      failed++;
    }
  } catch (err) {
    console.log(`  ❌ ${e.timeStr} ${e.direction} $${e.pool} → ${err.message}`);
    failed++;
  }
}

console.log(`\nImport selesai: ${imported} berhasil, ${failed} gagal.`);
console.log('Buka trades.html → Trade Journal untuk melihat hasilnya.');
