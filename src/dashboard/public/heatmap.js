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
let currentCoinGlobal = 'BTC';
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
      if (response.status === 409) {
        // Scrape in progress — silent retry, keep showing last data
        updateStatus('loading', 'Scraping...');
        scheduleRetry();
        btnRefresh.disabled = false;
        return;
      }
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'HTTP error ' + response.status);
    }

    const resObj = await response.json();
    const result = resObj.data.data;
    const timestamp = resObj.data.timestamp;
    const coin = resObj.data.coin || 'BTC';
    const tvSymbol = resObj.data.tvSymbol || '';

    currentCoinGlobal = coin;

    // Update Pair Displays in DOM
    const currentPairBadge = document.getElementById('current-pair-badge');
    if (currentPairBadge) {
      currentPairBadge.innerText = `${coin}/USDT` + (tvSymbol ? ` (TV: ${tvSymbol})` : '');
    }
    const kpiPairPriceLabel = document.getElementById('kpi-pair-price-label');
    if (kpiPairPriceLabel) {
      kpiPairPriceLabel.innerText = `${coin} Price (Binance)`;
    }
    const heatmapTitleHeading = document.getElementById('heatmap-title-heading');
    if (heatmapTitleHeading) {
      heatmapTitleHeading.innerText = `Binance ${coin}/USDT Liquidation HeatMap`;
    }

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

  if (!data || !data.series) { aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return; }

  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candlestickSeries = data.series.find(s => s.type === 'candlestick');

  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) {
    aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return;
  }

  let currentPrice = null;
  if (candlestickSeries && candlestickSeries.data && candlestickSeries.data.length > 0) {
    const lastCandle = candlestickSeries.data[candlestickSeries.data.length - 1];
    currentPrice = parseFloat(lastCandle[1]);
  }
  if (!currentPrice) { aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return; }

  let maxHigh = currentPrice, minLow = currentPrice;
  if (candlestickSeries && candlestickSeries.data) {
    candlestickSeries.data.forEach(c => {
      const low = parseFloat(c[2]), high = parseFloat(c[3]);
      if (!isNaN(high) && high > maxHigh) maxHigh = high;
      if (!isNaN(low) && low < minLow) minLow = low;
    });
  }

  const yAxisData = data.yAxis || [];
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
    const isAbove = price > currentPrice;
    const isLiquidated = isAbove ? (price <= maxHigh) : (price >= minLow);
    levels.push({ price, leverage, distance: distancePercent, isAbove, isLiquidated });
  });

  const aboveLevels = levels.filter(l => l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5).sort((a, b) => a.price - b.price);
  const belowLevels = levels.filter(l => !l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5).sort((a, b) => b.price - a.price);
  const maxLeverage = Math.max(...levels.map(l => l.leverage), 1);

  const renderTableHtml = (pools, isAbove) => {
    const totalActive = pools.reduce((sum, lvl) => sum + (lvl.isLiquidated ? 0 : lvl.leverage), 0);
    const totalActiveBs = totalActive * EXCHANGE_RATE;

    if (pools.length === 0) return '<div class="liq-table-container ' + (isAbove ? 'above' : 'below') + '">'
      + '<h4>' + (isAbove ? '▲ Resistance Liquidation Pools (Above Price)' : '▼ Support Liquidation Pools (Below Price)') + '</h4>'
      + '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">No significant liquidation pools detected.</div></div>';

    let html = '<div class="liq-table-container ' + (isAbove ? 'above' : 'below') + '">';
    html += '<h4>' + (isAbove ? '▲ Top Resistance Liquidation Pools' : '▼ Top Support Liquidation Pools')
      + ' — Current: ' + formatUSD(currentPrice) + ' | Active: $' + formatIntensity(totalActive) + '</h4>';
    html += '<table class="liq-data-table"><thead><tr>'
      + '<th>Rank</th><th>Price (USD)</th>'
      + '<th>Pool Vol (USD)</th><th>Distance</th><th>Intensity</th>'
      + '</tr></thead><tbody>';

    pools.forEach((lvl, idx) => {
      const ratio = lvl.leverage / maxLeverage;
      let badgeClass = 'low', badgeLabel = 'Low';
      if (lvl.isLiquidated) { badgeClass = 'liquidated'; badgeLabel = 'Liquidated'; }
      else if (ratio >= 0.7) { badgeClass = 'high'; badgeLabel = 'High'; }
      else if (ratio >= 0.3) { badgeClass = 'medium'; badgeLabel = 'Medium'; }

      let cellStyle = 'font-size:13px;font-weight:500;';
      if (lvl.isLiquidated) cellStyle = 'font-size:11px;font-weight:400;';

      const distSign = lvl.distance > 0 ? '+' : '';
      const volBs = lvl.leverage * EXCHANGE_RATE;
      const isLiq = lvl.isLiquidated;
      const rowOpacity = isLiq ? ' style="opacity:0.45;"' : '';
      const priceColor = isLiq ? 'var(--text-muted)' : '#FFFFFF';
      const volColor = isLiq ? 'var(--text-muted)' : (isAbove ? '#bfdc21' : '#3ab56e');
      const distColor = isLiq ? 'var(--text-muted)' : (isAbove ? '#FF453A' : '#32D74B');
      const quickBtns = isLiq ? '' : '<span class="quick-set-btn entry-set" onclick="setPlannerPrice(\'entry\',' + lvl.price + ')">E</span>'
        + '<span class="quick-set-btn tp-set" onclick="setPlannerPrice(\'tp\',' + lvl.price + ')">TP</span>';

      html += '<tr' + rowOpacity + '>'
        + '<td style="color:var(--text-muted);' + cellStyle + '">#' + (idx+1) + '</td>'
        + '<td class="mono" style="font-weight:600;color:' + priceColor + ';' + cellStyle + '">$' + lvl.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + quickBtns + '</td>'
        + '<td class="mono intensity-cell" style="color:' + volColor + ';' + cellStyle + '">$' + formatIntensity(lvl.leverage) + '</td>'
        + '<td class="mono" style="color:' + distColor + ';' + cellStyle + '">' + distSign + lvl.distance.toFixed(2) + '%</td>'
        + '<td style="' + cellStyle + '"><span class="intensity-badge ' + badgeClass + '">' + badgeLabel + '</span></td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  };

  aboveContainer.innerHTML = renderTableHtml(aboveLevels, true);
  belowContainer.innerHTML = renderTableHtml(belowLevels, false);
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
      alwaysShowContent: false,
      hideDelay: 0,
      transitionDuration: 0,
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

  // Hide tooltip when mouse leaves the chart container
  myChart.on('globalout', () => {
    myChart.dispatchAction({ type: 'hideTip' });
    myChart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' });
    myChart.dispatchAction({ type: 'downplay' });
    myChart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: -1 });
  });

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
  const timestamp = Date.now();
  const newTrade = {
    id: 'T' + timestamp,
    timestamp,
    time: new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
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
    alert(`Harga ${currentCoinGlobal} belum sinkron. Tunggu update data.`);
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

    // Format trade time dynamically in browser timezone
    let displayTime = trade.time;
    let timestamp = trade.timestamp;
    if (!timestamp && trade.id && trade.id.startsWith('T')) {
      const ts = parseInt(trade.id.substring(1), 10);
      if (!isNaN(ts)) {
        timestamp = ts;
      }
    }
    if (timestamp) {
      try {
        const date = new Date(timestamp);
        const day = date.getDate().toString().padStart(2, '0');
        const month = date.toLocaleString('id-ID', { month: 'short' });
        const hour = date.getHours().toString().padStart(2, '0');
        const minute = date.getMinutes().toString().padStart(2, '0');
        displayTime = `${day} ${month}, ${hour}.${minute}`;
      } catch (e) {
        console.error('Error formatting trade local time:', e);
      }
    }

    // Close timestamp logic
    let closeTimestamp = trade.closeTimestamp;
    if (!closeTimestamp && trade.status !== 'ACTIVE') {
      closeTimestamp = timestamp; // fallback to entry time
    }

    const formatTimeOnly = (ts) => {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        return d.getHours().toString().padStart(2, '0') + '.' + d.getMinutes().toString().padStart(2, '0');
      } catch (e) {
        return '';
      }
    };

    const entryTimeStr = formatTimeOnly(timestamp);
    const entrySubtext = entryTimeStr ? `<br><span style="font-size:9px;color:var(--text-muted);font-weight:normal;">${entryTimeStr}</span>` : '';

    const tpTimeStr = trade.status === 'HIT_TP' ? formatTimeOnly(closeTimestamp) : '';
    const tpSubtext = tpTimeStr ? `<br><span style="font-size:9px;color:var(--text-muted);font-weight:normal;">${tpTimeStr}</span>` : '';

    const slTimeStr = (trade.status === 'HIT_SL' || trade.status === 'CUT_LOSS') ? formatTimeOnly(closeTimestamp) : '';
    const slSubtext = slTimeStr ? `<br><span style="font-size:9px;color:var(--text-muted);font-weight:normal;">${slTimeStr}</span>` : '';

    html += `<tr ${rowOpacity}>`;
    html += `<td>${displayTime}</td>`;
    html += `<td style="font-weight:700; color:${trade.direction === 'LONG' ? '#32D74B' : '#FF453A'};">${trade.direction}</td>`;
    html += `<td class="mono">$${trade.entry.toLocaleString(undefined, {minimumFractionDigits: 2})}${entrySubtext}</td>`;
    html += `<td class="mono" style="color:#32D74B;">$${trade.tp.toLocaleString(undefined, {minimumFractionDigits: 2})}${tpSubtext}</td>`;
    html += `<td class="mono" style="color:#FF453A;">$${trade.sl.toLocaleString(undefined, {minimumFractionDigits: 2})}${slSubtext}</td>`;
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

      // Update Funding Rate
      const fundingEl = document.getElementById('lsr-funding-rate-val');
      if (fundingEl) {
        const fundingVal = (data.metrics && data.metrics.fundingRate) ? (data.metrics.fundingRate * 100) : 0;
        fundingEl.innerText = `${fundingVal.toFixed(4)}%`;
        fundingEl.style.color = fundingVal >= 0 ? '#FFD60A' : '#32D74B';
      }

      // Update Long/Short Ratio
      const lsRatioEl = document.getElementById('lsr-ls-ratio-val');
      if (lsRatioEl) {
        const lsRatioVal = (data.metrics && data.metrics.longShortRatio) ? data.metrics.longShortRatio : 1.0;
        lsRatioEl.innerText = lsRatioVal.toFixed(2);
        lsRatioEl.style.color = '#00E5FF';
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


// ── Sweep Prediction Panel ────────────────────────────────────────────────────
async function loadSweepPrediction() {
  try {
    const res = await fetch('/api/sweep-prediction');
    if (!res.ok) return;
    const json = await res.json();
    const d = json.data;
    if (!d) return;

    const panel = document.getElementById('sweep-prediction-panel');
    if (!panel) return;

    const isUp = d.direction === 'UP';
    const dirColor = isUp ? '#13fed9' : '#f23744';
    const dirArrow = isUp ? '▲' : '▼';
    const dirLabel = isUp ? 'UPSIDE SWEEP' : 'DOWNSIDE SWEEP';

    // Confidence bar
    const confW = d.confidence + '%';

    // Hot pool
    const hot = d.hotPool;
    const cascade = d.cascadePool;
    const hotSide = hot ? (hot.side === 'RESISTANCE' ? '▲' : '▼') : '';
    const hotColor = hot ? (hot.side === 'RESISTANCE' ? '#f23744' : '#13fed9') : '#98989D';

    panel.innerHTML =
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #2C2C2E; padding-bottom:10px;">' +
        '<div>' +
          '<span style="font-size:10px; color:#98989D; text-transform:uppercase; letter-spacing:.5px;">Next Sweep Prediction</span>' +
          '<div style="display:flex; align-items:baseline; gap:8px; margin-top:2px;">' +
            '<span style="font-size:20px; font-weight:800; color:' + dirColor + ';">' + dirArrow + ' ' + dirLabel + '</span>' +
            '<span style="font-size:11px; color:#98989D;">(' + d.confidence + '% confidence)</span>' +
          '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-size:10px; color:#98989D; margin-bottom:4px;">UP ' + d.upProb + '% / DOWN ' + d.downProb + '%</div>' +
          '<div style="height:6px; width:120px; background:#1E1E1E; border-radius:3px; overflow:hidden;">' +
            '<div style="height:100%; width:' + d.upProb + '%; background:linear-gradient(90deg,#13fed9,#f23744); border-radius:3px;"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">' +
        // Hot Pool
        '<div style="background:rgba(0,0,0,0.25); border:1px solid ' + hotColor + '33; border-radius:8px; padding:10px;">' +
          '<div style="font-size:9px; color:#98989D; text-transform:uppercase; margin-bottom:4px;">🔥 Hot Sweep Target</div>' +
          (hot ?
            '<div style="font-size:16px; font-weight:700; color:' + hotColor + '; font-family:\'JetBrains Mono\',monospace;">$' + hot.price.toLocaleString() + '</div>' +
            '<div style="font-size:11px; color:#98989D;">' + hotSide + ' ' + hot.side + ' • ' + hot.distPct + ' away</div>' +
            '<div style="font-size:10px; color:#555;">Vol: $' + hot.volume + 'M</div>'
          : '<div style="color:#555; font-size:12px;">No data</div>') +
        '</div>' +
        // Cascade Pool
        '<div style="background:rgba(0,0,0,0.25); border:1px solid #2C2C2E; border-radius:8px; padding:10px;">' +
          '<div style="font-size:9px; color:#98989D; text-transform:uppercase; margin-bottom:4px;">⚡ Cascade Pool (if swept)</div>' +
          (cascade ?
            '<div style="font-size:16px; font-weight:700; color:#FFD60A; font-family:\'JetBrains Mono\',monospace;">$' + cascade.price.toLocaleString() + '</div>' +
            '<div style="font-size:11px; color:#98989D;">' + cascade.side + ' • ' + cascade.distPct + ' away</div>' +
            '<div style="font-size:10px; color:#555;">Vol: $' + cascade.volume + 'M</div>'
          : '<div style="color:#555; font-size:12px;">No cascade data</div>') +
        '</div>' +
      '</div>' +

      // Nearest resistance + support
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">' +
        '<div style="font-size:11px; color:#98989D;">Nearest Resistance: <span style="color:#f23744; font-weight:600; font-family:\'JetBrains Mono\',monospace;">' +
          (d.nearestResistance ? '$' + d.nearestResistance.price.toLocaleString() + ' (' + d.nearestResistance.distPct + ')' : '--') + '</span></div>' +
        '<div style="font-size:11px; color:#98989D;">Nearest Support: <span style="color:#13fed9; font-weight:600; font-family:\'JetBrains Mono\',monospace;">' +
          (d.nearestSupport ? '$' + d.nearestSupport.price.toLocaleString() + ' (' + d.nearestSupport.distPct + ')' : '--') + '</span></div>' +
      '</div>' +

      // Reasons
      '<div style="border-top:1px solid #2C2C2E; padding-top:8px;">' +
        '<div style="font-size:9px; color:#98989D; text-transform:uppercase; margin-bottom:5px;">Signal Factors</div>' +
        '<div style="display:flex; flex-wrap:wrap; gap:5px;">' +
          (d.reasons || []).map(r =>
            '<span style="font-size:10px; background:rgba(255,255,255,0.05); border:1px solid #2C2C2E; border-radius:4px; padding:2px 7px; color:#ccc;">' + r + '</span>'
          ).join('') +
        '</div>' +
      '</div>' +
      '<div style="font-size:9px; color:#444; margin-top:6px; text-align:right;">Updated: ' + new Date(d.timestamp).toLocaleTimeString() + '</div>';

  } catch(e) {
    console.error('[SweepPredict] UI error:', e);
  }
}

// Auto-refresh every 3 min
loadSweepPrediction();
setInterval(loadSweepPrediction, 3 * 60 * 1000);


// ── Chart Tab Switching ───────────────────────────────────────────────────────
let activeTab = '24h';
let myChart3D = null;

function switchChartTab(tab) {
  activeTab = tab;
  const chart24 = document.getElementById('liq-heatmap-chart');
  const chart3d  = document.getElementById('liq-heatmap-chart-3d');
  const btn24 = document.getElementById('tab-24h');
  const btn3d  = document.getElementById('tab-3d');

  if (tab === '24h') {
    chart24.style.display = ''; chart3d.style.display = 'none';
    btn24.style.background = 'var(--accent-primary)'; btn24.style.color = '#0B0E11'; btn24.style.fontWeight = '700';
    btn3d.style.background = 'transparent'; btn3d.style.color = 'var(--text-muted)'; btn3d.style.fontWeight = '600';
  } else {
    chart24.style.display = 'none'; chart3d.style.display = '';
    btn3d.style.background = 'var(--accent-primary)'; btn3d.style.color = '#0B0E11'; btn3d.style.fontWeight = '700';
    btn24.style.background = 'transparent'; btn24.style.color = 'var(--text-muted)'; btn24.style.fontWeight = '600';
    if (myChart3D) myChart3D.resize();
  }
}

// ── 3D Heatmap + Tables + Sweep Prediction ────────────────────────────────────
async function load3DData() {
  try {
    const [heatRes, sweepRes] = await Promise.all([
      fetch('/api/heatmap-data-3d'),
      fetch('/api/sweep-prediction')
    ]);

    if (heatRes.ok) {
      const heatJson = await heatRes.json();
      const data3d = heatJson.data?.data || heatJson.data;
      if (data3d && data3d.series) {
        renderLiquidationTables3D(data3d);
        renderHeatmap3D(data3d);
      }
    } else if (heatRes.status === 503) {
      // 3D data not ready yet — silently wait
      console.log('[3D] Data not ready yet (503), will retry in 3 min');
    }

    if (sweepRes.ok) {
      const sweepJson = await sweepRes.json();
      const d3d = sweepJson.data3d;
      renderSweepPanel3D(d3d);
    }
  } catch (e) {
    console.error('[3D] Load error:', e);
  }
}

function renderLiquidationTables3D(data) {
  const aboveEl = document.getElementById('above-chart-container-3d');
  const belowEl = document.getElementById('below-chart-container-3d');
  if (!aboveEl || !belowEl || !data || !data.series) return;

  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candleSeries  = data.series.find(s => s.type === 'candlestick');
  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) return;

  let currentPrice = null;
  if (candleSeries && candleSeries.data && candleSeries.data.length > 0) {
    currentPrice = parseFloat(candleSeries.data[candleSeries.data.length - 1][1]);
  }
  if (!currentPrice) return;

  let maxHigh = currentPrice, minLow = currentPrice;
  if (candleSeries && candleSeries.data) {
    candleSeries.data.forEach(c => {
      const h = parseFloat(c[3]), l = parseFloat(c[2]);
      if (!isNaN(h) && h > maxHigh) maxHigh = h;
      if (!isNaN(l) && l < minLow) minLow = l;
    });
  }

  const yAxisData = data.yAxis || [];
  const leveragePerY = {};
  heatmapSeries.data.forEach(item => {
    const yIdx = item[1], val = parseFloat(item[2] || 0);
    leveragePerY[yIdx] = (leveragePerY[yIdx] || 0) + val;
  });

  const levels = [];
  Object.keys(leveragePerY).forEach(yIdxStr => {
    const yIdx = parseInt(yIdxStr, 10);
    const priceStr = yAxisData[yIdx];
    if (!priceStr) return;
    const price = parseFloat(priceStr);
    const leverage = leveragePerY[yIdx];
    const distPct = ((price - currentPrice) / currentPrice) * 100;
    const isAbove = price > currentPrice;
    const isLiquidated = isAbove ? (price <= maxHigh) : (price >= minLow);
    levels.push({ price, leverage, distance: distPct, isAbove, isLiquidated });
  });

  const aboveLevels = levels.filter(l => l.isAbove).sort((a,b) => b.leverage - a.leverage).slice(0,5).sort((a,b) => a.price - b.price);
  const belowLevels = levels.filter(l => !l.isAbove).sort((a,b) => b.leverage - a.leverage).slice(0,5).sort((a,b) => b.price - a.price);
  const maxLev = Math.max(...levels.map(l => l.leverage), 1);

  const buildTable = (pools, isAbove) => {
    if (!pools.length) return '<div style="color:#555;font-size:12px;padding:12px;text-align:center;">No pools</div>';
    const side = isAbove ? 'above' : 'below';
    const total = pools.reduce((s,p) => s + (p.isLiquidated ? 0 : p.leverage), 0);
    let h = '<div class="liq-table-container ' + side + '"><h4>' +
      (isAbove ? '▲ Resistance 3D' : '▼ Support 3D') + ' | Active: $' + formatIntensity(total) + '</h4>' +
      '<table class="liq-data-table"><thead><tr>' +
      '<th>Rank</th><th>Price (USD)</th><th>Pool Vol</th><th>Dist</th><th>Intensity</th>' +
      '</tr></thead><tbody>';

    pools.forEach((lvl, idx) => {
      const ratio = lvl.leverage / maxLev;
      let bc = 'low', bl = 'Low';
      if (lvl.isLiquidated) { bc = 'liquidated'; bl = 'Liquidated'; }
      else if (ratio >= 0.7) { bc = 'high'; bl = 'High'; }
      else if (ratio >= 0.3) { bc = 'medium'; bl = 'Medium'; }

      const ds = lvl.distance > 0 ? '+' : '';
      const pc = lvl.isLiquidated ? 'var(--text-muted)' : '#FFFFFF';
      const vc = lvl.isLiquidated ? 'var(--text-muted)' : (isAbove ? '#F0B90B' : '#0ECB81');
      const dc = lvl.isLiquidated ? 'var(--text-muted)' : (isAbove ? '#F6465D' : '#0ECB81');
      const rowStyle = lvl.isLiquidated ? ' style="opacity:0.45;"' : '';
      const qb = lvl.isLiquidated ? '' :
        '<span class="quick-set-btn entry-set" onclick="setPlannerPrice(\'entry\',' + lvl.price + ')">E</span>' +
        '<span class="quick-set-btn tp-set" onclick="setPlannerPrice(\'tp\',' + lvl.price + ')">TP</span>';

      h += '<tr' + rowStyle + '>' +
        '<td style="color:var(--text-muted)">#' + (idx+1) + '</td>' +
        '<td class="mono" style="color:' + pc + '">$' + lvl.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + qb + '</td>' +
        '<td class="mono" style="color:' + vc + '">$' + formatIntensity(lvl.leverage) + '</td>' +
        '<td class="mono" style="color:' + dc + '">' + ds + lvl.distance.toFixed(2) + '%</td>' +
        '<td><span class="intensity-badge ' + bc + '">' + bl + '</span></td>' +
        '</tr>';
    });

    h += '</tbody></table></div>';
    return h;
  };

  aboveEl.innerHTML = buildTable(aboveLevels, true);
  belowEl.innerHTML  = buildTable(belowLevels, false);
}

function renderHeatmap3D(data) {
  const chartDom = document.getElementById('liq-heatmap-chart-3d');
  if (!chartDom) return;
  if (myChart3D) myChart3D.dispose();
  myChart3D = echarts.init(chartDom, 'dark', { renderer: 'canvas' });

  // Same rendering logic as 24H but on 3D data
  const xAxisData = data.xAxis || [];
  const yAxisData = data.yAxis || [];
  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candleSeries  = data.series.find(s => s.type === 'candlestick');
  const minPrice = yAxisData.length > 0 ? parseFloat(yAxisData[0]) : null;
  const maxPrice = yAxisData.length > 0 ? parseFloat(yAxisData[yAxisData.length-1]) : null;
  const maxIntensity = data.visualMap ? data.visualMap.max : 20000000;

  myChart3D.setOption({
    backgroundColor: '#010409',
    axisPointer: { show: true, type: 'cross', lineStyle: { color: '#F0B90B', width: 1, type: 'dashed' } },
    grid: { top: '5%', bottom: '10%', left: '8%', right: '4%', show: true, backgroundColor: '#0a0e17', borderColor: 'transparent' },
    tooltip: {
      trigger: 'item',
      alwaysShowContent: false,
      hideDelay: 0,
      transitionDuration: 0,
      backgroundColor: '#121212',
      borderColor: '#2C2C2E',
      borderWidth: 1,
      textStyle: { color: '#FFFFFF', fontFamily: 'Inter' },
      formatter: function (params) {
        if (!params || !params.value) return '';

        if (params.seriesName === 'Liq 3D') {
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

        if (params.seriesName === 'Candles 3D') {
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
    xAxis: {
      type: 'category', data: xAxisData, boundaryGap: true,
      splitLine: { show: true, lineStyle: { color: '#1a2030' } },
      axisLine: { lineStyle: { color: '#1a2030' } },
      axisLabel: { color: '#848E9C', fontSize: 10, formatter: v => (v || '').split(', ')[1] || v }
    },
    yAxis: [
      { type: 'category', data: yAxisData, splitLine: { show: true, lineStyle: { color: '#1a2030' } },
        axisLine: { lineStyle: { color: '#1a2030' } },
        axisLabel: { color: '#848E9C', fontSize: 10, formatter: v => '$' + parseInt(v).toLocaleString() } },
      { type: 'value', scale: true, min: minPrice, max: maxPrice, show: false }
    ],
    visualMap: {
      show: true, min: 0, max: maxIntensity, calculable: true, orient: 'horizontal', left: 'center', bottom: '2%',
      itemWidth: 15, itemHeight: 250,
      textStyle: { color: '#848E9C', fontSize: 11 },
      inRange: { color: ['#0a0e17','#373d77','#28738f','#238c89','#24a480','#3ab56e','#66c751','#F0B90B'] }
    },
    series: [
      { name: 'Liq 3D', type: 'heatmap', data: heatmapSeries ? heatmapSeries.data : [],
        label: { show: false }, emphasis: { itemStyle: { shadowBlur: 10 } } },
      { name: 'Candles 3D', type: 'candlestick', yAxisIndex: 1,
        data: candleSeries ? candleSeries.data.map(c => [parseFloat(c[0]),parseFloat(c[1]),parseFloat(c[2]),parseFloat(c[3])]) : [],
        itemStyle: { color: '#0ECB81', color0: '#F6465D', borderColor: '#0ECB81', borderColor0: '#F6465D' } }
    ]
  });

  // Hide tooltip when mouse leaves the chart container
  myChart3D.on('globalout', () => {
    myChart3D.dispatchAction({ type: 'hideTip' });
    myChart3D.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' });
    myChart3D.dispatchAction({ type: 'downplay' });
    myChart3D.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: -1 });
  });

  window.addEventListener('resize', () => myChart3D && myChart3D.resize());
}

function renderSweepPanel3D(d) {
  const panel = document.getElementById('sweep-prediction-panel-3d');
  if (!panel) return;
  if (!d) {
    panel.innerHTML = '<div style="color:#848E9C;font-size:12px;text-align:center;padding:12px;">3D prediction loading...</div>';
    return;
  }

  try {
    const isUp = d.direction === 'UP';
    const dirColor = isUp ? '#0ECB81' : '#F6465D';
    const dirArrow = isUp ? '▲' : '▼';
    const dirLabel = isUp ? 'UPSIDE SWEEP' : 'DOWNSIDE SWEEP';

    // Hot pool
    const hot = d.hotPool;
    const cascade = d.cascadePool;
    const hotSide = hot ? (hot.side === 'RESISTANCE' ? '▲' : '▼') : '';
    const hotColor = hot ? (hot.side === 'RESISTANCE' ? '#F6465D' : '#0ECB81') : '#848E9C';

    panel.innerHTML =
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #2B3139; padding-bottom:10px;">' +
        '<div>' +
          '<span style="font-size:10px; color:#848E9C; text-transform:uppercase; letter-spacing:.5px;">3D Sweep Prediction</span>' +
          '<div style="display:flex; align-items:baseline; gap:8px; margin-top:2px;">' +
            '<span style="font-size:20px; font-weight:800; color:' + dirColor + ';">' + dirArrow + ' ' + dirLabel + '</span>' +
            '<span style="font-size:11px; color:#848E9C;">(' + d.confidence + '% confidence)</span>' +
          '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-size:10px; color:#848E9C; margin-bottom:4px;">UP ' + d.upProb + '% / DOWN ' + d.downProb + '%</div>' +
          '<div style="height:6px; width:120px; background:var(--bg-card-hover); border-radius:3px; overflow:hidden;">' +
            '<div style="height:100%; width:' + d.upProb + '%; background:linear-gradient(90deg,' + (isUp ? '#0ECB81' : '#F6465D') + ',' + (isUp ? '#F6465D' : '#0ECB81') + '); border-radius:3px;"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">' +
        // Hot Pool
        '<div style="background:rgba(0,0,0,0.2); border:1px solid ' + hotColor + '33; border-radius:8px; padding:10px;">' +
          '<div style="font-size:9px; color:#848E9C; text-transform:uppercase; margin-bottom:4px;">🔥 Hot Sweep Target (3D)</div>' +
          (hot ?
            '<div style="font-size:16px; font-weight:700; color:' + hotColor + '; font-family:\'JetBrains Mono\',monospace;">$' + hot.price.toLocaleString() + '</div>' +
            '<div style="font-size:11px; color:#848E9C;">' + hotSide + ' ' + hot.side + ' • ' + hot.distPct + ' away</div>' +
            '<div style="font-size:10px; color:#555;">Vol: $' + hot.volume + 'M</div>'
          : '<div style="color:#555; font-size:12px;">No data</div>') +
        '</div>' +
        // Cascade Pool
        '<div style="background:rgba(0,0,0,0.2); border:1px solid #2B3139; border-radius:8px; padding:10px;">' +
          '<div style="font-size:9px; color:#848E9C; text-transform:uppercase; margin-bottom:4px;">⚡ Cascade Pool (if swept)</div>' +
          (cascade ?
            '<div style="font-size:16px; font-weight:700; color:#F0B90B; font-family:\'JetBrains Mono\',monospace;">$' + cascade.price.toLocaleString() + '</div>' +
            '<div style="font-size:11px; color:#848E9C;">' + cascade.side + ' • ' + cascade.distPct + ' away</div>' +
            '<div style="font-size:10px; color:#555;">Vol: $' + cascade.volume + 'M</div>'
          : '<div style="color:#555; font-size:12px;">No cascade data</div>') +
        '</div>' +
      '</div>' +

      // Nearest resistance + support
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">' +
        '<div style="font-size:11px; color:#848E9C;">Nearest Resistance: <span style="color:#F6465D; font-weight:600; font-family:\'JetBrains Mono\',monospace;">' +
          (d.nearestResistance ? '$' + d.nearestResistance.price.toLocaleString() + ' (' + d.nearestResistance.distPct + ')' : '--') + '</span></div>' +
        '<div style="font-size:11px; color:#848E9C;">Nearest Support: <span style="color:#0ECB81; font-weight:600; font-family:\'JetBrains Mono\',monospace;">' +
          (d.nearestSupport ? '$' + d.nearestSupport.price.toLocaleString() + ' (' + d.nearestSupport.distPct + ')' : '--') + '</span></div>' +
      '</div>' +

      // Reasons
      '<div style="border-top:1px solid #2B3139; padding-top:8px;">' +
        '<div style="font-size:9px; color:#848E9C; text-transform:uppercase; margin-bottom:5px;">Signal Factors (3D)</div>' +
        '<div style="display:flex; flex-wrap:wrap; gap:5px;">' +
          (d.reasons || []).map(r =>
            '<span style="font-size:10px; background:rgba(255,255,255,0.05); border:1px solid #2B3139; border-radius:4px; padding:2px 7px; color:#ccc;">' + r + '</span>'
          ).join('') +
        '</div>' +
      '</div>' +
      '<div style="font-size:9px; color:#555; margin-top:6px; text-align:right;">Updated: ' + new Date(d.timestamp).toLocaleTimeString() + '</div>';

  } catch(e) {
    console.error('[SweepPredict3D] UI error:', e);
  }
}

// Load 3D data on start and every 10 min (3D data changes slowly)
load3DData();
setInterval(load3DData, 10 * 60 * 1000);

// Helper function to force hide tooltip and axisPointer for an ECharts instance
const forceHideEchartsTooltip = (chart) => {
  if (!chart) return;
  chart.dispatchAction({ type: 'hideTip' });
  chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' });
  chart.dispatchAction({ type: 'downplay' });
  chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: -1 });
};

// Global mouse move tracker to force hide ECharts tooltips when mouse leaves the chart grid area
document.addEventListener('mousemove', (e) => {
  const checkAndHide = (chart, elementId) => {
    if (!chart) return;
    const el = document.getElementById(elementId);
    if (!el || el.style.display === 'none') return;
    
    // If hovering over the tooltip itself, keep it visible
    if (e.target && (e.target.closest('.echarts-tooltip') || e.target.classList.contains('echarts-tooltip'))) {
      return;
    }
    
    const rect = el.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const relativeY = e.clientY - rect.top;
    
    // Grid margins: top 5%, bottom 10% (height 90%), left 8%, right 4% (width 96%)
    // We add a tiny buffer (top 4.5%, bottom 10.5%, left 7.5%, right 4.5%) to allow smooth scrolling
    const minX = rect.width * 0.075;
    const maxX = rect.width * 0.955;
    const minY = rect.height * 0.045;
    const maxY = rect.height * 0.895;
    
    const isInsideGrid = (
      relativeX >= minX &&
      relativeX <= maxX &&
      relativeY >= minY &&
      relativeY <= maxY
    );
    
    if (!isInsideGrid) {
      forceHideEchartsTooltip(chart);
    }
  };
  
  checkAndHide(myChart, 'liq-heatmap-chart');
  checkAndHide(myChart3D, 'liq-heatmap-chart-3d');
});

// One-time global mouseout listener to handle when mouse leaves the browser viewport completely
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget || e.relatedTarget.nodeName === "HTML") {
    forceHideEchartsTooltip(myChart);
    forceHideEchartsTooltip(myChart3D);
  }
});
