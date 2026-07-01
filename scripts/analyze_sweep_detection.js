import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dashboardDir = path.join(__dirname, '../src/dashboard');
const heatmapPath = path.join(dashboardDir, 'cache/heatmap24h_cache.json');
const settingsPath = path.join(dashboardDir, 'settings.json');

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const heatmapData = JSON.parse(fs.readFileSync(heatmapPath, 'utf8')).data;

console.log("Fetching live 15m klines from Binance API...");
const binanceRes = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=20');
const rawKlines = await binanceRes.json();
const cs = {
  type: 'candlestick_15m',
  data: rawKlines.map(k => [parseInt(k[6]), parseFloat(k[4]), parseFloat(k[3]), parseFloat(k[2]), parseFloat(k[1]), parseFloat(k[5])])
};

const lastCandle = cs.data[cs.data.length - 1];
const currentPrice = parseFloat(lastCandle[1]);

console.log(`Current BTC Price from Binance: $${currentPrice.toFixed(2)}`);

const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');
if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) {
  console.error("No heatmap series data found");
  process.exit(1);
}

const yAxisData = heatmapData.yAxis || [];
const latestXIdx = heatmapData.xAxis.length - 1;
const volumeByY = {};
const maxRecentVolumeByY = {};
const startXIdx = Math.max(0, latestXIdx - 15);

heatmapSeries.data.forEach(item => {
  const v = Array.isArray(item) ? item : (item.value || []);
  const xIdx = parseInt(v[0], 10);
  const yIdx = parseInt(v[1], 10);
  const val = parseFloat(v[2] || 0);
  if (!isNaN(yIdx)) {
    if (xIdx === latestXIdx) {
      volumeByY[yIdx] = val;
    }
    if (xIdx >= startXIdx && xIdx <= latestXIdx) {
      if (!maxRecentVolumeByY[yIdx] || val > maxRecentVolumeByY[yIdx]) {
        maxRecentVolumeByY[yIdx] = val;
      }
    }
  }
});

const allVolumes = Object.values(volumeByY).filter(v => v > 0).sort((a, b) => b - a);
const volumeRatio = settings.minPoolVolumeRatio || 0.15;
const topCutoffIndex = Math.max(1, Math.floor(allVolumes.length * volumeRatio));
const minPoolVolume = allVolumes[topCutoffIndex - 1] || 0;

console.log(`Min Pool Volume cutoff: ${minPoolVolume.toLocaleString()}`);

// Evaluate candidates near current price
const sweepConfirmCandles = settings.sweepConfirmCandles || 3;
const recentCandles = cs.data.slice(Math.max(0, cs.data.length - sweepConfirmCandles));
const olderCandles = cs.data.slice(Math.max(0, cs.data.length - 15), Math.max(0, cs.data.length - sweepConfirmCandles));

console.log(`Recent candles window: last ${recentCandles.length} candles.`);
console.log(`Older candles window: ${olderCandles.length} candles.`);

yAxisData.forEach((priceStr, idx) => {
  const p = parseFloat(priceStr);
  if (isNaN(p)) return;
  
  const volume = maxRecentVolumeByY[idx] || 0;
  
  // Calculate distance
  const distPercent = ((p - currentPrice) / currentPrice) * 100;
  const absDist = Math.abs(distPercent);
  
  // Inspect levels within 1.0% of current price
  if (absDist < 1.0) {
    const isTopVolume = volume >= minPoolVolume;
    
    // Only skip if an older candle performed a real sweep (wick+close), not just a wick touch
    const alreadySweptOld = olderCandles.some(c => {
      const cClose = parseFloat(c[1]);
      const cLow   = parseFloat(c[2]);
      const cHigh  = parseFloat(c[3]);
      return p < currentPrice
        ? (cLow <= p && cClose > p)   // LONG pool: wicked below + closed above = already swept
        : (cHigh >= p && cClose < p); // SHORT pool: wicked above + closed below = already swept
    });
    
    // Find sweep index in recent candles
    const sweepIdx = recentCandles.findIndex(candle => {
      const cClose = parseFloat(candle[1]); // close
      const cLow   = parseFloat(candle[2]); // low
      const cHigh  = parseFloat(candle[3]); // high
      return p < currentPrice
        ? (cLow <= p && cClose > p)   // LONG: wick below pool, close above
        : (cHigh >= p && cClose < p); // SHORT: wick above pool, close below
    });
    
    console.log(`Price Level: $${p.toFixed(2)} | Vol: ${volume.toLocaleString()} | Dist: ${distPercent.toFixed(2)}% | TopVol: ${isTopVolume} | SweptOld: ${alreadySweptOld} | SweepIdxInRecent: ${sweepIdx}`);
  }
});
