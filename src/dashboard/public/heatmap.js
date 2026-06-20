// JDA Trade Monitor — CoinGlass Liquidation HeatMap Logic (Simplified Backtest Grid)
const EXCHANGE_RATE = 6.96; // 1 USD = 6.96 Bolivianos (Bs.)

// DOM Elements
const statusIndicator = document.getElementById('connection-status');
const btnRefresh = document.getElementById('btn-refresh');

const valBtcPrice = document.getElementById('val-btc-price');
const footBtcPrice = document.getElementById('foot-btc-price');
const timeBtcPrice = document.getElementById('time-btc-price');

const valLiqVol = document.getElementById('val-liq-vol');
const footLiqVol = document.getElementById('foot-liq-vol');
const timeLiqVol = document.getElementById('time-liq-vol');

const val24hHigh = document.getElementById('val-24h-high');
const foot24hHigh = document.getElementById('foot-24h-high');
const time24hHigh = document.getElementById('time-24h-high');

const val24hLow = document.getElementById('val-24h-low');
const foot24hLow = document.getElementById('foot-24h-low');
const time24hLow = document.getElementById('time-24h-low');

const cacheIndicator = document.getElementById('cache-indicator');
const heatmapUpdateTime = document.getElementById('heatmap-update-time');

let myChart = null;
let currentBtcPriceGlobal = null;
let lastHeatmapDataGlobal = null;
let tradeLog = [];
let autoTradeEnabled = true;
let refreshIntervalId = null;
let lastHeatmapTimestamp = null;
let retryTimeoutId = null;

// ─── Format Helpers ─────────────────────────────────────────
const formatUSD = (valUsd) => {
  if (valUsd === 0 || valUsd === undefined || valUsd === null) return '$0.00';
  const isNeg = valUsd < 0;
  const abs = Math.abs(valUsd);
  let f = '';
  if (abs >= 1e9) f = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) f = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) f = (abs / 1e3).toFixed(2) + 'K';
  else f = abs.toFixed(2);
  return `${isNeg ? '-' : ''}$${f}`;
};

const formatBs = (valUsd) => {
  if (valUsd === 0 || valUsd === undefined || valUsd === null) return 'Bs. 0.00';
  const valBs = valUsd * EXCHANGE_RATE;
  const isNeg = valBs < 0;
  const abs = Math.abs(valBs);
  let f = '';
  if (abs >= 1e9) f = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) f = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) f = (abs / 1e3).toFixed(2) + 'K';
  else f = abs.toFixed(2);
  return `${isNeg ? '-' : ''}Bs. ${f}`;
};

const formatIntensity = (val) => {
  if (val === 0 || val === undefined || val === null) return '0.00';
  const abs = Math.abs(val);
  if (abs >= 1e9) return (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (abs / 1e3).toFixed(2) + 'K';
  return abs.toFixed(2);
};

function updateStatus(state, message) {
  statusIndicator.className = `status-indicator ${state}`;
  statusIndicator.querySelector('.status-text').innerText = message;
}

// ─── Data Fetch ─────────────────────────────────────────────
async function loadHeatmapData(forceRefresh = false) {
  if (retryTimeoutId) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }

  updateStatus('loading', forceRefresh ? 'Scraping...' : 'Updating...');
  btnRefresh.disabled = true;

  try {
    const url = `/api/heatmap-data${forceRefresh ? '?refresh=true' : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || `HTTP error ${response.status}`);
    }

    const resObj = await response.json();
    const result = resObj.data.data;
    const timestamp = resObj.data.timestamp;

    const isNewData = (timestamp !== lastHeatmapTimestamp);
    lastHeatmapTimestamp = timestamp;
    lastHeatmapDataGlobal = result;

    const lastUpdate = new Date(timestamp).toLocaleTimeString();
    
    // Display source indicating if it's Live, Cache, or Cache-NoChange
    const sourceLabel = resObj.source === 'cache'
      ? (isNewData ? 'Cache' : 'Cache-NoChange')
      : 'Live';
    
    cacheIndicator.innerText = `Updated: ${lastUpdate} [${sourceLabel}]`;
    heatmapUpdateTime.innerText = `Update Time: ${lastUpdate}`;

    if (isNewData || forceRefresh) {
      console.log(`[Heatmap] Rendering new data from ${sourceLabel}...`);
      renderKPIs(result, lastUpdate);
      renderHeatmap(result);
      renderLiquidationTables(result);
    } else {
      console.log('[Heatmap] Data identical (cache unchanged). Bypassing charts/tables rendering for power efficiency.');
    }

    // Fetch latest trade logs from server to show updated statuses (TP/SL/Cut loss/floating PnL)
    await loadTradeLog();

    updateStatus('normal', 'Live');
  } catch (error) {
    console.error('Error fetching HeatMap data:', error);
    updateStatus('alert', 'Connection Error');
    scheduleRetry();
  } finally {
    btnRefresh.disabled = false;
  }
}

function scheduleRetry() {
  if (retryTimeoutId) clearTimeout(retryTimeoutId);
  retryTimeoutId = setTimeout(() => {
    // Only auto-retry if the tab is currently visible or the bot is active
    if (!document.hidden || autoTradeEnabled) {
      console.log('[AutoRefresh] Attempting automatic recovery retry...');
      loadHeatmapData(false);
    }
  }, 10000); // 10 seconds delay
}

// ─── KPI Rendering ──────────────────────────────────────────
function renderKPIs(data, updateTime) {
  if (!data || !data.series) return;

  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candlestickSeries = data.series.find(s => s.type === 'candlestick');

  if (candlestickSeries && candlestickSeries.data && candlestickSeries.data.length > 0) {
    const lastCandle = candlestickSeries.data[candlestickSeries.data.length - 1];
    const currentPrice = parseFloat(lastCandle[1]);
    currentBtcPriceGlobal = currentPrice;

    valBtcPrice.innerText = formatUSD(currentPrice);
    footBtcPrice.innerText = `${formatBs(currentPrice)} (Equiv.)`;
    timeBtcPrice.innerText = `Last update: ${updateTime}`;

    const highs = candlestickSeries.data.map(c => parseFloat(c[3]));
    const lows = candlestickSeries.data.map(c => parseFloat(c[2]));
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);

    val24hHigh.innerText = formatUSD(maxHigh);
    foot24hHigh.innerText = `${formatBs(maxHigh)} (Equiv.)`;
    time24hHigh.innerText = `Last update: ${updateTime}`;

    val24hLow.innerText = formatUSD(minLow);
    foot24hLow.innerText = `${formatBs(minLow)} (Equiv.)`;
    time24hLow.innerText = `Last update: ${updateTime}`;
  }

  if (heatmapSeries && heatmapSeries.data && heatmapSeries.data.length > 0) {
    let totalLiq = 0;
    heatmapSeries.data.forEach(item => {
      if (item[2]) totalLiq += parseFloat(item[2]);
    });

    valLiqVol.innerText = formatUSD(totalLiq);
    footLiqVol.innerText = `${formatBs(totalLiq)} (Equiv.)`;
    timeLiqVol.innerText = `Last update: ${updateTime}`;
  }
}

// ─── Liquidation Pool Tables ────────────────────────────────
function renderLiquidationTables(data) {
  const aboveContainer = document.getElementById('above-chart-container');
  const belowContainer = document.getElementById('below-chart-container');
  if (!aboveContainer || !belowContainer) return;

  if (!data || !data.series) {
    aboveContainer.innerHTML = '';
    belowContainer.innerHTML = '';
    return;
  }

  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candlestickSeries = data.series.find(s => s.type === 'candlestick');

  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) {
    aboveContainer.innerHTML = '';
    belowContainer.innerHTML = '';
    return;
  }

  let currentPrice = null;
  if (candlestickSeries && candlestickSeries.data && candlestickSeries.data.length > 0) {
    const lastCandle = candlestickSeries.data[candlestickSeries.data.length - 1];
    currentPrice = parseFloat(lastCandle[1]);
  }
  if (!currentPrice) { aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return; }

  // Historical min/max from visible candles
  let maxHigh = currentPrice;
  let minLow = currentPrice;
  if (candlestickSeries && candlestickSeries.data && candlestickSeries.data.length > 0) {
    candlestickSeries.data.forEach(c => {
      const low = parseFloat(c[2]);
      const high = parseFloat(c[3]);
      if (!isNaN(high) && high > maxHigh) maxHigh = high;
      if (!isNaN(low) && low < minLow) minLow = low;
    });
  }

  const yAxisData = data.yAxis || [];

  // Aggregate intensity per price level
  const leveragePerY = {};
  heatmapSeries.data.forEach(item => {
    const yIdx = item[1];
    const val = parseFloat(item[2] || 0);
    leveragePerY[yIdx] = (leveragePerY[yIdx] || 0) + val;
  });

  const levels = [];
  Object.keys(leveragePerY).forEach(yIdxStr => {
    const yIdx = parseInt(yIdxStr, 10);
    const priceStr = yAxisData[yIdx];
    if (!priceStr) return;
    const price = parseFloat(priceStr);
    const leverage = leveragePerY[yIdx];
    const distancePercent = ((price - currentPrice) / currentPrice) * 100;

    let isLiquidated = false;
    const isAbove = price > currentPrice;
    if (isAbove && price <= maxHigh) isLiquidated = true;
    else if (!isAbove && price >= minLow) isLiquidated = true;

    levels.push({ price, leverage, distance: distancePercent, isAbove, isLiquidated });
  });

  const aboveLevels = levels.filter(l => l.isAbove);
  const belowLevels = levels.filter(l => !l.isAbove);

  aboveLevels.sort((a, b) => b.leverage - a.leverage);
  belowLevels.sort((a, b) => b.leverage - a.leverage);

  const topAbove = aboveLevels.slice(0, 5);
  const topBelow = belowLevels.slice(0, 5);

  topAbove.sort((a, b) => a.price - b.price);
  topBelow.sort((a, b) => b.price - a.price);

  const maxLeverage = Math.max(...levels.map(l => l.leverage), 1);

  const renderTableHtml = (pools, isAbove) => {
    const totalActiveVolume = pools.reduce((sum, lvl) => sum + (lvl.isLiquidated ? 0 : lvl.leverage), 0);
    const totalActiveVolumeBs = totalActiveVolume * EXCHANGE_RATE;

    if (pools.length === 0) {
      return `<div class="liq-table-container ${isAbove ? 'above' : 'below'}">
        <h4>${isAbove ? '▲ Resistance Liquidation Pools (Above Price)' : '▼ Support Liquidation Pools (Below Price)'}</h4>
        <div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 12px;">No significant liquidation pools detected.</div>
      </div>`;
    }

    let html = `<div class="liq-table-container ${isAbove ? 'above' : 'below'}">`;
    html += `<h4>`;
    html += isAbove
      ? `▲ Top Resistance Liquidation Pools (Shorts Liquidation Risk Above Current Price: ${formatUSD(currentPrice)} | Total Active: $${formatIntensity(totalActiveVolume)} / Bs. ${formatIntensity(totalActiveVolumeBs)})`
      : `▼ Top Support Liquidation Pools (Longs Liquidation Risk Below Current Price: ${formatUSD(currentPrice)} | Total Active: $${formatIntensity(totalActiveVolume)} / Bs. ${formatIntensity(totalActiveVolumeBs)})`;
    html += `</h4>`;

    html += `<table class="liq-data-table">`;
    html += `<thead><tr>`;
    html += `<th>Rank</th><th>Price Level (USD)</th><th>Price Level (Bs.)</th>`;
    html += `<th>Est. Pool Volume (USD)</th><th>Est. Pool Volume (Bs.)</th>`;
    html += `<th>Distance</th><th>Intensity</th>`;
    html += `</tr></thead><tbody>`;

    pools.forEach((lvl, idx) => {
      const ratio = lvl.leverage / maxLeverage;
      let badgeClass = 'low', badgeLabel = 'Low';
      if (lvl.isLiquidated) { badgeClass = 'liquidated'; badgeLabel = 'Liquidated'; }
      else if (ratio >= 0.7) { badgeClass = 'high'; badgeLabel = 'High'; }
      else if (ratio >= 0.3) { badgeClass = 'medium'; badgeLabel = 'Medium'; }

      let cellStyle = 'font-size: 13px; font-weight: 500;';
      if (lvl.isLiquidated) {
        cellStyle = 'font-size: 11px; font-weight: 400;';
      } else if (badgeClass === 'high') {
        cellStyle = 'font-size: 15.5px; font-weight: 700;';
      } else if (badgeClass === 'medium') {
        cellStyle = 'font-size: 13.5px; font-weight: 600;';
      } else if (badgeClass === 'low') {
        cellStyle = 'font-size: 11.5px; font-weight: 500;';
      }

      const distanceSign = lvl.distance > 0 ? '+' : '';
      const distanceFormatted = `${distanceSign}${lvl.distance.toFixed(2)}%`;
      const volumeBs = lvl.leverage * EXCHANGE_RATE;

      const rowStyle = lvl.isLiquidated ? 'style="opacity: 0.45; text-decoration: line-through; text-decoration-color: rgba(255, 255, 255, 0.35);"' : '';
      const priceColor = lvl.isLiquidated ? 'var(--text-muted)' : '#FFFFFF';
      const volumeColor = lvl.isLiquidated ? 'var(--text-muted)' : (isAbove ? '#bfdc21' : '#3ab56e');
      const distanceColor = lvl.isLiquidated ? 'var(--text-muted)' : (isAbove ? '#FF453A' : '#32D74B');

      const quickActionBtns = lvl.isLiquidated ? '' : `
        <span class="quick-set-btn entry-set" onclick="setPlannerPrice('entry', ${lvl.price})">E</span>
        <span class="quick-set-btn tp-set" onclick="setPlannerPrice('tp', ${lvl.price})">TP</span>
      `;

      html += `<tr ${rowStyle}>`;
      html += `<td style="color: var(--text-muted); ${cellStyle}">#${idx + 1}</td>`;
      html += `<td class="mono" style="font-weight: 600; color: ${priceColor}; ${cellStyle}">$${lvl.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}${quickActionBtns}</td>`;
      html += `<td class="mono" style="color: var(--text-muted); ${cellStyle}">Bs. ${(lvl.price * EXCHANGE_RATE).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>`;
      html += `<td class="mono intensity-cell" style="color: ${volumeColor}; ${cellStyle}">$${formatIntensity(lvl.leverage)}</td>`;
      html += `<td class="mono" style="color: var(--text-muted); ${cellStyle}">Bs. ${formatIntensity(volumeBs)}</td>`;
      html += `<td class="mono" style="color: ${distanceColor}; ${cellStyle}">${distanceFormatted}</td>`;
      html += `<td style="${cellStyle}"><span class="intensity-badge ${badgeClass}">${badgeLabel}</span></td>`;
      html += `</tr>`;
    });

    html += `</tbody></table></div>`;
    return html;
  };

  aboveContainer.innerHTML = renderTableHtml(topAbove, true);
  belowContainer.innerHTML = renderTableHtml(topBelow, false);
}

// ─── ECharts 2D HeatMap with Candlestick Overlay ────────────
function renderHeatmap(data) {
  const chartDom = document.getElementById('liq-heatmap-chart');
  if (!chartDom) return;

  if (myChart) myChart.dispose();
  myChart = echarts.init(chartDom, 'dark', { renderer: 'canvas' });

  const xAxisData = data.xAxis || [];
  const yAxisData = data.yAxis || [];
  const minPrice = yAxisData.length > 0 ? parseFloat(yAxisData[0]) : null;
  const maxPrice = yAxisData.length > 0 ? parseFloat(yAxisData[yAxisData.length - 1]) : null;
  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candlestickSeries = data.series.find(s => s.type === 'candlestick');

  const maxIntensity = data.visualMap ? data.visualMap.max : 20000000;

  const option = {
    backgroundColor: '#010409',
    axisPointer: {
      show: true,
      type: 'cross',
      lineStyle: { color: '#bfdc21', width: 1, type: 'dashed' }
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#121212',
      borderColor: '#2C2C2E',
      borderWidth: 1,
      textStyle: { color: '#FFFFFF', fontFamily: 'Inter' },
      formatter: function (params) {
        if (!params || !params.value) return '';

        if (params.seriesName === 'Liquidation Leverage') {
          const val = params.value;
          const time = xAxisData[val[0]] || '';
          const price = yAxisData[val[1]] || 0;
          const intensity = val[2] || 0;
          const priceFormatted = parseFloat(price).toFixed(2);
          const intensityFormatted = formatIntensity(intensity);

          let html = `<div style="font-family: var(--font-sans); padding: 6px 10px; font-size: 13px; min-width: 220px; line-height: 1.6;">`;
          html += `<strong style="color: #98989D; font-size: 11px; display: block; margin-bottom: 8px;">${time}</strong>`;
          html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">`;
          html += `<span style="color: #FFFFFF; font-size: 12px; display: flex; align-items: center;">`;
          html += `<span style="color: #FFD60A; margin-right: 8px; font-size: 14px;">●</span>Price`;
          html += `</span>`;
          html += `<span style="font-family: var(--font-mono); color: #FFFFFF; font-weight: 500; font-size: 12px;">${priceFormatted}</span>`;
          html += `</div>`;
          html += `<div style="display: flex; justify-content: space-between; align-items: center;">`;
          html += `<span style="color: #FFFFFF; font-size: 12px; display: flex; align-items: center;">`;
          html += `<span style="color: #FFD60A; margin-right: 8px; font-size: 14px;">●</span>Liquidation Leverage`;
          html += `</span>`;
          html += `<span style="font-family: var(--font-mono); color: #FFFFFF; font-weight: 500; font-size: 12px;">${intensityFormatted}</span>`;
          html += `</div></div>`;
          return html;
        }

        if (params.seriesName === 'Supercharts') {
          const time = xAxisData[params.dataIndex] || '';
          const ohlc = params.value;
          let open, close, low, high;
          if (ohlc.length === 5) {
            open = parseFloat(ohlc[1]); close = parseFloat(ohlc[2]);
            low = parseFloat(ohlc[3]); high = parseFloat(ohlc[4]);
          } else {
            open = parseFloat(ohlc[0]); close = parseFloat(ohlc[1]);
            low = parseFloat(ohlc[2]); high = parseFloat(ohlc[3]);
          }

          let html = `<div style="font-family: var(--font-sans); padding: 6px 10px; font-size: 13px; min-width: 180px; line-height: 1.6;">`;
          html += `<strong style="color: #98989D; font-size: 11px; display: block; margin-bottom: 8px;">${time}</strong>`;
          html += `<div style="display: flex; justify-content: space-between; margin-bottom: 4px;"><span style="color: #98989D; font-size: 12px;">Open:</span><span style="font-family: var(--font-mono); color: #FFFFFF; font-weight: 500; font-size: 12px;">${formatUSD(open)}</span></div>`;
          html += `<div style="display: flex; justify-content: space-between; margin-bottom: 4px;"><span style="color: #98989D; font-size: 12px;">Close:</span><span style="font-family: var(--font-mono); color: #FFFFFF; font-weight: 500; font-size: 12px;">${formatUSD(close)}</span></div>`;
          html += `<div style="display: flex; justify-content: space-between; margin-bottom: 4px;"><span style="color: #98989D; font-size: 12px;">High:</span><span style="font-family: var(--font-mono); color: #32D74B; font-weight: 500; font-size: 12px;">${formatUSD(high)}</span></div>`;
          html += `<div style="display: flex; justify-content: space-between;"><span style="color: #98989D; font-size: 12px;">Low:</span><span style="font-family: var(--font-mono); color: #FF453A; font-weight: 500; font-size: 12px;">${formatUSD(low)}</span></div>`;
          html += `</div>`;
          return html;
        }
        return '';
      }
    },
    grid: {
      top: '5%', bottom: '10%', left: '8%', right: '4%',
      show: true,
      backgroundColor: '#46035c',
      borderColor: 'transparent'
    },
    xAxis: {
      type: 'category',
      data: xAxisData,
      boundaryGap: true,
      splitLine: { show: true, lineStyle: { color: '#31235a' } },
      axisLine: { lineStyle: { color: '#31235a' } },
      axisLabel: {
        color: '#98989D', fontFamily: 'Inter', fontSize: 10,
        formatter: function (value) {
          if (!value) return '';
          const parts = value.split(', ');
          return parts[1] || value;
        }
      }
    },
    yAxis: [
      {
        type: 'category',
        data: yAxisData,
        splitArea: { show: false },
        splitLine: { show: true, lineStyle: { color: '#31235a' } },
        axisLine: { lineStyle: { color: '#31235a' } },
        axisLabel: {
          color: '#98989D', fontFamily: 'JetBrains Mono', fontSize: 10,
          formatter: function (value) { return formatUSD(parseFloat(value)); }
        }
      },
      {
        type: 'value', scale: true, min: minPrice, max: maxPrice, show: false
      }
    ],
    visualMap: {
      show: true, min: 0, max: maxIntensity,
      calculable: true, orient: 'horizontal', left: 'center', bottom: '2%',
      itemWidth: 15, itemHeight: 250,
      textStyle: { color: '#98989D', fontFamily: 'Inter', fontSize: 11 },
      inRange: {
        color: [
          '#46035c', '#373d77', '#28738f', '#238c89',
          '#24a480', '#3ab56e', '#66c751', '#bfdc21'
        ]
      }
    },
    series: [
      {
        name: 'Liquidation Leverage',
        type: 'heatmap',
        data: heatmapSeries ? heatmapSeries.data : [],
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
      },
      {
        name: 'Supercharts',
        type: 'candlestick',
        yAxisIndex: 1,
        data: candlestickSeries ? candlestickSeries.data.map(c => [
          parseFloat(c[0]), parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3])
        ]) : [],
        itemStyle: {
          color: '#32D74B', color0: '#FF453A',
          borderColor: '#32D74B', borderColor0: '#FF453A'
        }
      }
    ]
  };

  myChart.setOption(option);
  window.addEventListener('resize', () => { myChart && myChart.resize(); });
}

// ─── Quick Set Price from Table E / TP Buttons ──────────────
window.setPlannerPrice = (type, price) => {
  const input = document.getElementById(`input-${type}`);
  if (input) {
    input.value = parseFloat(price).toFixed(2);
  }
};

// ─── Add Trade Directly from Inline Form ────────────────────
async function addTradeFromForm() {
  const btnLong = document.getElementById('btn-toggle-long');
  const direction = btnLong && btnLong.classList.contains('active') ? 'LONG' : 'SHORT';
  const capital = parseFloat(document.getElementById('input-capital').value) || 0;
  const riskPercent = parseFloat(document.getElementById('input-risk').value) || 0;
  const entry = parseFloat(document.getElementById('input-entry').value) || 0;
  const tp = parseFloat(document.getElementById('input-tp').value) || 0;
  const sl = parseFloat(document.getElementById('input-sl').value) || 0;

  // Validate fields
  if (!entry || !tp || !sl || !capital || !riskPercent) {
    alert('Lengkapi semua field: Entry, TP, SL, Capital, Risk %');
    return;
  }

  // Validate direction consistency
  if (direction === 'LONG') {
    if (tp <= entry) { alert('TP harus lebih tinggi dari Entry untuk LONG'); return; }
    if (sl >= entry) { alert('SL harus lebih rendah dari Entry untuk LONG'); return; }
  } else {
    if (tp >= entry) { alert('TP harus lebih rendah dari Entry untuk SHORT'); return; }
    if (sl <= entry) { alert('SL harus lebih tinggi dari Entry untuk SHORT'); return; }
  }

  // Calculate metrics
  const riskUsd = capital * (riskPercent / 100);
  const slDistance = Math.abs(((entry - sl) / entry) * 100);
  const tpDistance = Math.abs(((tp - entry) / entry) * 100);
  const positionSizeUsd = riskUsd / (slDistance / 100);

  // Capture initial TP pool volume for auto-cut-loss detection
  let initialTpVolume = null;
  if (lastHeatmapDataGlobal && lastHeatmapDataGlobal.yAxis) {
    const yAxisData = lastHeatmapDataGlobal.yAxis;
    let closestYIdx = 0, minDiff = Infinity;
    yAxisData.forEach((priceStr, idx) => {
      const diff = Math.abs(parseFloat(priceStr) - tp);
      if (diff < minDiff) { minDiff = diff; closestYIdx = idx; }
    });
    const hs = lastHeatmapDataGlobal.series.find(s => s.type === 'heatmap');
    if (hs && hs.data) {
      let vol = 0;
      hs.data.forEach(item => {
        const v = Array.isArray(item) ? item : (item.value || []);
        if (parseInt(v[1], 10) === closestYIdx) vol += parseFloat(v[2] || 0);
      });
      if (vol > 0) initialTpVolume = vol;
    }
  }

  // Create trade object
  const newTrade = {
    id: 'T' + Date.now(),
    time: new Date().toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction, entry, tp, sl, capital, riskPercent, riskUsd,
    positionSizeUsd, tpDistance, slDistance,
    status: 'ACTIVE', pnl: 0, initialTpVolume
  };

  try {
    const response = await fetch('/api/trades/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTrade)
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `HTTP error ${response.status}`);
    }
    await loadTradeLog();

    // Clear entry/tp/sl inputs for next trade
    document.getElementById('input-entry').value = '';
    document.getElementById('input-tp').value = '';
    document.getElementById('input-sl').value = '';
  } catch (error) {
    console.error('Error adding trade:', error);
    alert('Failed to add trade: ' + error.message);
  }
}

// ─── Trade Log REST API Database Sync ───────────────────────
async function loadTradeLog() {
  try {
    const response = await fetch('/api/trades');
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const resObj = await response.json();
    tradeLog = resObj.data || [];
    renderBacktestTable();
  } catch (error) {
    console.error('Error loading trades from server:', error);
  }
}

// ─── Manual Trade Actions ───────────────────────────────────
window.manualCutLoss = async (tradeId) => {
  if (!currentBtcPriceGlobal) {
    alert('Harga BTC belum sinkron. Tunggu update data.');
    return;
  }
  try {
    const response = await fetch('/api/trades/cut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tradeId, closePrice: currentBtcPriceGlobal })
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `HTTP error ${response.status}`);
    }
    await loadTradeLog();
  } catch (error) {
    console.error('Error cutting trade:', error);
    alert('Failed to cut trade: ' + error.message);
  }
};

window.deleteTrade = async (tradeId) => {
  try {
    const response = await fetch('/api/trades/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tradeId })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    await loadTradeLog();
  } catch (error) {
    console.error('Error deleting trade:', error);
    alert('Failed to delete trade.');
  }
};

window.clearTradeLog = async () => {
  if (confirm('Hapus semua data backtest?')) {
    try {
      const response = await fetch('/api/trades/clear', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      await loadTradeLog();
    } catch (error) {
      console.error('Error clearing trades:', error);
      alert('Failed to clear trade log.');
    }
  }
};

// ─── Render Backtest Stats & Log Table ──────────────────────
function renderBacktestTable() {
  const tbody = document.getElementById('backtest-log-tbody');
  if (!tbody) return;

  const total = tradeLog.length;
  const hitTp = tradeLog.filter(t => t.status === 'HIT_TP');
  const hitSl = tradeLog.filter(t => t.status === 'HIT_SL');
  const cutLoss = tradeLog.filter(t => t.status === 'CUT_LOSS');
  const closedCount = tradeLog.filter(t => t.status !== 'ACTIVE').length;
  const winRate = closedCount > 0 ? (hitTp.length / closedCount) * 100 : 0;
  const netPnl = tradeLog.reduce((sum, t) => sum + t.pnl, 0);

  document.getElementById('stat-total-trades').innerText = total;
  document.getElementById('stat-winrate').innerText = `${winRate.toFixed(1)}%`;
  document.getElementById('stat-hit-tp').innerText = hitTp.length;
  document.getElementById('stat-hit-sl').innerText = hitSl.length;
  document.getElementById('stat-cut-loss').innerText = cutLoss.length;

  const npUsd = document.getElementById('stat-net-profit-usd');
  const npBs = document.getElementById('stat-net-profit-bs');
  npUsd.innerText = formatUSD(netPnl);
  npBs.innerText = formatBs(netPnl);
  npUsd.className = 'backtest-stat-value ' + (netPnl >= 0 ? 'profit-positive' : 'profit-negative');
  npBs.className = 'backtest-stat-value ' + (netPnl >= 0 ? 'profit-positive' : 'profit-negative');

  if (!total) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; color:var(--text-muted); padding:20px;">No trades logged. Use the form above or click E / TP in tables.</td></tr>`;
    return;
  }

  let html = '';
  tradeLog.forEach(trade => {
    const statusHtml = {
      'ACTIVE': '<span class="status-badge active">Active</span>',
      'HIT_TP': '<span class="status-badge hit-tp">Hit TP</span>',
      'HIT_SL': '<span class="status-badge hit-sl">Hit SL</span>',
      'CUT_LOSS': '<span class="status-badge cut-loss">Cut Loss</span>'
    };

    const rr = (trade.tpDistance / trade.slDistance).toFixed(2);
    const pnlClass = trade.pnl > 0 ? 'text-positive' : (trade.pnl < 0 ? 'text-negative' : '');
    const pnlUsd = formatUSD(trade.pnl);
    const pnlBs = formatBs(trade.pnl);

    const actionBtn = trade.status === 'ACTIVE'
      ? `<button class="btn-action-sm warning" onclick="manualCutLoss('${trade.id}')">Cut</button> `
      : '';
    const delBtn = `<button class="btn-action-sm danger" onclick="deleteTrade('${trade.id}')">Del</button>`;
    const rowOpacity = trade.status !== 'ACTIVE' ? 'style="opacity:0.75;"' : '';

    // Calculate current live or closed Mark Price
    const markPriceVal = trade.status === 'ACTIVE' ? (currentBtcPriceGlobal || trade.entry) : (trade.closePrice || trade.entry);

    html += `<tr ${rowOpacity}>`;
    html += `<td>${trade.time}</td>`;
    html += `<td style="font-weight:700; color:${trade.direction === 'LONG' ? '#32D74B' : '#FF453A'};">${trade.direction}</td>`;
    html += `<td class="mono">$${trade.entry.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>`;
    html += `<td class="mono" style="color:#32D74B;">$${trade.tp.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>`;
    html += `<td class="mono" style="color:#FF453A;">$${trade.sl.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>`;
    html += `<td class="mono">$${trade.positionSizeUsd.toLocaleString(undefined, {maximumFractionDigits: 0})}</td>`;
    html += `<td class="mono">1:${rr}</td>`;
    html += `<td>${statusHtml[trade.status]}${trade.note ? `<br><span style="font-size:9px;color:var(--text-muted);">${trade.note}</span>` : ''}</td>`;
    html += `<td class="mono">$${markPriceVal.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>`;
    html += `<td class="mono ${pnlClass}" style="font-weight:600;">${pnlUsd}</td>`;
    html += `<td class="mono ${pnlClass}">${pnlBs}</td>`;
    html += `<td>${actionBtn}${delBtn}</td>`;
    html += `</tr>`;
  });

  tbody.innerHTML = html;
}

// ─── Auto-Trade Bot: Settings Sync ──────────────────────────
async function loadSettingsFromServer() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const resObj = await response.json();
    const settings = resObj.data;

    // Update inputs
    document.getElementById('input-capital').value = settings.capital;
    document.getElementById('input-risk').value = settings.riskPercent;
    document.getElementById('auto-min-rr').value = settings.minRR;
    
    const minProbEl = document.getElementById('auto-min-prob');
    if (minProbEl) minProbEl.value = settings.minReversalProbability || 65;

    document.getElementById('auto-max-active').value = settings.maxActive;
    const sweepCandlesEl = document.getElementById('auto-sweep-candles');
    if (sweepCandlesEl) sweepCandlesEl.value = settings.sweepConfirmCandles || 3;
    const cooldownEl = document.getElementById('auto-cooldown');
    if (cooldownEl) cooldownEl.value = settings.cooldownMinutes || 60;
    document.getElementById('tele-bot-token').value = settings.telegramBotToken || '';
    document.getElementById('tele-chat-id').value = settings.telegramChatId || '';

    autoTradeEnabled = settings.autoTradeEnabled;
    const btnAutoToggle = document.getElementById('btn-auto-trade-toggle');
    if (btnAutoToggle) {
      btnAutoToggle.className = `auto-toggle-btn ${autoTradeEnabled ? 'on' : 'off'}`;
      btnAutoToggle.innerText = autoTradeEnabled ? 'ON' : 'OFF';
    }
    updateAutoStatus(autoTradeEnabled ? 'active' : '', autoTradeEnabled ? 'LSR Bot active (Server)' : 'LSR Bot inactive');

    // Start bot status polling
    pollBotStatus();
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function saveSettingsToServer() {
  const capital = parseFloat(document.getElementById('input-capital').value) || 1000;
  const riskPercent = parseFloat(document.getElementById('input-risk').value) || 1.0;
  const minRR = parseFloat(document.getElementById('auto-min-rr').value) || 2.0;
  
  const minProbEl = document.getElementById('auto-min-prob');
  const minReversalProbability = minProbEl ? (parseInt(minProbEl.value, 10) || 65) : 65;

  const maxActive = parseInt(document.getElementById('auto-max-active').value, 10) || 1;
  const sweepConfirmCandles = parseInt((document.getElementById('auto-sweep-candles') || {}).value, 10) || 3;
  const cooldownMinutes = parseInt((document.getElementById('auto-cooldown') || {}).value, 10) || 60;
  const telegramBotToken = document.getElementById('tele-bot-token').value || '';
  const telegramChatId = document.getElementById('tele-chat-id').value || '';

  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capital,
        riskPercent,
        minRR,
        minReversalProbability,
        maxActive,
        sweepConfirmCandles,
        cooldownMinutes,
        autoTradeEnabled,
        telegramBotToken,
        telegramChatId
      })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const resObj = await response.json();
    console.log('Settings saved to server:', resObj.data);
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

// ─── LSR Bot Phase Status Polling ───────────────────────────
let botStatusIntervalId = null;

async function pollBotStatus() {
  // Clear previous interval
  if (botStatusIntervalId) clearInterval(botStatusIntervalId);

  async function fetchBotStatus() {
    try {
      const response = await fetch('/api/bot-status');
      if (!response.ok) return;
      const resObj = await response.json();
      const data = resObj.data;

      // Update phase badge
      const phaseBadge = document.getElementById('lsr-phase-badge');
      if (phaseBadge) {
        phaseBadge.innerText = data.phase;
        // Color coding per phase
        const phaseColors = {
          'STANDBY': { bg: 'rgba(152, 152, 157, 0.2)', color: '#98989D' },
          'ALERT': { bg: 'rgba(255, 159, 10, 0.25)', color: '#FF9F0A' },
          'SWEEP_DETECTED': { bg: 'rgba(50, 215, 75, 0.25)', color: '#32D74B' },
          'TRADE_EXECUTED': { bg: 'rgba(0, 229, 255, 0.25)', color: '#00E5FF' },
          'SWEEP_REJECTED': { bg: 'rgba(255, 69, 58, 0.2)', color: '#FF453A' },
          'COOLDOWN': { bg: 'rgba(191, 90, 242, 0.2)', color: '#BF5AF2' },
          'MAX_ACTIVE': { bg: 'rgba(255, 214, 10, 0.2)', color: '#FFD60A' },
          'DISABLED': { bg: 'rgba(255, 69, 58, 0.15)', color: '#FF453A' },
          'NO_DATA': { bg: 'rgba(152, 152, 157, 0.15)', color: '#636366' },
          'INITIALIZING': { bg: 'rgba(152, 152, 157, 0.15)', color: '#636366' }
        };
        const colors = phaseColors[data.phase] || phaseColors['STANDBY'];
        phaseBadge.style.background = colors.bg;
        phaseBadge.style.color = colors.color;
      }

      // Update reversal probability text display
      const probValEl = document.getElementById('lsr-prob-val');
      if (probValEl) {
        const prob = (data.metrics && data.metrics.reversalProbability) ? data.metrics.reversalProbability : null;
        if (prob !== null) {
          probValEl.innerText = `${prob}%`;
          if (prob >= 75) {
            probValEl.style.color = '#32D74B'; // Strong Green
          } else if (prob >= 65) {
            probValEl.style.color = '#FFD60A'; // Yellow
          } else {
            probValEl.style.color = '#FF453A'; // Red
          }
        } else {
          probValEl.innerText = '—';
          probValEl.style.color = 'var(--text-muted)';
        }
      }

      // Update nearest pool
      const poolEl = document.getElementById('lsr-nearest-pool');
      if (poolEl) {
        if (data.nearestPool) {
          const poolColor = data.nearestPoolSide === 'RESISTANCE' ? '#FF453A' : '#32D74B';
          poolEl.innerHTML = `<span style="color:${poolColor};font-weight:600;">$${parseFloat(data.nearestPool).toLocaleString()}</span> <span style="color:#636366;">(${data.nearestPoolSide} ${data.nearestPoolDistance})</span>`;
        } else {
          poolEl.innerText = '—';
        }
      }

      // Update message
      const msgEl = document.getElementById('lsr-message');
      if (msgEl) {
        msgEl.innerText = data.message || 'Waiting for data...';
      }

      // Update status dot based on phase
      const dotStates = {
        'STANDBY': 'scanning',
        'ALERT': 'active',
        'TRADE_EXECUTED': 'active',
        'DISABLED': '',
        'COOLDOWN': 'scanning',
        'SWEEP_REJECTED': 'scanning'
      };
      updateAutoStatus(dotStates[data.phase] || 'scanning', data.autoTradeEnabled ? `LSR ${data.phase}` : 'LSR Bot inactive');

    } catch (error) {
      console.error('Error fetching bot status:', error);
    }
  }

  // Initial fetch
  await fetchBotStatus();

  // Poll every 30 seconds
  botStatusIntervalId = setInterval(fetchBotStatus, 30000);
}

function updateAutoStatus(state, text) {
  const statusEl = document.getElementById('auto-trade-status');
  if (!statusEl) return;
  const dot = statusEl.querySelector('.auto-status-dot');
  const txt = statusEl.querySelector('.auto-status-text');
  dot.className = `auto-status-dot ${state}`;
  txt.innerText = text;
}

// ─── Refresh Button ─────────────────────────────────────────
btnRefresh.addEventListener('click', () => loadHeatmapData(true));

// ─── Adaptive Auto-Refresh (Power Saving) ───────────────────
function setupAutoRefresh() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }

  const isHidden = document.hidden;
  let intervalMs = 900000; // 15 minutes default

  if (autoTradeEnabled) {
    // If bot is active, refresh faster (3 minutes) to scan for setups
    intervalMs = 180000;
  } else if (isHidden) {
    // If tab is hidden and bot is inactive, pause refresh completely
    console.log('[Power Saving] Tab is hidden and bot is inactive. Auto-refresh paused.');
    return;
  }

  console.log(`[AutoRefresh] Setting interval to ${intervalMs / 1000}s. (Bot: ${autoTradeEnabled ? 'ON' : 'OFF'}, Tab: ${isHidden ? 'Hidden' : 'Visible'})`);

  refreshIntervalId = setInterval(() => {
    loadHeatmapData(true);
  }, intervalMs);
}

async function migrateLocalTrades() {
  const stored = localStorage.getItem('wattvision_tradelog');
  if (stored) {
    try {
      const localTrades = JSON.parse(stored);
      if (localTrades && localTrades.length > 0) {
        console.log(`[Migration] Found ${localTrades.length} local trades. Uploading to server...`);
        for (const trade of localTrades) {
          await fetch('/api/trades/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(trade)
          });
        }
        console.log('[Migration] Migration complete. Clearing localStorage.');
      }
    } catch (e) {
      console.error('[Migration] Failed to migrate local trades:', e);
    }
    localStorage.removeItem('wattvision_tradelog');
    await loadTradeLog();
  }
}

// ─── Initialization ─────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Load settings from server first, which will also set autoTradeEnabled and update the bot toggle button
  loadSettingsFromServer();

  // One-time automatic migration of old browser trade logs to server
  migrateLocalTrades();

  loadHeatmapData(false);

  // Setup initial adaptive refresh
  setupAutoRefresh();

  // Listen for tab visibility changes
  document.addEventListener('visibilitychange', () => {
    console.log(`[Visibility] Tab state changed to: ${document.hidden ? 'hidden' : 'visible'}`);
    if (!document.hidden) {
      // Instantly load data on returning to tab, but delay by 2 seconds to allow system stability
      setTimeout(() => {
        if (!document.hidden) {
          console.log('[Visibility] Tab active. Running debounced wakeup refresh...');
          loadHeatmapData(true);
        }
      }, 2000);
    }
    setupAutoRefresh();
  });

  // Listen for setting inputs change to save them to the server
  ['input-capital', 'input-risk', 'auto-min-rr', 'auto-max-active', 'auto-sweep-candles', 'auto-cooldown', 'tele-bot-token', 'tele-chat-id'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', saveSettingsToServer);
    }
  });

  // Telegram test button
  const btnTestTelegram = document.getElementById('btn-test-telegram');
  if (btnTestTelegram) {
    btnTestTelegram.addEventListener('click', async () => {
      const token = document.getElementById('tele-bot-token').value || '';
      const chatId = document.getElementById('tele-chat-id').value || '';

      if (!token || !chatId) {
        alert('Lengkapi Bot Token dan Chat ID sebelum melakukan tes.');
        return;
      }

      btnTestTelegram.disabled = true;
      btnTestTelegram.innerText = '⏳ Sending...';

      try {
        const response = await fetch('/api/telegram/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, chatId })
        });
        const resObj = await response.json();
        if (resObj.success) {
          alert('Berhasil! Pesan tes telah dikirim ke Telegram.');
        } else {
          alert(`Gagal mengirim tes: ${resObj.error}`);
        }
      } catch (error) {
        console.error('Telegram test error:', error);
        alert('Gagal mengirim pesan tes (koneksi bermasalah).');
      } finally {
        btnTestTelegram.disabled = false;
        btnTestTelegram.innerText = '⚡ Test Send';
      }
    });
  }

  // Direction toggle buttons
  const btnLong = document.getElementById('btn-toggle-long');
  const btnShort = document.getElementById('btn-toggle-short');
  if (btnLong && btnShort) {
    btnLong.addEventListener('click', () => {
      btnLong.classList.add('active');
      btnShort.classList.remove('active');
    });
    btnShort.addEventListener('click', () => {
      btnShort.classList.add('active');
      btnLong.classList.remove('active');
    });
  }

  // Add Trade button
  const btnAddTrade = document.getElementById('btn-add-trade');
  if (btnAddTrade) {
    btnAddTrade.addEventListener('click', addTradeFromForm);
  }

  // Clear log button
  const btnClearLog = document.getElementById('btn-clear-backtest-log');
  if (btnClearLog) {
    btnClearLog.addEventListener('click', window.clearTradeLog);
  }

  // Auto-Trade Bot toggle
  const btnAutoToggle = document.getElementById('btn-auto-trade-toggle');
  if (btnAutoToggle) {
    btnAutoToggle.addEventListener('click', async () => {
      autoTradeEnabled = !autoTradeEnabled;
      btnAutoToggle.className = `auto-toggle-btn ${autoTradeEnabled ? 'on' : 'off'}`;
      btnAutoToggle.innerText = autoTradeEnabled ? 'ON' : 'OFF';
      updateAutoStatus(autoTradeEnabled ? 'active' : '', autoTradeEnabled ? 'Bot active (Running on server)' : 'Bot inactive');
      
      // Save settings to server with updated autoTradeEnabled value
      await saveSettingsToServer();
      
      // Reconfigure refresh interval when bot state changes
      setupAutoRefresh();
    });
  }
});
