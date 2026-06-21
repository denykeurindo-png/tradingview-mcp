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
    updateStatus('loading', 'Updating...');
    btnRefresh.disabled = true;
    
    const res = await fetch('/api/bot-status');
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const resObj = await res.json();
    cachedBotStatus = resObj.data;

    // Set BTC price directly from bot status response (Binance API source)
    if (resObj.btcPrice) {
      valBtcPrice.innerText = formatUSD(resObj.btcPrice);
      footBtcPrice.innerText = formatBs(resObj.btcPrice) + ' (Equiv.)';
    }
    
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
      footSpotCvdStatus.innerText = cvdPositive ? 'Net Futures Accumulation (1h)' : 'Net Futures Distribution (1h)';
      footSpotCvdStatus.className = `kpi-footer ${cvdPositive ? 'text-positive' : 'text-negative'}`;
      
      const trend1h = m.trend1h || 'UNKNOWN';
      const trend4h = m.trend4h || 'UNKNOWN';
      const str1h = m.strength1h || '';
      const str4h = m.strength4h || '';
      const label1h = str1h && trend1h !== 'UNKNOWN' ? str1h + ' ' + trend1h.slice(0, 4) : trend1h;
      const label4h = str4h && trend4h !== 'UNKNOWN' ? str4h + ' ' + trend4h.slice(0, 4) : trend4h;
      valHtfTrend.innerText = label1h + ' / ' + label4h;
      
      let trendClass = 'text-muted';
      if (trend1h === 'BULLISH' && trend4h === 'BULLISH') trendClass = 'text-positive';
      else if (trend1h === 'BEARISH' && trend4h === 'BEARISH') trendClass = 'text-negative';
      else if (trend1h === 'BULLISH' || trend4h === 'BULLISH') trendClass = 'text-positive';
      else if (trend1h === 'BEARISH' || trend4h === 'BEARISH') trendClass = 'text-negative';
      valHtfTrend.className = 'kpi-value select-mono ' + trendClass;

      footHtfTrend.innerText = 'VZO+ZLEMA (JDA Engine)';

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
      const topTraderEl = document.getElementById('foot-ls-top-trader');
      if (topTraderEl && m.topTraderRatio) {
        const topLongPct = (m.topTraderLong || 0.5) * 100;
        const topShortPct = (m.topTraderShort || 0.5) * 100;
        topTraderEl.innerText = `Top Traders: ${m.topTraderRatio.toFixed(2)} (${topLongPct.toFixed(1)}% L / ${topShortPct.toFixed(1)}% S)`;
        topTraderEl.style.color = m.topTraderRatio > lsRatio ? '#0ECB81' : (m.topTraderRatio < lsRatio ? '#F6465D' : '#98989D');
      }
    }
    updateStatus('normal', 'Live');
  } catch (err) {
    console.error('Error fetching bot status:', err.message);
    updateStatus('error', err.message || 'Connection offline');
  } finally {
    btnRefresh.disabled = false;
  }
}

// Sync Now button
btnRefresh.addEventListener('click', () => {
  loadBotStatus();
  loadJDASignal();
});

// Initial load
loadBotStatus();

// Auto refresh sync every 15 seconds for raw data tab
setInterval(() => {
  loadBotStatus();
}, 15000);


// ── JDA MTF Signal Panel ──────────────────────────────────────────────────
function jdaZlemaLabel(trend) {
  return trend === 1 ? 'Bullish' : trend === -1 ? 'Bearish' : 'Neutral';
}

function jdaZStatusLabel(status, above) {
  const dir = above ? '▲' : '▼';
  const label = status === 1 ? 'Bullish' : status === -1 ? 'Bearish' : 'Neutral';
  return dir + ' ' + label;
}

function jdaVzoBg(state) {
  const s = state.replace(/\s+/g, '');
  if (s === 'BULL+') return 'rgba(8,153,129,0.25)';
  if (s === 'BULL')  return 'rgba(8,153,129,0.25)';
  if (s === 'BEAR+') return 'rgba(242,54,69,0.25)';
  if (s === 'BEAR')  return 'rgba(242,54,69,0.25)';
  return 'rgba(152,152,157,0.15)';
}

function jdaZlemaColor(trend) {
  return trend === 1 ? '#089981' : trend === -1 ? '#F23645' : '#666';
}

function jdaZoneBg(zone) {
  if (zone === 'OB') return 'rgba(242,54,69,0.2)';
  if (zone === 'OS') return 'rgba(8,153,129,0.2)';
  return 'rgba(0,0,0,0.2)';
}

function jdaZoneColor(zone) {
  if (zone === 'OB') return '#F23645';
  if (zone === 'OS') return '#0ECB81';
  return '#98989D';
}

function renderJDATable(tfs) {
  const order = ['15m','1h','4h','1d','1w'];
  const labels = { '15m':'15m','1h':'1H','4h':'4H','1d':'1D','1w':'1W' };
  const tbody = document.getElementById('jda-mtf-body');
  if (!tbody) return;

  tbody.innerHTML = order.map(key => {
    const d = tfs[key];
    if (!d) return '';
    const zlColor = jdaZlemaColor(d.trend);
    const stColor = jdaZlemaColor(d.status !== 0 ? d.status : (d.above ? 1 : -1));
    const vzoBg = jdaVzoBg(d.state);
    const zBg = jdaZoneBg(d.zone);
    const zCol = jdaZoneColor(d.zone);
    
    const absVzoInt = Math.round(Math.abs(d.vzo));
    const absVzoDec = Math.abs(d.vzo).toFixed(1);
    const zoneShort = d.zone === 'NORMAL' ? 'N' : d.zone;

    return '<tr>' +
      '<td style="padding:7px 12px; color:#fff; font-weight:700; background:#0a0a0a;">' + labels[key] + '</td>' +
      '<td style="padding:7px 12px; background:' + (d.trend===1?'rgba(8,153,129,0.25)':'rgba(242,54,69,0.25)') + '; color:' + zlColor + '; font-weight:600;">' + jdaZlemaLabel(d.trend) + '</td>' +
      '<td style="padding:7px 12px; background:' + (d.above?'rgba(8,153,129,0.15)':'rgba(242,54,69,0.15)') + '; color:' + stColor + ';">' + jdaZStatusLabel(d.status, d.above) + '</td>' +
      '<td style="padding:7px 12px; background:' + vzoBg + '; color:#fff; font-family:var(--font-mono);">' + d.state + ' (' + absVzoInt + '%)</td>' +
      '<td style="padding:7px 12px; background:' + zBg + '; color:' + zCol + '; font-weight:700;">' + zoneShort + ' (' + absVzoDec + '%)</td>' +
      '</tr>';
  }).join('');
}


async function loadJDASignal() {
  try {
    const res = await fetch('/api/jda-signal');
    if (!res.ok) return;
    const json = await res.json();
    const d = json.data;
    if (!d) return;

    const tfs = d.timeframes;

    // Render table
    renderJDATable(tfs);

    // Bias cell
    const biasEl = document.getElementById('jda-bias-text');
    const biasCellEl = document.getElementById('jda-bias-cell');
    if (biasEl) {
      biasEl.innerText = d.marketBias + ' | ' + d.conf + '% (' + d.confLevel + ')';
      biasEl.style.color = d.marketBias === 'BULLISH' ? '#0ECB81' : d.marketBias === 'BEARISH' ? '#F6465D' : '#98989D';
    }
    if (biasCellEl) {
      biasCellEl.style.background = d.marketBias === 'BULLISH' ? 'rgba(8,153,129,0.12)' : d.marketBias === 'BEARISH' ? 'rgba(242,54,69,0.12)' : '#111';
    }

    // Phase
    const phaseEl = document.getElementById('jda-phase-text');
    if (phaseEl) {
      phaseEl.innerText = d.phase;
      phaseEl.style.color = d.phase.includes('BULL') ? '#0ECB81' : d.phase.includes('BEAR') ? '#F6465D' : d.phase === 'SQUEEZE' ? '#FFD60A' : '#98989D';
    }

    // Dir Score
    const scoreEl = document.getElementById('jda-score-text');
    if (scoreEl) {
      const sign = d.dirScore >= 0 ? '+' : '';
      scoreEl.innerText = sign + d.dirScore + ' (' + (d.aligned ? 'ALIGNED' : 'MIXED') + ')';
      scoreEl.style.color = d.dirScore > 0 ? '#0ECB81' : d.dirScore < 0 ? '#F6465D' : '#98989D';
    }

    // Smart Filters
    const emaFilterEl = document.getElementById('jda-filter-ema-text');
    if (emaFilterEl && d.emaFilter) {
      emaFilterEl.innerText = `${d.emaFilter.value} (${d.emaFilter.status})`;
      emaFilterEl.style.color = d.emaFilter.status.includes('ABOVE') ? '#0ECB81' : '#F6465D';
    }

    const adxFilterEl = document.getElementById('jda-filter-adx-text');
    if (adxFilterEl && d.adxFilter) {
      adxFilterEl.innerText = `${d.adxFilter.value} (${d.adxFilter.status})`;
      adxFilterEl.style.color = d.adxFilter.status.includes('TRENDING') ? '#0ECB81' : '#98989D';
    }

    const crossFilterEl = document.getElementById('jda-filter-cross-text');
    if (crossFilterEl && d.crossFilter) {
      crossFilterEl.innerText = d.crossFilter.status;
      crossFilterEl.style.color = d.crossFilter.status.includes('GOLDEN') ? '#0ECB81' : '#F6465D';
    }

    // Final Call
    const finalCallEl = document.getElementById('jda-final-call-text');
    if (finalCallEl) {
      finalCallEl.innerText = d.finalCall || d.action;
      const isLong = d.action.includes('LONG');
      const isShort = d.action.includes('SHORT');
      finalCallEl.style.color = isLong ? '#0ECB81' : isShort ? '#F6465D' : '#FFD60A';
    }

    // Alignment status
    const alignmentEl = document.getElementById('jda-alignment-text');
    if (alignmentEl) {
      alignmentEl.innerText = d.aligned ? 'ALIGNED ✅' : 'MIXED ⚠️';
      alignmentEl.style.color = d.aligned ? '#0ECB81' : '#FFD60A';
    }

    // Action badge
    const actionEl = document.getElementById('jda-action-badge');
    if (actionEl) {
      actionEl.innerText = d.action;
      const isLong  = d.action.includes('LONG');
      const isShort = d.action.includes('SHORT');
      actionEl.style.background = isLong ? 'rgba(8,153,129,0.25)' : isShort ? 'rgba(242,54,69,0.25)' : 'rgba(152,152,157,0.2)';
      actionEl.style.color = isLong ? '#F0B90B' : isShort ? '#F6465D' : '#FFD60A';
    }

    const timeEl = document.getElementById('jda-update-time');
    if (timeEl) timeEl.innerText = 'Updated: ' + new Date(d.fetchTime).toLocaleTimeString();

  } catch (e) {
    console.error('[JDA] UI error:', e);
  }
}

// Auto-refresh JDA every 3 minutes
loadJDASignal();
setInterval(loadJDASignal, 3 * 60 * 1000);
