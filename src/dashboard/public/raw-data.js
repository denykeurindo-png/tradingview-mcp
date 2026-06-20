const EXCHANGE_RATE = 6.96; // 1 USD = 6.96 Bolivianos (Bs.)

// DOM Elements
const statusIndicator = document.getElementById('connection-status');
const btnRefresh = document.getElementById('btn-refresh');

const valBtcPrice = document.getElementById('val-btc-price');
const footBtcPrice = document.getElementById('foot-btc-price');

const valOiVal = document.getElementById('val-oi-val');
const footOiChange = document.getElementById('foot-oi-change');

const valSpotCvd = document.getElementById('val-spot-cvd');
const footSpotCvdStatus = document.getElementById('foot-spot-cvd-status');

const valHtfTrend = document.getElementById('val-htf-trend');
const footHtfTrend = document.getElementById('foot-htf-trend');

const valFundingRate = document.getElementById('val-funding-rate');
const footFundingStatus = document.getElementById('foot-funding-status');

const valLsRatio = document.getElementById('val-ls-ratio');
const footLsPercentage = document.getElementById('foot-ls-percentage');

const liqPoolsTbody = document.getElementById('liq-pools-tbody');
const rawJsonBlock = document.getElementById('raw-json-block');
const btnCopyJson = document.getElementById('btn-copy-json');

const btnTabBot = document.getElementById('btn-tab-bot');
const btnTabHeatmap = document.getElementById('btn-tab-heatmap');

let currentActiveTab = 'bot'; // 'bot' or 'heatmap'
let cachedBotStatus = null;
let cachedHeatmapData = null;

// Formatter Helpers
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

function updateStatus(state, message) {
  statusIndicator.className = `status-indicator ${state}`;
  statusIndicator.querySelector('.status-text').innerText = message;
}

// Fetch Bot Status
async function loadBotStatus() {
  try {
    const res = await fetch('/api/bot-status');
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const resObj = await res.json();
    cachedBotStatus = resObj.data;
    
    // Update KPI panels
    if (cachedBotStatus.metrics) {
      const m = cachedBotStatus.metrics;
      valOiVal.innerText = formatUSD(m.openInterest || 0);
      
      const oiChange = m.oiChange1h || 0;
      const oiChangeText = `${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(2)}%`;
      footOiChange.innerText = `${oiChangeText} (1h Change)`;
      footOiChange.className = `kpi-footer ${oiChange >= 0 ? 'text-positive' : 'text-negative'}`;
      
      valSpotCvd.innerText = formatUSD(m.spotCvd1h || 0);
      const cvdPositive = (m.spotCvd1h || 0) >= 0;
      valSpotCvd.className = `kpi-value select-mono ${cvdPositive ? 'text-positive' : 'text-negative'}`;
      footSpotCvdStatus.innerText = cvdPositive ? 'Net Spot Accumulation (1h)' : 'Net Spot Distribution (1h)';
      footSpotCvdStatus.className = `kpi-footer ${cvdPositive ? 'text-positive' : 'text-negative'}`;
      
      const trend1h = m.trend1h || 'UNKNOWN';
      const trend4h = m.trend4h || 'UNKNOWN';
      valHtfTrend.innerText = `${trend1h} / ${trend4h}`;
      
      let trendClass = 'text-neutral';
      if (trend1h === 'BULLISH' && trend4h === 'BULLISH') trendClass = 'text-positive';
      if (trend1h === 'BEARISH' && trend4h === 'BEARISH') trendClass = 'text-negative';
      valHtfTrend.className = `kpi-value select-mono ${trendClass}`;

      // Update Funding Rate
      const fundRate = m.fundingRate || 0;
      valFundingRate.innerText = `${(fundRate * 100).toFixed(4)}%`;
      const fundingPositive = fundRate >= 0;
      valFundingRate.className = `kpi-value select-mono ${fundingPositive ? 'text-positive' : 'text-negative'}`;
      footFundingStatus.innerText = fundingPositive ? 'Longs pay Shorts' : 'Shorts pay Longs';
      footFundingStatus.className = `kpi-footer ${fundingPositive ? 'text-positive' : 'text-negative'}`;

      // Update Long/Short Ratio
      const lsRatio = m.longShortRatio || 1.0;
      valLsRatio.innerText = lsRatio.toFixed(2);
      const longPct = (m.longAccount || 0.5) * 100;
      const shortPct = (m.shortAccount || 0.5) * 100;
      footLsPercentage.innerText = `${longPct.toFixed(1)}% Long / ${shortPct.toFixed(1)}% Short`;
    }
    
    updateJsonView();
  } catch (err) {
    console.error('Error fetching bot status:', err.message);
  }
}

// Fetch Heatmap Data
async function loadHeatmapData(forceRefresh = false) {
  try {
    updateStatus('loading', forceRefresh ? 'Scraping...' : 'Updating...');
    btnRefresh.disabled = true;
    
    const url = `/api/heatmap-data${forceRefresh ? '?refresh=true' : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const resObj = await response.json();
    cachedHeatmapData = resObj.data;
    
    // Extract BTC Price from heatmap data
    const candlestickSeries = cachedHeatmapData.data.series.find(s => s.type === 'candlestick');
    if (candlestickSeries && candlestickSeries.data && candlestickSeries.data.length > 0) {
      const lastCandle = candlestickSeries.data[candlestickSeries.data.length - 1];
      const currentPrice = parseFloat(lastCandle[1]);
      if (!isNaN(currentPrice)) {
        valBtcPrice.innerText = formatUSD(currentPrice);
        footBtcPrice.innerText = formatBs(currentPrice) + ' (Equiv.)';
        
        // Parse pools and build table
        renderLiquidationTable(cachedHeatmapData.data, currentPrice);
      }
    }
    
    updateJsonView();
    updateStatus('normal', 'Live');
  } catch (err) {
    updateStatus('error', err.message || 'Connection offline');
  } finally {
    btnRefresh.disabled = false;
  }
}

// Render Liquidation Table
function renderLiquidationTable(data, currentPrice) {
  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candlestickSeries = data.series.find(s => s.type === 'candlestick');
  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) return;
  
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
  
  // Sort and pick top 10 pools (5 above, 5 below)
  const aboveLevels = levels.filter(l => l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5);
  const belowLevels = levels.filter(l => !l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5);
  
  const allPools = [...aboveLevels, ...belowLevels].sort((a, b) => b.leverage - a.leverage);
  
  if (allPools.length === 0) {
    liqPoolsTbody.innerHTML = `<tr><td colspan="5" class="text-muted" style="text-align: center;">No active liquidation pools found.</td></tr>`;
    return;
  }
  
  let html = '';
  allPools.forEach(pool => {
    const rowStyle = pool.isLiquidated ? 'style="opacity: 0.45; text-decoration: line-through;"' : '';
    const poolType = pool.isAbove 
      ? '<span class="intensity-badge high" style="background:#bfdc21; color:#000; font-weight:600;">RESISTANCE</span>' 
      : '<span class="intensity-badge medium" style="background:#3ab56e; color:#fff; font-weight:600;">SUPPORT</span>';
    
    const distanceSign = pool.distance > 0 ? '+' : '';
    const distanceColor = pool.isLiquidated ? 'var(--text-muted)' : (pool.isAbove ? 'var(--accent-alert)' : 'var(--accent-success)');
    const volumeColor = pool.isLiquidated ? 'var(--text-muted)' : (pool.isAbove ? '#bfdc21' : '#3ab56e');
    
    html += `<tr ${rowStyle}>`;
    html += `<td>${poolType}</td>`;
    html += `<td class="mono" style="font-weight: 600;">$${pool.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>`;
    html += `<td class="mono" style="color: ${distanceColor}">${distanceSign}${pool.distance.toFixed(2)}%</td>`;
    html += `<td class="mono" style="font-weight: 600; color: ${volumeColor}">$${formatUSD(pool.leverage)}</td>`;
    html += `<td class="mono" style="color: var(--text-muted)">Bs. ${formatUSD(pool.leverage * EXCHANGE_RATE)}</td>`;
    html += `</tr>`;
  });
  
  liqPoolsTbody.innerHTML = html;
}

// Update JSON View Panel
function updateJsonView() {
  if (currentActiveTab === 'bot') {
    rawJsonBlock.innerText = cachedBotStatus ? JSON.stringify(cachedBotStatus, null, 2) : 'Loading bot status JSON...';
  } else {
    rawJsonBlock.innerText = cachedHeatmapData ? JSON.stringify(cachedHeatmapData, null, 2) : 'Loading heatmap data JSON...';
  }
}

// Event Listeners for tabs
btnTabBot.addEventListener('click', () => {
  currentActiveTab = 'bot';
  btnTabBot.classList.add('active');
  btnTabHeatmap.classList.remove('active');
  updateJsonView();
});

btnTabHeatmap.addEventListener('click', () => {
  currentActiveTab = 'heatmap';
  btnTabHeatmap.classList.add('active');
  btnTabBot.classList.remove('active');
  updateJsonView();
});

// Copy JSON to Clipboard
btnCopyJson.addEventListener('click', () => {
  navigator.clipboard.writeText(rawJsonBlock.innerText)
    .then(() => {
      btnCopyJson.innerText = 'Copied!';
      setTimeout(() => { btnCopyJson.innerText = 'Copy JSON'; }, 2000);
    })
    .catch(err => {
      console.error('Failed to copy JSON:', err);
    });
});

// Sync Now button
btnRefresh.addEventListener('click', () => {
  loadBotStatus();
  loadHeatmapData(true);
});

// Initial load
loadBotStatus();
loadHeatmapData(false);

// Auto refresh sync every 15 seconds for raw data tab
setInterval(() => {
  loadBotStatus();
  loadHeatmapData(false);
}, 15000);
