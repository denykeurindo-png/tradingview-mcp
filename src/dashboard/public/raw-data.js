const EXCHANGE_RATE = 16300; // 1 USD = 16300 IDR (Rp)
let currentBtcPrice = null;

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

// Cross-indicator synthesis for the Kesimpulan & Summary card -- populated by
// loadBotStatus/loadJDASignal/loadMarketExtras, each of which re-renders it.
let lastMetrics = null;
let lastJdaData = null;
let lastFng = null;

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
      currentBtcPrice = resObj.btcPrice;
      valBtcPrice.innerText = formatUSD(resObj.btcPrice);
      footBtcPrice.innerText = formatIDR(resObj.btcPrice) + ' (Equiv.)';
    }
    
    // Update KPI panels
    if (cachedBotStatus.metrics) {
      const m = cachedBotStatus.metrics;
      lastMetrics = m;
      valOiVal.innerText = formatUSD(m.openInterest || 0);
      
      const oiChange = m.oiChange1h || 0;
      const oiChange15m = m.oiChange15m || 0;
      const oiChangeText = `${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(2)}%`;
      const oi15mText = `${oiChange15m >= 0 ? '+' : ''}${oiChange15m.toFixed(2)}%`;
      const oiBtcText = m.openInterestBtc ? ` · ${(m.openInterestBtc / 1000).toFixed(1)}K BTC` : '';
      footOiChange.innerText = `1h: ${oiChangeText} | 15m: ${oi15mText}${oiBtcText}`;
      footOiChange.className = `kpi-footer ${oiChange15m >= 0 ? 'text-positive' : 'text-negative'}`;
      
      const cvd1h = m.spotCvd1h || 0;
      const cvd15m = m.spotCvd15m || 0;
      valSpotCvd.innerText = `1h: ${formatUSD(cvd1h)} | 15m: ${formatUSD(cvd15m)}`;
      const cvdPositive = cvd15m >= 0;
      valSpotCvd.className = `kpi-value select-mono ${cvdPositive ? 'text-positive' : 'text-negative'}`;
      footSpotCvdStatus.innerText = cvdPositive ? 'Spot Buying (15m)' : 'Spot Selling (15m)';
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
      const pRate = m.premiumRate || 0;
      valFundingRate.innerText = `Fnd: ${(fundRate * 100).toFixed(4)}% | Prem: ${pRate.toFixed(4)}%`;
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
      updateSummaryCard();
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
  loadMarketExtras();
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

    return '<tr style="border-bottom: 1px solid var(--border-color);">' +
      '<td style="padding:10px 12px; color:#fff; font-weight:700; background:rgba(0, 0, 0, 0.35); border-bottom: 1px solid var(--border-color);">' + labels[key] + '</td>' +
      '<td style="padding:10px 12px; background:' + (d.trend===1?'rgba(8,153,129,0.18)':'rgba(242,54,69,0.18)') + '; color:' + zlColor + '; font-weight:600; border-bottom: 1px solid var(--border-color);">' + jdaZlemaLabel(d.trend) + '</td>' +
      '<td style="padding:10px 12px; background:' + (d.above?'rgba(8,153,129,0.1)':'rgba(242,54,69,0.1)') + '; color:' + stColor + '; border-bottom: 1px solid var(--border-color);">' + jdaZStatusLabel(d.status, d.above) + '</td>' +
      '<td style="padding:10px 12px; background:' + vzoBg + '; color:#fff; font-family:var(--font-mono); border-bottom: 1px solid var(--border-color);">' + d.state + ' (' + absVzoInt + '%)</td>' +
      '<td style="padding:10px 12px; background:' + zBg + '; color:' + zCol + '; font-weight:700; border-bottom: 1px solid var(--border-color);">' + zoneShort + ' (' + absVzoDec + '%)</td>' +
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
    lastJdaData = d;

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

    updateSummaryCard();
  } catch (e) {
    console.error('[JDA] UI error:', e);
  }
}

// ── Fear & Greed + ETF Flow ───────────────────────────────────────────────
async function loadMarketExtras() {
  try {
    const res = await fetch('/api/market-extras');
    if (!res.ok) return;
    const json = await res.json();

    // Fear & Greed
    if (json.fng) {
      lastFng = json.fng;
      const val = json.fng.value;
      const label = json.fng.label;

      const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
      set('fng-value', val);
      set('fng-label', label);

      // Color the value
      const valEl = document.getElementById('fng-value');
      if (valEl) {
        if (val <= 25) valEl.style.color = '#F6465D';
        else if (val <= 45) valEl.style.color = '#F0B90B';
        else if (val <= 55) valEl.style.color = '#848E9C';
        else if (val <= 75) valEl.style.color = '#0ECB81';
        else valEl.style.color = '#0ECB81';
      }

      // Bar
      const barEl = document.getElementById('fng-bar');
      if (barEl) {
        barEl.style.width = val + '%';
        if (val <= 25) barEl.style.background = 'linear-gradient(90deg, #F6465D, #F6465D)';
        else if (val <= 45) barEl.style.background = 'linear-gradient(90deg, #F6465D, #F0B90B)';
        else if (val <= 55) barEl.style.background = 'linear-gradient(90deg, #F0B90B, #848E9C)';
        else if (val <= 75) barEl.style.background = 'linear-gradient(90deg, #F0B90B, #0ECB81)';
        else barEl.style.background = 'linear-gradient(90deg, #0ECB81, #0ECB81)';
      }

      // Signal pill
      const pillEl = document.getElementById('fng-signal-pill');
      if (pillEl) {
        let sig = 'NEUTRAL';
        if (val <= 25) sig = 'BEARISH';       // extreme fear → contrarian BULLISH for LSR
        else if (val >= 75) sig = 'BULLISH';   // extreme greed → contrarian BEARISH for LSR
        pillEl.innerText = label;
        pillEl.className = 'signal-pill ' + (val <= 25 ? 'sig-BEARISH' : val >= 75 ? 'sig-BULLISH' : val <= 45 ? 'sig-MIXED' : 'sig-NEUTRAL');
      }

      // LSR context hint
      const hintEl = document.getElementById('fng-lsr-hint');
      if (hintEl) {
        if (val <= 25) {
          hintEl.innerText = '🟢 Extreme Fear + LONG sweep = strong contrarian buy signal';
          hintEl.style.color = '#0ECB81';
        } else if (val >= 75) {
          hintEl.innerText = '🔴 Extreme Greed + SHORT sweep = strong contrarian sell signal';
          hintEl.style.color = '#F6465D';
        } else if (val <= 40) {
          hintEl.innerText = '🟡 Fear zone — slight bias for LONG sweep setups';
          hintEl.style.color = '#F0B90B';
        } else if (val >= 60) {
          hintEl.innerText = '🟡 Greed zone — slight bias for SHORT sweep setups';
          hintEl.style.color = '#F0B90B';
        } else {
          hintEl.innerText = '⚪ Neutral — no sentiment edge for LSR direction';
          hintEl.style.color = '#848E9C';
        }
      }
      updateSummaryCard();
    }

  } catch (e) {
    console.error('[Market Extras] UI error:', e);
  }
}

// ── Kesimpulan & Summary Card ────────────────────────────────────────────
// Synthesizes Fear & Greed, funding/CVD/L-S metrics, and the JDA MTF signal
// into a plain-language bullish/bearish bullet list, so the reader doesn't
// have to manually cross-reference the cards above (same reasoning pattern
// used when explaining this data conversationally).
function updateSummaryCard() {
  const bullishEl = document.getElementById('summary-bullish-list');
  const bearishEl = document.getElementById('summary-bearish-list');
  const concEl = document.getElementById('summary-conclusion-text');
  const pillEl = document.getElementById('summary-verdict-pill');
  if (!bullishEl || !bearishEl || !concEl || !pillEl) return;
  if (!lastMetrics || !lastJdaData || !lastFng) return;

  const m = lastMetrics;
  const d = lastJdaData;
  const fng = lastFng;
  const bullish = [];
  const bearish = [];

  if (fng.value <= 25) {
    bullish.push(`Fear &amp; Greed <b>${fng.value} (Extreme Fear)</b> — area kontrarian bullish, butuh sweep LONG untuk konfirmasi`);
  } else if (fng.value >= 75) {
    bearish.push(`Fear &amp; Greed <b>${fng.value} (Extreme Greed)</b> — area kontrarian bearish, butuh sweep SHORT untuk konfirmasi`);
  }

  const lsRatio = m.longShortRatio || 1;
  if (lsRatio > 1.5) {
    bullish.push(`Long/Short Ratio <b>${lsRatio.toFixed(2)}</b> — posisi crowded Long, rawan liquidation cascade ke bawah (setup sweep LONG)`);
  } else if (lsRatio < 0.7) {
    bearish.push(`Long/Short Ratio <b>${lsRatio.toFixed(2)}</b> — posisi crowded Short, rawan short squeeze`);
  }

  const cvd15m = m.spotCvd15m || 0;
  if (cvd15m < 0) bearish.push(`CVD Spot 15m <b>${formatUSD(cvd15m)}</b> — tekanan jual spot jangka pendek`);
  else if (cvd15m > 0) bullish.push(`CVD Spot 15m <b>${formatUSD(cvd15m)}</b> — tekanan beli spot jangka pendek`);

  if (d.emaFilter) {
    if (d.emaFilter.status.includes('ABOVE')) bullish.push(`EMA50 (4H) Filter <b>${d.emaFilter.status}</b> — tren menengah mendukung Long`);
    else bearish.push(`EMA50 (4H) Filter <b>${d.emaFilter.status}</b> — harga di bawah EMA50 4H, tren menengah menahan Long`);
  }

  if (d.crossFilter) {
    if (d.crossFilter.status.includes('GOLDEN')) bullish.push(`EMA13/SMA50 (15m) <b>Golden Cross</b> — momentum jangka pendek bullish`);
    else bearish.push(`EMA13/SMA50 (15m) <b>Death Cross</b> — momentum jangka pendek bearish`);
  }

  const tfs = d.timeframes || {};
  ['1d', '1w'].forEach(tf => {
    const t = tfs[tf];
    if (!t) return;
    if (t.zone === 'OS') bullish.push(`Timeframe ${tf.toUpperCase()} zone <b>Oversold</b> — rawan bounce`);
    else if (t.zone === 'OB') bearish.push(`Timeframe ${tf.toUpperCase()} zone <b>Overbought</b> — rawan koreksi`);
  });

  bullishEl.innerHTML = bullish.length
    ? bullish.map(b => `<li>${b}</li>`).join('')
    : '<li style="color:var(--text-muted);">Tidak ada faktor bullish signifikan saat ini</li>';
  bearishEl.innerHTML = bearish.length
    ? bearish.map(b => `<li>${b}</li>`).join('')
    : '<li style="color:var(--text-muted);">Tidak ada faktor bearish signifikan saat ini</li>';

  const action = d.action || 'WAIT';
  pillEl.innerText = action;
  pillEl.className = 'signal-pill ' + (action.includes('LONG') ? 'sig-BULLISH' : action.includes('SHORT') ? 'sig-BEARISH' : 'sig-MIXED');

  let conclusion;
  if (!d.aligned) {
    conclusion = `Timeframe saling bertentangan (<b>MIXED</b>), phase <b>${d.phase}</b>, confidence JDA hanya <b>${d.conf}% (${d.confLevel})</b>. `
      + `Sistem merekomendasikan <b>${action}</b> — lebih baik tunggu konfirmasi breakout atau sweep pool LSR sebelum entry berdasarkan sinyal makro ini saja.`;
  } else {
    conclusion = `Timeframe cukup selaras (<b>ALIGNED</b>), bias <b>${d.marketBias}</b> dengan confidence <b>${d.conf}% (${d.confLevel})</b>. Final call: <b>${action}</b>.`;
  }
  concEl.innerHTML = conclusion;
}

// Auto-refresh JDA every 3 minutes
loadJDASignal();
setInterval(loadJDASignal, 3 * 60 * 1000);

// Load market extras on init + every 5 minutes
loadMarketExtras();
setInterval(loadMarketExtras, 5 * 60 * 1000);



