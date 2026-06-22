function ema(arr, period) {
  const k = 2 / (period + 1);
  const result = [];
  if (arr.length === 0) return result;
  let cur = arr[0];
  result.push(cur);
  for (let i = 1; i < arr.length; i++) {
    cur = arr[i] * k + cur * (1 - k);
    result.push(cur);
  }
  return result;
}

function sma(arr, period) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) {
      result.push(arr[i]);
    } else {
      const sum = arr.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0);
      result.push(sum / period);
    }
  }
  return result;
}

function calculateVZO(closes, volumes, len = 9, f_len = 31, s_len = 3) {
  const n = closes.length;
  
  const volSma = [];
  for (let i = 0; i < n; i++) {
    if (i < len - 1) {
      volSma.push(volumes[i]);
    } else {
      const sum = volumes.slice(i - len + 1, i + 1).reduce((s, x) => s + x, 0);
      volSma.push(sum / len);
    }
  }

  const relVol = volumes.map((v, i) => v / (volSma[i] || 1));
  const smoothedVol = ema(relVol, s_len);

  const changes = [0];
  for (let i = 1; i < n; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const smoothedChange = ema(changes, s_len);

  const mom = smoothedChange.map((sc, i) => sc * smoothedVol[i]);
  const smoothedMom = ema(mom, s_len);

  const posMom = ema(smoothedMom.map(m => Math.max(m, 0)), len);
  const negMom = ema(smoothedMom.map(m => Math.abs(Math.min(m, 0))), len);

  const vzoRaw = [];
  for (let i = 0; i < n; i++) {
    const ratio = negMom[i] > 0.00001 ? (posMom[i] / negMom[i]) : 1.0;
    vzoRaw.push(100.0 * (ratio - 1.0) / (ratio + 1.0));
  }

  const emaVzoS = ema(vzoRaw, s_len);
  const emaVzoF = ema(vzoRaw, f_len);
  const vzo = [];
  for (let i = 0; i < n; i++) {
    const val = emaVzoS[i] * 0.6 + emaVzoF[i] * 0.4;
    vzo.push(Math.min(Math.max(val, -100), 100));
  }

  const signal = sma(vzo, 3);
  return { vzo, signal };
}

async function testLimit(limit) {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=${limit}`);
  const klines = await res.json();
  const cls = klines.map(k => parseFloat(k[4]));
  const vls = klines.map(k => parseFloat(k[5]));
  const { vzo, signal } = calculateVZO(cls, vls, 9, 31, 3);
  console.log(`Limit ${limit} -> Last VZO:`, vzo[vzo.length - 1], 'Signal:', signal[signal.length - 1]);
}

async function run() {
  await testLimit(120);
  await testLimit(500);
  await testLimit(1000);
}
run();
