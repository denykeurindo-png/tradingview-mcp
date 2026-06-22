with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

# ══ FIX 1: CVD → Futures CVD (fapi) instead of Spot (api) ══
old_cvd = """async function fetchBinanceSpotCVD() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=12');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      let cumulativeDelta = 0;
      data.forEach(k => {
        const totalVal = parseFloat(k[7]);
        const takerBuyVal = parseFloat(k[10]);
        if (!isNaN(totalVal) && !isNaN(takerBuyVal)) {
          const delta = 2 * takerBuyVal - totalVal;
          cumulativeDelta += delta;
        }
      });
      return cumulativeDelta;
    }
  } catch (err) {
    console.error('[Binance API] Error fetching Spot CVD:', err.message);
  }
  return 0;
}"""

new_cvd = """async function fetchBinanceSpotCVD() {
  try {
    // Use Futures klines (fapi) — more relevant for liquidation sweep strategy than Spot CVD
    // k[9] = takerBuyBaseAssetVolume, k[10] = takerBuyQuoteAssetVolume (USD value)
    // k[7] = quoteAssetVolume (total USD volume)
    const [resFutures, resSpot] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=12'),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=12')
    ]);

    let futuresCVD = 0;
    if (resFutures.ok) {
      const data = await resFutures.json();
      if (Array.isArray(data)) {
        data.forEach(k => {
          const totalVal = parseFloat(k[7]);
          const takerBuyVal = parseFloat(k[10]);
          if (!isNaN(totalVal) && !isNaN(takerBuyVal)) {
            futuresCVD += 2 * takerBuyVal - totalVal;
          }
        });
      }
    }

    let spotCVD = 0;
    if (resSpot.ok) {
      const data = await resSpot.json();
      if (Array.isArray(data)) {
        data.forEach(k => {
          const totalVal = parseFloat(k[7]);
          const takerBuyVal = parseFloat(k[10]);
          if (!isNaN(totalVal) && !isNaN(takerBuyVal)) {
            spotCVD += 2 * takerBuyVal - totalVal;
          }
        });
      }
    }

    // Return futures CVD as primary; also expose spot for display
    return { futures: futuresCVD, spot: spotCVD, combined: futuresCVD + spotCVD };
  } catch (err) {
    console.error('[Binance API] Error fetching CVD:', err.message);
  }
  return { futures: 0, spot: 0, combined: 0 };
}"""

cnt = src.count(old_cvd)
src = src.replace(old_cvd, new_cvd, 1)
print('FIX 1 CVD:', cnt, 'replaced')

# ══ FIX 2: Update cvdVal usage — it now returns an object ══
# In runBotCycle: cvdVal is now { futures, spot, combined }
# botMetrics.spotCvd1h should use futures CVD
src = src.replace(
    '      spotCvd1h: cvdVal,',
    '      spotCvd1h: (cvdVal && cvdVal.futures) || cvdVal || 0,\n      spotCvdFutures: (cvdVal && cvdVal.futures) || 0,\n      spotCvdSpot: (cvdVal && cvdVal.spot) || 0,'
)

# ══ FIX 3: Add topTrader L/S ratio alongside global ratio ══
old_ls = """async function fetchBinanceLongShortRatio() {
  try {
    const res = await fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return {
        ratio: parseFloat(data[0].longShortRatio || 1.0),
        long: parseFloat(data[0].longAccount || 0.5),
        short: parseFloat(data[0].shortAccount || 0.5)
      };
    }
  } catch (err) {
    console.error('[Binance API] Error fetching L/S Ratio:', err.message);
  }
  return { ratio: 1.0, long: 0.5, short: 0.5 };
}"""

new_ls = """async function fetchBinanceLongShortRatio() {
  try {
    // Fetch both global account ratio AND top trader position ratio in parallel
    const [resGlobal, resTop] = await Promise.all([
      fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1'),
      fetch('https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=1')
    ]);

    let globalRatio = 1.0, globalLong = 0.5, globalShort = 0.5;
    if (resGlobal.ok) {
      const data = await resGlobal.json();
      if (Array.isArray(data) && data.length > 0) {
        globalRatio = parseFloat(data[0].longShortRatio || 1.0);
        globalLong = parseFloat(data[0].longAccount || 0.5);
        globalShort = parseFloat(data[0].shortAccount || 0.5);
      }
    }

    let topRatio = 1.0, topLong = 0.5, topShort = 0.5;
    if (resTop.ok) {
      const data = await resTop.json();
      if (Array.isArray(data) && data.length > 0) {
        topRatio = parseFloat(data[0].longShortRatio || 1.0);
        topLong = parseFloat(data[0].longAccount || 0.5);
        topShort = parseFloat(data[0].shortAccount || 0.5);
      }
    }

    return {
      ratio: globalRatio,
      long: globalLong,
      short: globalShort,
      topRatio,
      topLong,
      topShort
    };
  } catch (err) {
    console.error('[Binance API] Error fetching L/S Ratio:', err.message);
  }
  return { ratio: 1.0, long: 0.5, short: 0.5, topRatio: 1.0, topLong: 0.5, topShort: 0.5 };
}"""

cnt = src.count(old_ls)
src = src.replace(old_ls, new_ls, 1)
print('FIX 3 L/S:', cnt, 'replaced')

# ══ FIX 4: Store topTrader ratio in botMetrics ══
src = src.replace(
    '      longShortRatio: lsRatioData.ratio,\n      longAccount: lsRatioData.long,\n      shortAccount: lsRatioData.short',
    '      longShortRatio: lsRatioData.ratio,\n      longAccount: lsRatioData.long,\n      shortAccount: lsRatioData.short,\n      topTraderRatio: lsRatioData.topRatio || lsRatioData.ratio,\n      topTraderLong: lsRatioData.topLong || lsRatioData.long,\n      topTraderShort: lsRatioData.topShort || lsRatioData.short'
)

# ══ FIX 5: Add topTrader ratio to botMetrics initial state ══
src = src.replace(
    '  longShortRatio: 1.0,\n  longAccount: 0.5,\n  shortAccount: 0.5,',
    '  longShortRatio: 1.0,\n  longAccount: 0.5,\n  shortAccount: 0.5,\n  topTraderRatio: 1.0,\n  topTraderLong: 0.5,\n  topTraderShort: 0.5,\n  spotCvdFutures: 0,\n  spotCvdSpot: 0,'
)

# ══ FIX 6: probability formula uses futures CVD (already in botMetrics.spotCvd1h) ══
# No change needed - spotCvd1h now stores futures CVD

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)
print('ALL DONE')
