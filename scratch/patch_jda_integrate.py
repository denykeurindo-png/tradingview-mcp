"""
Add back missing functions to reconstructed server.js:
- fetchBinance15mKlines
- JDA helpers + fetchJDASignal + jdaSignalCache
- predictSweepTargets + sweepPredictionCache
- /api/sweep-prediction and /api/heatmap-data-3d endpoints
"""

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

# ══ 1. Add missing cache vars before runBotCycle ══
missing_vars = """
// ─── JDA + Sweep Prediction cache vars ─────────────────────────────────────
let jdaSignalCache = null;
let sweepPredictionCache = null;

"""
# Insert before 'async function runBotCycle'
src = src.replace('async function runBotCycle() {', missing_vars + 'async function runBotCycle() {', 1)
print('added cache vars')

# ══ 2. Add fetchBinance15mKlines (needed by runBotCycle) ══
FN_15M = """
async function fetchBinance15mKlines() {
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=20');
    const raw = await res.json();
    return {
      type: 'candlestick_15m',
      data: raw.map(k => [parseInt(k[6]), parseFloat(k[4]), parseFloat(k[3]), parseFloat(k[2]), parseFloat(k[1]), parseFloat(k[5])])
    };
  } catch (e) {
    console.error('[Binance API] Error fetching 15m klines:', e.message);
    return null;
  }
}

"""
src = src.replace('async function runBotCycle() {', FN_15M + 'async function runBotCycle() {', 1)
print('added fetchBinance15mKlines')

# ══ 3. Add predictSweepTargets ══
PREDICT_FN = """
// ════════════════════════════════════════════════════════════════════════════
// SWEEP PREDICTION ENGINE
// ════════════════════════════════════════════════════════════════════════════
function predictSweepTargets(heatmapData, metrics) {
  try {
    if (!heatmapData || !heatmapData.series) return null;
    const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');
    const candleSeries  = heatmapData.series.find(s => s.type === 'candlestick_raw')
                       || heatmapData.series.find(s => s.type === 'candlestick');
    if (!heatmapSeries || !candleSeries || !candleSeries.data.length) return null;
    const yAxisData = heatmapData.yAxis || [];
    const lastCandle = candleSeries.data[candleSeries.data.length - 1];
    const currentPrice = parseFloat(lastCandle[1]);
    if (!currentPrice || isNaN(currentPrice)) return null;

    const volumeByY = {};
    heatmapSeries.data.forEach(item => {
      const v = Array.isArray(item) ? item : (item.value || []);
      const yIdx = parseInt(v[1], 10);
      const val  = parseFloat(v[2] || 0);
      if (!isNaN(yIdx) && val > 0) volumeByY[yIdx] = (volumeByY[yIdx] || 0) + val;
    });

    const pools = [];
    yAxisData.forEach((priceStr, idx) => {
      const price  = parseFloat(priceStr);
      const volume = volumeByY[idx] || 0;
      if (!price || volume === 0) return;
      const dist    = ((price - currentPrice) / currentPrice) * 100;
      const absDist = Math.abs(dist);
      if (absDist < 0.05 || absDist > 10) return;
      pools.push({ price, volume, dist, absDist, side: price > currentPrice ? 'RESISTANCE' : 'SUPPORT' });
    });
    if (pools.length === 0) return null;

    const allVols = pools.map(p => p.volume).sort((a, b) => b - a);
    const minVol  = allVols[Math.floor(allVols.length * 0.15)] || 0;
    const quality = pools.filter(p => p.volume >= minVol);
    const resistance = quality.filter(p => p.side === 'RESISTANCE').sort((a, b) => a.absDist - b.absDist);
    const support    = quality.filter(p => p.side === 'SUPPORT').sort((a, b) => a.absDist - b.absDist);

    let upBias = 1.0, downBias = 1.0;
    const cvd      = metrics.spotCvd1h || 0;
    const funding  = parseFloat(metrics.fundingRate) || 0;
    const lsRatio  = parseFloat(metrics.longShortRatio) || 1.5;
    const topRatio = parseFloat(metrics.topTraderRatio) || lsRatio;
    const jdaV1h   = metrics.jdaV1h || 0;
    const jdaV4h   = metrics.jdaV4h || 0;

    if (cvd > 0) upBias *= 1.25; else downBias *= 1.25;
    if (funding > 0.0002) downBias *= 1.20; else if (funding < -0.0002) upBias *= 1.20;
    if (lsRatio > 1.8) downBias *= 1.30; else if (lsRatio < 1.2) upBias *= 1.20;
    if (topRatio < lsRatio - 0.2) downBias *= 1.15; else if (topRatio > lsRatio + 0.2) upBias *= 1.15;
    if (jdaV1h > 20) upBias *= 1.20; else if (jdaV1h < -20) downBias *= 1.20;
    if (jdaV4h > 10) upBias *= 1.10; else if (jdaV4h < -10) downBias *= 1.10;

    const scorePool = p => (p.volume / Math.pow(p.absDist, 1.5)) * (p.side === 'RESISTANCE' ? upBias : downBias);
    const scored = quality.map(p => ({ ...p, score: scorePool(p) })).sort((a, b) => b.score - a.score);
    const hotPool = scored[0] || null;
    const cascadePool = hotPool ? scored.filter(p => p.side === hotPool.side && Math.abs(p.price - hotPool.price) > 1).sort((a,b) => a.absDist - b.absDist)[0] : null;

    const upScore   = resistance.reduce((s, p) => s + scorePool(p), 0);
    const downScore = support.reduce((s, p) => s + scorePool(p), 0);
    const total     = upScore + downScore || 1;
    const upProb    = Math.round((upScore / total) * 100);
    const downProb  = 100 - upProb;

    const reasons = [];
    if (cvd > 500000) reasons.push('CVD Futures +' + (cvd/1e6).toFixed(1) + 'M');
    else if (cvd < -500000) reasons.push('CVD Futures ' + (cvd/1e6).toFixed(1) + 'M');
    if (funding > 0.0002) reasons.push('Funding +' + (funding*100).toFixed(4) + '%');
    else if (funding < -0.0002) reasons.push('Funding ' + (funding*100).toFixed(4) + '%');
    if (lsRatio > 1.8) reasons.push('L/S ' + lsRatio.toFixed(2) + ' → long crowded');
    if (jdaV1h > 20) reasons.push('VZO 1H BULL+ (' + jdaV1h.toFixed(0) + '%)');
    else if (jdaV1h < -20) reasons.push('VZO 1H BEAR+ (' + jdaV1h.toFixed(0) + '%)');

    const fmt = p => p ? { price: Math.round(p.price), volume: Math.round(p.volume / 1e6), distPct: p.dist.toFixed(2) + '%', side: p.side } : null;
    return {
      direction: upProb >= downProb ? 'UP' : 'DOWN',
      upProb, downProb,
      confidence: Math.max(upProb, downProb),
      hotPool: fmt(hotPool),
      cascadePool: fmt(cascadePool),
      nearestResistance: fmt(resistance[0]),
      nearestSupport: fmt(support[0]),
      reasons,
      currentPrice: Math.round(currentPrice),
      timestamp: Date.now()
    };
  } catch(e) {
    console.error('[SweepPredict] Error:', e.message);
    return null;
  }
}

"""
src = src.replace('async function runBotCycle() {', PREDICT_FN + 'async function runBotCycle() {', 1)
print('added predictSweepTargets')

# ══ 4. Add fetchJDASignal stub (uses simple VZO calculation) ══
JDA_STUB = """
// ─── JDA Signal (simplified — uses Binance klines for VZO-based MTF bias) ─────
let jdaSignalCache = null;

function jda_ema(vals, period) {
  const k = 2 / (period + 1); let r = vals[0] || 0;
  for (let i = 1; i < vals.length; i++) r = (vals[i] || 0) * k + r * (1 - k);
  return r;
}

async function fetchJDASignal() {
  try {
    const [k1h, k4h] = await Promise.all([
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60').then(r=>r.json()),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=60').then(r=>r.json()),
    ]);

    const vzo = klines => {
      const c = klines.map(k=>parseFloat(k[4])), v = klines.map(k=>parseFloat(k[5]));
      const sma = arr => arr.reduce((s,x)=>s+x,0)/arr.length;
      const rv = v.map((vi,i)=>vi/(sma(v.slice(Math.max(0,i-9),i+1))||1));
      const dc = c.map((ci,i)=>i===0?0:ci-c[i-1]);
      const mom = dc.map((d,i)=>d*rv[i]);
      const pm = mom.map(m=>Math.max(m,0)), nm = mom.map(m=>Math.abs(Math.min(m,0)));
      const pa = jda_ema(pm,9), na = jda_ema(nm,9);
      const ratio = na>0.00001 ? pa/na : (pa>0.00001?100:1);
      return Math.min(100,Math.max(-100,100*(ratio-1)/(ratio+1)));
    };

    const v1h = Array.isArray(k1h) ? vzo(k1h) : 0;
    const v4h = Array.isArray(k4h) ? vzo(k4h) : 0;
    const dirScore = v1h*0.30 + v4h*0.10;
    const bias = v4h > 10 ? 'BULLISH' : v4h < -10 ? 'BEARISH' : 'NEUTRAL';

    const tfState = v => v > 40 ? 'BULL+' : v > 0 ? 'BULL' : v < -40 ? 'BEAR+' : v < 0 ? 'BEAR' : 'RANGE';
    const tfTrend = s => s.includes('BULL') ? 'BULLISH' : s.includes('BEAR') ? 'BEARISH' : 'RANGING';
    const tfStr   = s => (s === 'BULL+' || s === 'BEAR+') ? 'STRONG' : s === 'RANGE' ? 'WEAK' : 'MODERATE';
    const tfScore = (v, dir) => dir === 'LONG' ? Math.min(10,Math.max(-10,v/10)) : -Math.min(10,Math.max(-10,v/10));

    return {
      timeframes: {
        '15m': { vzo:0, state:'RANGE', trend:'RANGING', strength:'WEAK' },
        '1h':  { vzo:Math.round(v1h*10)/10, state:tfState(v1h), trend:tfTrend(tfState(v1h)), strength:tfStr(tfState(v1h)) },
        '4h':  { vzo:Math.round(v4h*10)/10, state:tfState(v4h), trend:tfTrend(tfState(v4h)), strength:tfStr(tfState(v4h)) },
        '1d':  { vzo:0, state:'RANGE', trend:'RANGING', strength:'WEAK' },
        '1w':  { vzo:0, state:'RANGE', trend:'RANGING', strength:'WEAK' },
      },
      dirScore: Math.round(dirScore*10)/10,
      conf: Math.min(Math.abs(dirScore), 100),
      confLevel: Math.abs(dirScore)>=65?'HIGH':Math.abs(dirScore)>=60?'MEDIUM':'LOW',
      phase: v4h > 40 ? 'STRONG BULL TREND' : v4h < -40 ? 'STRONG BEAR TREND' : 'NEUTRAL',
      marketBias: bias,
      action: 'WAIT',
      fetchTime: Date.now()
    };
  } catch(e) {
    console.error('[JDA] Error:', e.message);
    return { timeframes:{'1h':{vzo:0,state:'RANGE'},'4h':{vzo:0,state:'RANGE'}}, dirScore:0, conf:0, phase:'NEUTRAL', marketBias:'NEUTRAL', action:'WAIT', fetchTime:Date.now() };
  }
}

"""
# Insert before predictSweepTargets
src = src.replace('// ════════════════════════════════════════════════════════════════════════════\n// SWEEP PREDICTION ENGINE', JDA_STUB + '// ════════════════════════════════════════════════════════════════════════════\n// SWEEP PREDICTION ENGINE', 1)
print('added fetchJDASignal')

# ══ 5. Add /api/sweep-prediction and /api/heatmap-data-3d endpoints ══
# Insert before app.get('/api/bot-status')
ENDPOINTS = """
app.get('/api/sweep-prediction', (req, res) => {
  res.json({ success: true, data: sweepPredictionCache, data3d: sweepPrediction3DCache });
});

app.get('/api/heatmap-data-3d', async (req, res) => {
  if (heatmap3DCache && lastHeatmap3DFetchTime && (Date.now() - lastHeatmap3DFetchTime < 600000)) {
    return res.json({ success: true, source: 'cache', data: heatmap3DCache });
  }
  if (heatmap3DCache) {
    return res.json({ success: true, source: 'stale-cache', data: heatmap3DCache });
  }
  res.status(503).json({ success: false, error: 'No 3D data yet, please wait for next cycle.' });
});

app.get('/api/jda-signal', async (req, res) => {
  try {
    if (!jdaSignalCache || (Date.now() - jdaSignalCache.fetchTime > 180000)) {
      jdaSignalCache = await fetchJDASignal();
    }
    res.json({ success: true, data: jdaSignalCache });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

"""
if "app.get('/api/bot-status'," in src:
    src = src.replace("app.get('/api/bot-status',", ENDPOINTS + "app.get('/api/bot-status',", 1)
    print('added endpoints')
else:
    print('WARNING: bot-status anchor not found')

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)

# Verify
checks = [
    ('fetchJDASignal', 'async function fetchJDASignal()' in src),
    ('predictSweepTargets', 'function predictSweepTargets(' in src),
    ('sweepPredictionCache var', 'let sweepPredictionCache' in src),
    ('jdaSignalCache var', 'let jdaSignalCache' in src),
    ('fetchBinance15mKlines', 'async function fetchBinance15mKlines()' in src),
    ('api-sweep-prediction', "'/api/sweep-prediction'" in src),
    ('api-heatmap-data-3d', "'/api/heatmap-data-3d'" in src),
    ('fetchBinanceOI', 'async function fetchBinanceOI()' in src),
    ('autoTradeStrategy', 'function autoTradeStrategyBackend(' in src),
    ('runBotCycle', 'async function runBotCycle()' in src),
]
print('\nVerification:')
for name, ok in checks:
    print(('OK' if ok else 'FAIL') + ': ' + name)
print(f'\nTotal lines: {src.count(chr(10))}')
