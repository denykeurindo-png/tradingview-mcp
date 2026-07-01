// JDA Trade Monitor — CoinGlass Liquidation HeatMap Logic (Simplified Backtest Grid)
const EXCHANGE_RATE = 16300; // 1 USD = 16300 IDR (Rp)

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
let currentCoinGlobal = 'BTC';
let autoTradeEnabled = true;
let refreshIntervalId = null;
let cacheCheckIntervalId = null;
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

const formatIDR = (valUsd) => {
  if (valUsd === 0 || valUsd === undefined || valUsd === null) return 'Rp 0';
  const valBs = valUsd * EXCHANGE_RATE;
  const isNeg = valBs < 0;
  const abs = Math.abs(valBs);
  let f = '';
  if (abs >= 1e9) f = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) f = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) f = (abs / 1e3).toFixed(2) + 'K';
  else f = abs.toFixed(2);
  return `${isNeg ? '-' : ''}Rp ${f}`;
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

    valBtcPrice.innerText = formatUSD(currentPrice);
    footBtcPrice.innerText = `${formatIDR(currentPrice)} (Equiv.)`;
    timeBtcPrice.innerText = `Last update: ${updateTime}`;

    const highs = candlestickSeries.data.map(c => parseFloat(c[3]));
    const lows = candlestickSeries.data.map(c => parseFloat(c[2]));
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);

    val24hHigh.innerText = formatUSD(maxHigh);
    foot24hHigh.innerText = `${formatIDR(maxHigh)} (Equiv.)`;
    time24hHigh.innerText = `Last update: ${updateTime}`;

    val24hLow.innerText = formatUSD(minLow);
    foot24hLow.innerText = `${formatIDR(minLow)} (Equiv.)`;
    time24hLow.innerText = `Last update: ${updateTime}`;
  }

  if (heatmapSeries && heatmapSeries.data && heatmapSeries.data.length > 0) {
    // Sum only the latest time bin — summing every [x,y,value] cell across all 288
    // x-axis bins double/triple-counts the same persistent price levels and inflates
    // this into the tens of billions.
    const latestXIdx = (data.xAxis ? data.xAxis.length : 0) - 1;
    let totalLiq = 0;
    heatmapSeries.data.forEach(item => {
      const xIdx = parseInt(item[0], 10);
      if (xIdx === latestXIdx && item[2]) totalLiq += parseFloat(item[2]);
    });

    valLiqVol.innerText = formatUSD(totalLiq);
    footLiqVol.innerText = `${formatIDR(totalLiq)} (Equiv.)`;
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
  const xAxisLength = data.xAxis ? data.xAxis.length : 0;
  const latestXIdx = xAxisLength - 1;
  const startXIdx = Math.max(0, latestXIdx - 40);

  const leverageLatest = {};
  const leverageMaxRecent = {};
  
  yAxisData.forEach((_, idx) => {
    leverageLatest[idx] = 0;
    leverageMaxRecent[idx] = 0;
  });

  heatmapSeries.data.forEach(item => {
    const xIdx = item[0];
    const yIdx = item[1];
    const val = parseFloat(item[2] || 0);
    if (xIdx === latestXIdx) {
      leverageLatest[yIdx] = val;
    }
    if (xIdx >= startXIdx && xIdx <= latestXIdx) {
      if (val > leverageMaxRecent[yIdx]) {
        leverageMaxRecent[yIdx] = val;
      }
    }
  });

  // Calculate recent min/max price bounds from the last 40 candles (matching visible chart)
  let maxHighRecent = currentPrice;
  let minLowRecent = currentPrice;
  if (candlestickSeries && candlestickSeries.data) {
    const recentCandles = candlestickSeries.data.slice(-40);
    recentCandles.forEach(c => {
      const low = parseFloat(c[2]), high = parseFloat(c[3]);
      if (!isNaN(high) && high > maxHighRecent) maxHighRecent = high;
      if (!isNaN(low) && low < minLowRecent) minLowRecent = low;
    });
  }

  const levels = [];
  Object.keys(leverageLatest).forEach(yIdxStr => {
    const yIdx = parseInt(yIdxStr, 10);
    const priceStr = yAxisData[yIdx];
    if (!priceStr) return;
    const price = parseFloat(priceStr);
    const latestVal = leverageLatest[yIdx];
    const maxRecentVal = leverageMaxRecent[yIdx];
    const isAbove = price > currentPrice;

    // Check if price crossed this level recently
    let isLiquidated = false;
    if (isAbove) {
      if (price <= maxHighRecent) {
        isLiquidated = true;
      }
    } else {
      if (price >= minLowRecent) {
        isLiquidated = true;
      }
    }

    // Keep displaying the pool if it has active leverage OR if it was liquidated recently (using historical max value)
    let leverage = latestVal;
    if (isLiquidated && maxRecentVal > 0) {
      leverage = maxRecentVal;
    }

    if (leverage <= 0) return;

    const distancePercent = ((price - currentPrice) / currentPrice) * 100;
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
      type: 'line',
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
        type: 'value', scale: true, min: minPrice, max: maxPrice, show: false,
        axisPointer: { show: false }
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
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'filter' }
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

// ─── Quick Set Price — opens trades.html with pre-filled params ──
window.setPlannerPrice = (type, price) => {
  window.location.href = 'trades.html?' + type + '=' + parseFloat(price).toFixed(2);
};

// ─── Refresh Button ─────────────────────────────────────────
btnRefresh.addEventListener('click', () => loadHeatmapData(true));

// ─── Adaptive Auto-Refresh (Power Saving) ───────────────────
function setupAutoRefresh() {
  // Clear existing intervals
  if (refreshIntervalId)    { clearInterval(refreshIntervalId);    refreshIntervalId    = null; }
  if (cacheCheckIntervalId) { clearInterval(cacheCheckIntervalId); cacheCheckIntervalId = null; }

  const isHidden = document.hidden;

  if (isHidden && !autoTradeEnabled) {
    console.log('[Power Saving] Tab hidden and bot inactive. Auto-refresh paused.');
    return;
  }

  // ① Cache-check every 30s: lightweight poll — detects when background bot updates cache
  //    Uses forceRefresh=false so server returns immediately from memory cache (no new scrape)
  //    Only re-renders if timestamp changed (isNewData = true)
  cacheCheckIntervalId = setInterval(() => {
    if (!document.hidden) loadHeatmapData(false);
  }, 30000);

  // ② Force-scrape interval: triggers a real CoinGlass scrape every 3 min (active) or 15 min (idle)
  const scrapeMs = autoTradeEnabled ? 180000 : 900000;
  console.log(`[AutoRefresh] Cache-check: 30s | Force-scrape: ${scrapeMs / 1000}s`);
  refreshIntervalId = setInterval(() => {
    loadHeatmapData(true);
  }, scrapeMs);
}

// ─── Initialization ─────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  loadHeatmapData(false);
  setupAutoRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(() => { if (!document.hidden) loadHeatmapData(true); }, 2000);
    }
    setupAutoRefresh();
  });
});


// ── Sweep Prediction Panel ────────────────────────────────────────────────────
function renderSweepPanel(d) {
  const panel = document.getElementById('sweep-prediction-panel');
  if (!panel) return;
  if (!d) {
    panel.innerHTML = '<div style="color:#98989D; font-size:12px; text-align:center; padding:12px;">Loading sweep prediction...</div>';
    return;
  }

  try {
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

async function loadSweepPrediction() {
  try {
    const res = await fetch('/api/sweep-prediction');
    if (!res.ok) return;
    const json = await res.json();
    
    // Update 24H Panel
    renderSweepPanel(json.data);

    // Update 3D Panel
    renderSweepPanel3D(json.data3d);
  } catch (e) {
    console.error('[SweepPredict] Fetch error:', e);
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
    if (myChart) myChart.resize();
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
    const heatRes = await fetch('/api/heatmap-data-3d');

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
  const xAxisLength = data.xAxis ? data.xAxis.length : 0;
  const latestXIdx = xAxisLength - 1;
  const startXIdx = Math.max(0, latestXIdx - 40);

  const leverageLatest = {};
  const leverageMaxRecent = {};
  
  yAxisData.forEach((_, idx) => {
    leverageLatest[idx] = 0;
    leverageMaxRecent[idx] = 0;
  });

  heatmapSeries.data.forEach(item => {
    const xIdx = item[0];
    const yIdx = item[1];
    const val = parseFloat(item[2] || 0);
    if (xIdx === latestXIdx) {
      leverageLatest[yIdx] = val;
    }
    if (xIdx >= startXIdx && xIdx <= latestXIdx) {
      if (val > leverageMaxRecent[yIdx]) {
        leverageMaxRecent[yIdx] = val;
      }
    }
  });

  // Calculate recent min/max price bounds from the last 40 candles (matching visible chart)
  let maxHighRecent = currentPrice;
  let minLowRecent = currentPrice;
  if (candleSeries && candleSeries.data) {
    const recentCandles = candleSeries.data.slice(-40);
    recentCandles.forEach(c => {
      const low = parseFloat(c[2]), high = parseFloat(c[3]);
      if (!isNaN(high) && high > maxHighRecent) maxHighRecent = high;
      if (!isNaN(low) && low < minLowRecent) minLowRecent = low;
    });
  }

  const levels = [];
  Object.keys(leverageLatest).forEach(yIdxStr => {
    const yIdx = parseInt(yIdxStr, 10);
    const priceStr = yAxisData[yIdx];
    if (!priceStr) return;
    const price = parseFloat(priceStr);
    const latestVal = leverageLatest[yIdx];
    const maxRecentVal = leverageMaxRecent[yIdx];
    const isAbove = price > currentPrice;

    // Check if price crossed this level recently
    let isLiquidated = false;
    if (isAbove) {
      if (price <= maxHighRecent) {
        isLiquidated = true;
      }
    } else {
      if (price >= minLowRecent) {
        isLiquidated = true;
      }
    }

    // Keep displaying the pool if it has active leverage OR if it was liquidated recently (using historical max value)
    let leverage = latestVal;
    if (isLiquidated && maxRecentVal > 0) {
      leverage = maxRecentVal;
    }

    if (leverage <= 0) return;

    const distPct = ((price - currentPrice) / currentPrice) * 100;
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
    axisPointer: { show: true, type: 'line', lineStyle: { color: '#F0B90B', width: 1, type: 'dashed' } },
    grid: { top: '5%', bottom: '10%', left: '8%', right: '4%', show: true, backgroundColor: '#46035c', borderColor: 'transparent' },
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
      splitLine: { show: true, lineStyle: { color: '#31235a' } },
      axisLine: { lineStyle: { color: '#31235a' } },
      axisLabel: { color: '#848E9C', fontSize: 10, formatter: v => (v || '').split(', ')[1] || v }
    },
    yAxis: [
      { type: 'category', data: yAxisData, splitLine: { show: true, lineStyle: { color: '#31235a' } },
        axisLine: { lineStyle: { color: '#31235a' } },
        axisLabel: { color: '#848E9C', fontSize: 10, formatter: v => '$' + parseInt(v).toLocaleString() } },
      { type: 'value', scale: true, min: minPrice, max: maxPrice, show: false, axisPointer: { show: false } }
    ],
    visualMap: {
      show: true, min: 0, max: maxIntensity, calculable: true, orient: 'horizontal', left: 'center', bottom: '2%',
      itemWidth: 15, itemHeight: 250,
      textStyle: { color: '#848E9C', fontSize: 11 },
      inRange: { color: ['#46035c','#373d77','#28738f','#238c89','#24a480','#3ab56e','#66c751','#F0B90B'] }
    },
    series: [
      { name: 'Liq 3D', type: 'heatmap', data: heatmapSeries ? heatmapSeries.data : [],
        label: { show: false }, emphasis: { itemStyle: { shadowBlur: 10 } } },
      { name: 'Candles 3D', type: 'candlestick', yAxisIndex: 1,
        data: candleSeries ? candleSeries.data.map(c => [parseFloat(c[0]),parseFloat(c[1]),parseFloat(c[2]),parseFloat(c[3])]) : [],
        itemStyle: { color: '#0ECB81', color0: '#F6465D', borderColor: '#0ECB81', borderColor0: '#F6465D' } }
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'filter' }
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
