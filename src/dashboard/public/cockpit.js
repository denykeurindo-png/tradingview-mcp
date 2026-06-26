const EXCHANGE_RATE = 6.96; // 1 USD = 6.96 Bolivianos (Bs.)

// DOM Elements
const actionSignal = document.getElementById('action-signal');
const botMessage = document.getElementById('bot-message');
const statusTime = document.getElementById('status-time');
const autoTradeToggle = document.getElementById('auto-trade-toggle');
const activePositionContent = document.getElementById('active-position-content');
const liveBtcPrice = document.getElementById('live-btc-price');
const totalFactorScore = document.getElementById('total-factor-score');

// Status Lights
const lightCdp = document.getElementById('light-cdp');
const lightSpotWs = document.getElementById('light-spot-ws');
const lightFuturesWs = document.getElementById('light-futures-ws');
const lightTelegram = document.getElementById('light-telegram');

// Factor Values & Points
const factors = {
  trend: { val: document.getElementById('val-trend'), pts: document.getElementById('pts-trend') },
  oi: { val: document.getElementById('val-oi'), pts: document.getElementById('pts-oi') },
  cvd: { val: document.getElementById('val-cvd'), pts: document.getElementById('pts-cvd') },
  funding: { val: document.getElementById('val-funding'), pts: document.getElementById('pts-funding') },
  lsr: { val: document.getElementById('val-lsr'), pts: document.getElementById('pts-lsr') },
  delta: { val: document.getElementById('val-delta'), pts: document.getElementById('pts-delta') },
  premium: { val: document.getElementById('val-premium'), pts: document.getElementById('pts-premium') },
  whales: { val: document.getElementById('val-whales'), pts: document.getElementById('pts-whales') }
};

// Orderbook depth
const depthBarBid = document.getElementById('depth-bar-bid');
const depthBarAsk = document.getElementById('depth-bar-ask');
const depthRatioText = document.getElementById('depth-ratio-text');
const orderbookUpdateText = document.getElementById('orderbook-update-text');

// Recent trades list
const recentTradesList = document.getElementById('recent-trades-list');

// ECharts instances
let gaugeChart = null;
let miniHeatmapChart24h = null;
let miniHeatmapChart3d = null;
let equityCurveChart = null;

// Global cache
let simDirection = 'LONG';
let currentBtcPrice = 65000;
let isSavingSettings = false;
let latestBotStatus = null;
let activeChartPeriod = '24h';

// Format Helpers
const formatUSD = (val) => {
  if (!val) return '$0.00';
  const abs = Math.abs(val);
  let formatted = '';
  if (abs >= 1e9) formatted = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) formatted = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) formatted = (abs / 1e3).toFixed(2) + 'K';
  else formatted = abs.toFixed(2);
  return `${val < 0 ? '-' : ''}$${formatted}`;
};

const formatBs = (val) => {
  if (!val) return 'Bs. 0.00';
  const valBs = val * EXCHANGE_RATE;
  const abs = Math.abs(valBs);
  let formatted = '';
  if (abs >= 1e9) formatted = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) formatted = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) formatted = (abs / 1e3).toFixed(2) + 'K';
  else formatted = abs.toFixed(2);
  return `${valBs < 0 ? '-' : ''}Bs. ${formatted}`;
};

const formatIntensity = (val) => {
  if (val === undefined || val === null) return '0.00';
  const abs = Math.abs(val);
  if (abs >= 1e9) return (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (abs / 1e3).toFixed(0) + 'K';
  return abs.toFixed(0);
};

// Update Performance Statistics Tiles
function updatePerformanceStats(trades) {
  const closedTrades = trades.filter(t => t.status !== 'ACTIVE');
  const total = closedTrades.length;
  const hitTp = closedTrades.filter(t => t.status === 'HIT_TP').length;
  const hitSl = closedTrades.filter(t => t.status === 'HIT_SL').length;
  const cutLoss = closedTrades.filter(t => t.status === 'CUT_LOSS').length;
  const winRate = total > 0 ? (hitTp / total) * 100 : 0;
  const netPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const elTotal = document.getElementById('stat-total');
  const elWinRate = document.getElementById('stat-winrate');
  const elTp = document.getElementById('stat-tp');
  const elSl = document.getElementById('stat-sl');
  const elCut = document.getElementById('stat-cut');
  const elPnl = document.getElementById('stat-pnl');

  if (elTotal) elTotal.innerText = total;
  if (elWinRate) elWinRate.innerText = winRate.toFixed(1) + '%';
  if (elTp) elTp.innerText = hitTp;
  if (elSl) elSl.innerText = hitSl;
  if (elCut) elCut.innerText = cutLoss;

  if (elPnl) {
    elPnl.innerText = formatUSD(netPnl);
    if (netPnl > 0) {
      elPnl.style.color = 'var(--accent-success)';
    } else if (netPnl < 0) {
      elPnl.style.color = 'var(--accent-alert)';
    } else {
      elPnl.style.color = '#fff';
    }
  }
}

// Initialize Charts
function initCharts() {
  const gaugeDom = document.getElementById('chart-gauge-probability');
  if (gaugeDom) {
    gaugeChart = echarts.init(gaugeDom, 'dark');
    const option = {
      backgroundColor: 'transparent',
      series: [{
        type: 'gauge',
        startAngle: 180,
        endAngle: 0,
        center: ['50%', '75%'],
        radius: '110%',
        min: 0,
        max: 100,
        splitNumber: 5,
        axisLine: {
          lineStyle: {
            width: 8,
            color: [
              [0.65, '#bfdc21'], // below target
              [0.8, '#0ECB81'],  // target entry
              [1, '#00ffc4']     // strong confirmation
            ]
          }
        },
        pointer: {
          icon: 'path://M12.8,0.7l12,20c0.4,0.7,0.2,1.5-0.4,1.9c-0.2,0.1-0.4,0.2-0.6,0.2H1c-0.8,0-1.4-0.6-1.4-1.4c0-0.2,0.1-0.4,0.2-0.6l12-20C12.2,0.2,12.5,0.1,12.8,0.7z',
          length: '65%',
          width: 8,
          offsetCenter: [0, '-8%'],
          itemStyle: { color: 'auto' }
        },
        axisTick: { length: 5, lineStyle: { color: 'auto', width: 1 } },
        splitLine: { length: 10, lineStyle: { color: 'auto', width: 2 } },
        axisLabel: { color: '#848E9C', fontSize: 10, distance: -35 },
        title: { offsetCenter: [0, '-35%'], fontSize: 11, color: '#848E9C' },
        detail: {
          fontSize: 22,
          offsetCenter: [0, '20%'],
          valueAnimation: true,
          formatter: '{value}%',
          color: 'auto'
        },
        data: [{ value: 0, name: 'Reversal Prob' }]
      }]
    };
    gaugeChart.setOption(option);
  }

  const heatmapDom24h = document.getElementById('chart-mini-heatmap-24h');
  if (heatmapDom24h) {
    miniHeatmapChart24h = echarts.init(heatmapDom24h, 'dark');
  }
  const heatmapDom3d = document.getElementById('chart-mini-heatmap-3d');
  if (heatmapDom3d) {
    miniHeatmapChart3d = echarts.init(heatmapDom3d, 'dark');
  }
}

// Update Bot Status Layout
async function updateBotStatus() {
  try {
    const res = await fetch('/api/bot-status');
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const body = await res.json();
    const data = body.data;
    latestBotStatus = data;

    // Time update
    const lastTime = new Date(data.lastUpdate || Date.now()).toLocaleTimeString();
    statusTime.innerText = `LSR: ${lastTime}`;

    // Price update
    currentBtcPrice = body.btcPrice;
    liveBtcPrice.innerText = formatUSD(currentBtcPrice);

    // Bot Signal Action
    const phase = data.phase || 'WAIT';
    actionSignal.innerText = phase;
    actionSignal.className = `action-badge action-${phase}`;
    botMessage.innerHTML = translateBotMessageToNarrative(data.message);

    // Toggle switch sync (prevent infinite loop while saving)
    if (!isSavingSettings) {
      autoTradeToggle.checked = !!data.autoTradeEnabled;
    }

    // Gauge Chart Probability
    const prob = data.metrics?.reversalProbability || 0;
    if (gaugeChart) {
      gaugeChart.setOption({
        series: [{
          data: [{ value: prob, name: 'Reversal Prob' }]
        }]
      });
    }

    // Factors update
    updateFactorScoring(data);

    // Orderbook update (or from endpoint /api/orderbook-data)
    fetchOrderbookRatio();

    // Render Active Position
    renderActivePosition();

  } catch (e) {
    console.error('[Cockpit] Bot Status update failed:', e.message);
  }
}

// Update factor scorecards
function updateFactorScoring(data) {
  const m = data.metrics || {};
  const b = m.probabilityBreakdown || data.probabilityBreakdown || {};

  // Total Score
  const total = m.reversalProbability || 0;
  totalFactorScore.innerText = `Score: ${total}/100`;

  // Trend
  factors.trend.val.innerText = `${m.trend1h || 'WAIT'} / ${m.trend4h || 'WAIT'}`;
  factors.trend.pts.innerText = `${b.trend >= 0 ? '+' : ''}${b.trend !== undefined ? b.trend : 0}`;

  // OI Change
  factors.oi.val.innerText = `${(m.oiChange1h || 0).toFixed(2)}%`;
  factors.oi.pts.innerText = `${b.oiChange >= 0 ? '+' : ''}${b.oiChange !== undefined ? b.oiChange : 0}`;

  // CVD
  const cvdVal = m.spotCvd1h || 0;
  factors.cvd.val.innerText = formatUSD(cvdVal);
  factors.cvd.val.className = `factor-val ${cvdVal >= 0 ? 'text-positive' : 'text-negative'}`;
  factors.cvd.pts.innerText = `${b.spotCvd >= 0 ? '+' : ''}${b.spotCvd !== undefined ? b.spotCvd : 0}`;

  // Funding Rate
  factors.funding.val.innerText = `${((m.fundingRate || 0) * 100).toFixed(4)}%`;
  factors.funding.pts.innerText = `${b.funding >= 0 ? '+' : ''}${b.funding !== undefined ? b.funding : 0}`;

  // Long/Short Ratio
  factors.lsr.val.innerText = (m.longShortRatio || 1.0).toFixed(4);
  factors.lsr.pts.innerText = `${b.lsRatio >= 0 ? '+' : ''}${b.lsRatio !== undefined ? b.lsRatio : 0}`;

  // Depth Delta
  const deltaVal = b.depthDeltaVal !== undefined ? b.depthDeltaVal : 0;
  factors.delta.val.innerText = `${deltaVal >= 0 ? '+' : ''}${formatUSD(deltaVal)}`;
  factors.delta.pts.innerText = `${b.depthDelta >= 0 ? '+' : ''}${b.depthDelta !== undefined ? b.depthDelta : 0}`;

  // Coinbase Premium
  const premiumVal = b.premiumVal !== undefined ? b.premiumVal : 0;
  factors.premium.val.innerText = `${premiumVal >= 0 ? '+' : ''}${premiumVal.toFixed(4)}%`;
  factors.premium.pts.innerText = `${b.coinbasePremium >= 0 ? '+' : ''}${b.coinbasePremium !== undefined ? b.coinbasePremium : 0}`;

  // Whale Orders
  const whaleCount = m.whaleData?.buyCount + m.whaleData?.sellCount || 0;
  factors.whales.val.innerText = `${whaleCount} Walls`;
  factors.whales.pts.innerText = `${b.whaleWall >= 0 ? '+' : ''}${b.whaleWall !== undefined ? b.whaleWall : 0}`;
}

// Fetch Orderbook Ratio and render
async function fetchOrderbookRatio() {
  try {
    const res = await fetch('/api/orderbook-data');
    if (!res.ok) throw new Error('Orderbook fetch failed');
    const body = await res.json();
    if (body.success && body.data) {
      const asks = body.data.asks || [];
      const bids = body.data.bids || [];

      // Calculate ratio within 1% depth
      let askVol = 0;
      let bidVol = 0;
      asks.forEach(a => askVol += a.quantity);
      bids.forEach(b => bidVol += b.quantity);

      const totalVol = askVol + bidVol;
      if (totalVol > 0) {
        const bidPercent = Math.round((bidVol / totalVol) * 100);
        const askPercent = 100 - bidPercent;

        depthBarBid.style.width = `${bidPercent}%`;
        depthBarBid.innerText = `BID ${bidPercent}%`;
        depthBarAsk.style.width = `${askPercent}%`;
        depthBarAsk.innerText = `${askPercent}% ASK`;
        depthRatioText.innerText = `${bidPercent}% / ${askPercent}%`;

        const age = body.data.timestamp ? new Date(body.data.timestamp).toLocaleTimeString() : 'N/A';
        orderbookUpdateText.innerText = `Last Scraped: ${age}`;
      }
    }
  } catch (e) {
    orderbookUpdateText.innerText = `Orderbook Error: ${e.message}`;
  }
}

// Render active position details
async function renderActivePosition() {
  try {
    const res = await fetch('/api/trades');
    if (!res.ok) throw new Error('Trades fetch failed');
    const body = await res.json();
    const trades = body.data || [];
    
    // Update performance stats row
    updatePerformanceStats(trades);
    
    // Find active trades
    const activeTrade = trades.find(t => t.status === 'ACTIVE');
    if (!activeTrade) {
      renderLsrBotStatusEmptyState();
      return;
    }

    // Calculate live floating PnL
    const diff = activeTrade.direction === 'LONG' 
      ? (currentBtcPrice - activeTrade.entry) 
      : (activeTrade.entry - currentBtcPrice);
    const pnlUsd = activeTrade.positionSizeUsd * (diff / activeTrade.entry);
    const pnlPercent = (diff / activeTrade.entry) * 100;
    const isProfitable = pnlUsd >= 0;

    activePositionContent.innerHTML = `
      <div class="position-info-grid">
        <div class="info-tile">
          <div class="info-tile-label">Direction</div>
          <div class="info-tile-val" style="color: ${activeTrade.direction === 'LONG' ? 'var(--accent-success)' : 'var(--accent-alert)'}">${activeTrade.direction}</div>
        </div>
        <div class="info-tile">
          <div class="info-tile-label">Size (USD)</div>
          <div class="info-tile-val">$${parseFloat(activeTrade.positionSizeUsd).toFixed(0)}</div>
        </div>
        <div class="info-tile">
          <div class="info-tile-label">Entry Price</div>
          <div class="info-tile-val">$${activeTrade.entry.toFixed(2)}</div>
        </div>
        <div class="info-tile">
          <div class="info-tile-label">Target TP</div>
          <div class="info-tile-val" style="color: var(--accent-success)">$${activeTrade.tp.toFixed(2)}</div>
        </div>
        <div class="info-tile">
          <div class="info-tile-label">Stop Loss</div>
          <div class="info-tile-val" style="color: var(--accent-alert)">$${activeTrade.sl.toFixed(2)}</div>
        </div>
        <div class="info-tile">
          <div class="info-tile-label">Risk/Reward</div>
          <div class="info-tile-val">1 : ${activeTrade.tpDistance && activeTrade.slDistance ? (activeTrade.tpDistance / activeTrade.slDistance).toFixed(1) : '2.0'}</div>
        </div>
      </div>

      <div class="floating-pnl-box ${isProfitable ? 'pnl-green' : 'pnl-red'}">
        <span>FLOATING PNL</span>
        <span style="font-family: var(--font-mono)">
          ${isProfitable ? '+' : ''}$${pnlUsd.toFixed(2)} (${isProfitable ? '+' : ''}${pnlPercent.toFixed(2)}%)
        </span>
      </div>

      <button class="btn-emergency" onclick="triggerEmergencyClose('${activeTrade.id}')">Emergency Market Close</button>
    `;

  } catch (e) {
    console.error('[Cockpit] Failed to render active position:', e.message);
  }
}

// Trigger emergency close loss call
async function triggerEmergencyClose(tradeId) {
  if (!confirm('Are you sure you want to CLOSE this active trade at market price?')) return;
  try {
    const res = await fetch('/api/trades/cut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tradeId, closePrice: currentBtcPrice })
    });
    if (res.ok) {
      alert('Active position successfully closed at market price.');
      renderActivePosition();
    } else {
      const err = await res.json();
      alert(`Close failed: ${err.error || 'Unknown error'}`);
    }
  } catch (e) {
    alert(`Error closing position: ${e.message}`);
  }
}

// Fetch connection heartbeat lights
async function updateConnectionStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Status heartbeat failed');
    const body = await res.json();
    if (body.success && body.checks) {
      // CDP
      const cdp = body.checks.find(c => c.key === 'cdp');
      lightCdp.className = `light-dot ${cdp?.status === 'ok' ? 'ok' : 'error'}`;

      // Spot WS
      const spot = body.checks.find(c => c.key === 'binance_spot');
      lightSpotWs.className = `light-dot ${spot?.status === 'ok' ? 'ok' : 'error'}`;

      // Futures WS
      const fut = body.checks.find(c => c.key === 'binance_futures');
      lightFuturesWs.className = `light-dot ${fut?.status === 'ok' ? 'ok' : 'error'}`;

      // Telegram
      const tg = body.checks.find(c => c.key === 'telegram');
      lightTelegram.className = `light-dot ${tg?.status === 'ok' ? 'ok' : 'error'}`;
    }
  } catch (e) {
    console.error('[Heartbeat] Connection check failed:', e.message);
  }
}

// Fetch and render market extras: Fear & Greed and ETF flow data
async function updateMarketExtras() {
  try {
    const res = await fetch('/api/market-extras');
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const body = await res.json();
    if (body.success) {
      // 1. Update Fear & Greed Index
      const fng = body.fng || { value: 50, label: 'Neutral' };
      const fngValEl = document.getElementById('fng-value');
      const fngLabelEl = document.getElementById('fng-label');
      const fngBadgeEl = document.getElementById('fng-badge');
      const fngBarEl = document.getElementById('fng-bar');
      const fngStatusEl = document.getElementById('fng-status');

      if (fngValEl) fngValEl.innerText = fng.value;
      if (fngLabelEl) fngLabelEl.innerText = fng.label;
      if (fngBadgeEl) {
        fngBadgeEl.innerText = fng.label.toUpperCase();
        // Set dynamic colors based on label
        let badgeColor = 'var(--text-muted)';
        let badgeBg = 'rgba(255,255,255,0.05)';
        let textColor = '#fff';
        const labelLower = fng.label.toLowerCase();
        if (labelLower.includes('extreme fear')) {
          badgeColor = 'var(--accent-alert)';
          badgeBg = 'rgba(246, 70, 93, 0.15)';
          textColor = 'var(--accent-alert)';
        } else if (labelLower.includes('fear')) {
          badgeColor = '#FFA39E';
          badgeBg = 'rgba(255,163,158,0.15)';
          textColor = '#FFA39E';
        } else if (labelLower.includes('extreme greed')) {
          badgeColor = '#00ffc4';
          badgeBg = 'rgba(0,255,196,0.15)';
          textColor = '#00ffc4';
        } else if (labelLower.includes('greed')) {
          badgeColor = 'var(--accent-success)';
          badgeBg = 'rgba(14, 203, 129, 0.15)';
          textColor = 'var(--accent-success)';
        } else {
          badgeColor = 'var(--accent-primary)';
          badgeBg = 'rgba(240, 185, 11, 0.15)';
          textColor = 'var(--accent-primary)';
        }
        fngBadgeEl.style.borderColor = badgeColor;
        fngBadgeEl.style.background = badgeBg;
        fngBadgeEl.style.color = textColor;
        if (fngValEl) fngValEl.style.color = badgeColor;
        if (fngLabelEl) fngLabelEl.style.color = badgeColor;
      }
      if (fngBarEl) {
        fngBarEl.style.width = `${fng.value}%`;
        const labelLower = fng.label.toLowerCase();
        if (labelLower.includes('fear')) {
          fngBarEl.style.backgroundColor = 'var(--accent-alert)';
        } else if (labelLower.includes('greed')) {
          fngBarEl.style.backgroundColor = 'var(--accent-success)';
        } else {
          fngBarEl.style.backgroundColor = 'var(--accent-primary)';
        }
      }
      if (fngStatusEl) {
        let fngStatusText = '';
        const val = fng.value;
        if (val <= 25) {
          fngStatusText = `🟢 <strong style="color: var(--accent-success);">Extreme Fear + LONG sweep</strong> = strong contrarian buy signal`;
        } else if (val < 45) {
          fngStatusText = `🟢 <strong style="color: var(--accent-success);">Fear + LONG sweep</strong> = moderate contrarian buy signal`;
        } else if (val >= 75) {
          fngStatusText = `🔴 <strong style="color: var(--accent-alert);">Extreme Greed + SHORT sweep</strong> = strong contrarian sell signal`;
        } else if (val > 55) {
          fngStatusText = `🔴 <strong style="color: var(--accent-alert);">Greed + SHORT sweep</strong> = moderate contrarian sell signal`;
        } else {
          fngStatusText = `⚪ <strong>Neutral Market</strong> — no contrarian bias`;
        }
        fngStatusEl.innerHTML = fngStatusText;
      }

      // 2. Update ETF Flow
      const etf = body.etfSummary;
      const etfDailyEl = document.getElementById('etf-daily');
      const etfTotalEl = document.getElementById('etf-total');
      const etfGbtcEl = document.getElementById('etf-gbtc');
      const etfSyncEl = document.getElementById('etf-sync');
      const etfBadgeEl = document.getElementById('etf-badge');
      const etfStatusEl = document.getElementById('etf-status');

      if (etf) {
        const formatFlow = (valLabel, numVal) => {
          if (!valLabel || valLabel === 'N/A') return 'N/A';
          const cleanLabel = valLabel.replace(/[\$\+,]/g, '').trim();
          const isNegative = numVal < 0 || valLabel.includes('-');
          const color = isNegative ? 'var(--accent-alert)' : 'var(--accent-success)';
          const sign = isNegative ? '-' : '+';
          // Format raw labels cleanly
          return `<span style="color: ${color}">${sign}$${cleanLabel}</span>`;
        };

        if (etfDailyEl) {
          etfDailyEl.innerHTML = formatFlow(etf.dailyLabel, etf.dailyUsd);
        }
        if (etfTotalEl) {
          etfTotalEl.innerHTML = formatFlow(etf.totalLabel, etf.totalUsd);
        }
        if (etfGbtcEl) {
          const gbtcSign = etf.gbtcBtc < 0 ? '-' : etf.gbtcBtc > 0 ? '+' : '';
          const gbtcColor = etf.gbtcBtc < 0 ? 'var(--accent-alert)' : etf.gbtcBtc > 0 ? 'var(--accent-success)' : 'var(--text-muted)';
          etfGbtcEl.innerHTML = etf.gbtcBtc !== 0 
            ? `<span style="color: ${gbtcColor}">${gbtcSign}${Math.abs(etf.gbtcBtc).toLocaleString()} BTC</span>`
            : '<span style="color: var(--text-muted);">N/A</span>';
        }
        if (etfSyncEl) {
          etfSyncEl.innerText = etf.lastUpdate ? new Date(etf.lastUpdate).toLocaleTimeString() : '--:--:--';
        }
        if (etfBadgeEl) {
          etfBadgeEl.innerText = etf.signal;
          let badgeColor = 'var(--text-muted)';
          let badgeBg = 'rgba(255,255,255,0.05)';
          if (etf.signal === 'BULLISH') {
            badgeColor = 'var(--accent-success)';
            badgeBg = 'rgba(14, 203, 129, 0.15)';
          } else if (etf.signal === 'BEARISH') {
            badgeColor = 'var(--accent-alert)';
            badgeBg = 'rgba(246, 70, 93, 0.15)';
          } else if (etf.signal === 'MIXED') {
            badgeColor = 'var(--accent-primary)';
            badgeBg = 'rgba(240, 185, 11, 0.15)';
          }
          etfBadgeEl.style.borderColor = badgeColor;
          etfBadgeEl.style.background = badgeBg;
          etfBadgeEl.style.color = badgeColor;
        }
        if (etfStatusEl) {
          if (etf.signal === 'BEARISH' || etf.dailyUsd < 0) {
            etfStatusEl.innerHTML = `🔴 <strong style="color: var(--accent-alert);">Institutional outflow</strong> — macro supports SHORT sweep setups`;
          } else if (etf.signal === 'BULLISH' || etf.dailyUsd > 0) {
            etfStatusEl.innerHTML = `🟢 <strong style="color: var(--accent-success);">Institutional inflow</strong> — macro supports LONG sweep setups`;
          } else {
            etfStatusEl.innerHTML = `⚪ <strong>Neutral ETF flow</strong> — no strong macro sweep bias`;
          }
        }
      } else {
        if (etfDailyEl) etfDailyEl.innerText = 'N/A';
        if (etfTotalEl) etfTotalEl.innerText = 'N/A';
        if (etfGbtcEl) etfGbtcEl.innerText = 'N/A';
        if (etfSyncEl) etfSyncEl.innerText = '--:--:--';
        if (etfBadgeEl) {
          etfBadgeEl.innerText = 'NEUTRAL';
          etfBadgeEl.style.borderColor = 'var(--text-muted)';
          etfBadgeEl.style.color = 'var(--text-muted)';
          etfBadgeEl.style.background = 'rgba(255,255,255,0.05)';
        }
        if (etfStatusEl) etfStatusEl.innerHTML = `⚪ <strong>No ETF data cache</strong> — waiting for update...`;
      }
    }
  } catch (e) {
    console.error('[Cockpit] Failed to update market extras:', e.message);
  }
}

function renderSingleMiniChart(chartInstance, title, heatmapData, pools) {
  if (!chartInstance) return;

  const candlestickSeries = heatmapData.series.find(s => s.type === 'candlestick');
  if (!candlestickSeries) return;

  const slicedX = heatmapData.xAxis.slice(-40);
  const slicedCandles = candlestickSeries.data.slice(-40).map(c => [
    parseFloat(c[0]), parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3])
  ]);

  const resistancePools = pools.above;
  const supportPools = pools.below;

  const markLines = [];
  resistancePools.forEach(p => {
    const isLiq = p.isLiquidated;
    const color = isLiq ? '#848E9C' : '#F6465D';
    const type = isLiq ? 'dotted' : 'dashed';
    const labelFormatter = isLiq
      ? `[LIQ] $${Math.round(p.price).toLocaleString()} ($${formatIntensity(p.leverage)})`
      : `$${Math.round(p.price).toLocaleString()} ($${formatIntensity(p.leverage)})`;
    markLines.push({
      yAxis: p.price,
      name: `RES $${Math.round(p.price)}`,
      lineStyle: { color: color, type: type, width: 1.5 },
      label: {
        formatter: labelFormatter,
        position: 'end',
        color: color,
        fontSize: 10
      }
    });
  });

  supportPools.forEach(p => {
    const isLiq = p.isLiquidated;
    const color = isLiq ? '#848E9C' : '#0ECB81';
    const type = isLiq ? 'dotted' : 'dashed';
    const labelFormatter = isLiq
      ? `[LIQ] $${Math.round(p.price).toLocaleString()} ($${formatIntensity(p.leverage)})`
      : `$${Math.round(p.price).toLocaleString()} ($${formatIntensity(p.leverage)})`;
    markLines.push({
      yAxis: p.price,
      name: `SUP $${Math.round(p.price)}`,
      lineStyle: { color: color, type: type, width: 1.5 },
      label: {
        formatter: labelFormatter,
        position: 'end',
        color: color,
        fontSize: 10
      }
    });
  });

  let refPrice = currentBtcPrice || 60000;
  if (slicedCandles.length > 0) {
    const latestCandle = slicedCandles[slicedCandles.length - 1];
    const closePrice = parseFloat(latestCandle[1]);
    if (!isNaN(closePrice) && closePrice > 0) {
      refPrice = closePrice;
    }
  }
  const yAxisMin = Math.round(refPrice - 2000);
  const yAxisMax = Math.round(refPrice + 2000);

  const option = {
    backgroundColor: 'transparent',
    title: {
      text: title,
      textStyle: { color: '#848E9C', fontSize: 11, fontWeight: 'bold' },
      left: 10,
      top: 0
    },
    grid: { top: 30, bottom: 24, left: 55, right: 90 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' }
    },
    xAxis: {
      type: 'category',
      data: slicedX.map(t => t.split(',')[1] || t), // show HH:MM only
      axisLine: { lineStyle: { color: '#2B3139' } },
      axisLabel: { color: '#848E9C', fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      scale: false,
      min: yAxisMin,
      max: yAxisMax,
      axisLine: { lineStyle: { color: '#2B3139' } },
      axisLabel: { color: '#848E9C', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } }
    },
    series: [{
      name: 'BTC Price',
      type: 'candlestick',
      data: slicedCandles,
      itemStyle: {
        color: '#0ECB81',
        color0: '#F6465D',
        borderColor: '#0ECB81',
        borderColor0: '#F6465D'
      },
      markLine: {
        symbol: ['none', 'none'],
        data: markLines
      }
    }],
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'filter' },
      { type: 'inside', yAxisIndex: 0, filterMode: 'empty' }
    ]
  };
  chartInstance.setOption(option, true);
}

// Fetch Liquidation Heatmap data and update ECharts Mini map
async function updateMiniHeatmap() {
  try {
    const [res, res3d] = await Promise.all([
      fetch('/api/heatmap-data'),
      fetch('/api/heatmap-data-3d').catch(e => ({ ok: false }))
    ]);
    if (!res.ok) throw new Error('Heatmap data fetch failed');
    const resObj = await res.json();
    const data = resObj.data.data;
    if (!data || !data.xAxis || !data.yAxis || !data.series) return;

    let data3d = null;
    if (res3d && res3d.ok) {
      try {
        const resObj3d = await res3d.json();
        data3d = resObj3d.data?.data || resObj3d.data;
      } catch (e3d) {}
    }

    // --- Define Helpers ---
    const extractTopPools = (heatmapData) => {
      if (!heatmapData || !heatmapData.series) return { above: [], below: [] };
      const hs = heatmapData.series.find(s => s.type === 'heatmap');
      const cs = heatmapData.series.find(s => s.type === 'candlestick');
      if (!hs || !hs.data || hs.data.length === 0) return { above: [], below: [] };

      // Use a local reference price from the latest candle of this snapshot to prevent race conditions
      let refPrice = currentBtcPrice;
      if (cs && cs.data && cs.data.length > 0) {
        const latestCandle = cs.data[cs.data.length - 1];
        const closePrice = parseFloat(latestCandle[1]);
        if (!isNaN(closePrice) && closePrice > 0) {
          refPrice = closePrice;
        }
      }

      // Calculate recent min/max price bounds from the last 40 candles (matching visible chart)
      let maxHighRecent = refPrice;
      let minLowRecent = refPrice;
      if (cs && cs.data) {
        const recentCandles = cs.data.slice(-40);
        recentCandles.forEach(c => {
          const low = parseFloat(c[2]), high = parseFloat(c[3]);
          if (!isNaN(high) && high > maxHighRecent) maxHighRecent = high;
          if (!isNaN(low) && low < minLowRecent) minLowRecent = low;
        });
      }

      const yAxisData = heatmapData.yAxis || [];
      const xAxisLength = heatmapData.xAxis ? heatmapData.xAxis.length : 0;
      const latestXIdx = xAxisLength - 1;
      const startXIdx = Math.max(0, latestXIdx - 40);

      const leverageLatest = {};
      const leverageMaxRecent = {};
      
      yAxisData.forEach((_, idx) => {
        leverageLatest[idx] = 0;
        leverageMaxRecent[idx] = 0;
      });

      hs.data.forEach(item => {
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

      const levels = [];
      Object.keys(leverageLatest).forEach(yIdxStr => {
        const yIdx = parseInt(yIdxStr, 10);
        const priceStr = yAxisData[yIdx];
        if (!priceStr) return;
        const price = parseFloat(priceStr);
        const latestVal = leverageLatest[yIdx];
        const maxRecentVal = leverageMaxRecent[yIdx];
        const isAbove = price > refPrice;

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

        const distancePercent = ((price - refPrice) / refPrice) * 100;
        levels.push({ price, leverage, distance: distancePercent, isAbove, isLiquidated });
      });

      const aboveLevels = levels.filter(l => l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5).sort((a, b) => a.price - b.price);
      const belowLevels = levels.filter(l => !l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5).sort((a, b) => b.price - a.price);

      const maxLeverage = Math.max(...levels.map(l => l.leverage), 1);
      return { above: aboveLevels, below: belowLevels, maxLeverage };
    };

    // --- Process Heatmap Data ---
    const pools24h = extractTopPools(data);
    const pools3d = data3d ? extractTopPools(data3d) : { above: [], below: [], maxLeverage: 1 };

    // Update main BTC price in UI from latest 24h data close
    const candlestickSeries24h = data.series.find(s => s.type === 'candlestick');
    if (candlestickSeries24h && candlestickSeries24h.data && candlestickSeries24h.data.length > 0) {
      const latestCandle = candlestickSeries24h.data[candlestickSeries24h.data.length - 1];
      const heatmapPrice = parseFloat(latestCandle[1]);
      if (!isNaN(heatmapPrice) && heatmapPrice > 0) {
        currentBtcPrice = heatmapPrice;
      }
    }

    // Render both charts stacked
    renderSingleMiniChart(miniHeatmapChart24h, '24H SWEEP MAP', data, pools24h);
    if (data3d) {
      renderSingleMiniChart(miniHeatmapChart3d, '3D SWEEP MAP', data3d, pools3d);
    }

    const renderPoolList = (pools, isAbove, maxLeverage = 1) => {
      if (pools.length === 0) {
        return '<div style="color:var(--text-muted);text-align:center;padding:6px;font-size:10px;">No pools detected</div>';
      }
      return pools.map((lvl, idx) => {
        const isLiq = lvl.isLiquidated;
        const rowStyle = isLiq ? 'opacity: 0.45; text-decoration: line-through;' : '';
        const priceColor = isLiq ? 'var(--text-muted)' : '#FFFFFF';
        const volColor = isLiq ? 'var(--text-muted)' : (isAbove ? '#bfdc21' : '#3ab56e');

        let intensityText = 'LOW';
        let intensityColor = '#848E9C';
        let intensityBg = 'rgba(255,255,255,0.05)';
        
        if (isLiq) {
          intensityText = 'LIQ';
          intensityColor = '#848E9C';
          intensityBg = 'rgba(255,255,255,0.03)';
        } else {
          const ratio = lvl.leverage / maxLeverage;
          if (ratio >= 0.7) {
            intensityText = 'HIGH';
            intensityColor = '#bfdc21';
            intensityBg = 'rgba(191, 220, 33, 0.15)';
          } else if (ratio >= 0.3) {
            intensityText = 'MED';
            intensityColor = '#3ab56e';
            intensityBg = 'rgba(58, 181, 110, 0.15)';
          } else {
            intensityText = 'LOW';
            intensityColor = '#3a9db5';
            intensityBg = 'rgba(58, 157, 181, 0.15)';
          }
        }

        const badgeHtml = `<span style="display: inline-block; padding: 2px 4px; border-radius: 3px; font-size: 8px; font-weight: 700; border: 1px solid ${intensityColor}; background: ${intensityBg}; color: ${intensityColor}; text-transform: uppercase;">${intensityText}</span>`;
        
        return `
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.02); padding: 4px 0; font-family: var(--font-mono); font-size: 10px; ${rowStyle}">
            <span style="width: 44px; text-align: left; font-weight: 600; color: ${priceColor};">$${Math.round(lvl.price).toLocaleString()}</span>
            <span style="width: 48px; text-align: center; color: ${volColor}; font-weight: 600;">$${formatIntensity(lvl.leverage)}</span>
            <span style="width: 42px; text-align: right;">${badgeHtml}</span>
          </div>
        `;
      }).join('');
    };

    const resContainer = document.getElementById('cockpit-resistance-pools');
    const supContainer = document.getElementById('cockpit-support-pools');
    if (resContainer) resContainer.innerHTML = renderPoolList(pools24h.above, true, pools24h.maxLeverage);
    if (supContainer) supContainer.innerHTML = renderPoolList(pools24h.below, false, pools24h.maxLeverage);

    const res3dContainer = document.getElementById('cockpit-resistance-pools-3d');
    const sup3dContainer = document.getElementById('cockpit-support-pools-3d');
    if (data3d) {
      if (res3dContainer) res3dContainer.innerHTML = renderPoolList(pools3d.above, true, pools3d.maxLeverage);
      if (sup3dContainer) sup3dContainer.innerHTML = renderPoolList(pools3d.below, false, pools3d.maxLeverage);
    } else {
      if (res3dContainer) res3dContainer.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:6px;font-size:10px;">No 3D data cache yet...</div>';
      if (sup3dContainer) sup3dContainer.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:6px;font-size:10px;">No 3D data cache yet...</div>';
    }

    const syncEl24h = document.getElementById('liq-pools-update-24h');
    if (syncEl24h) syncEl24h.innerText = new Date().toLocaleTimeString();

    const syncEl3d = document.getElementById('liq-pools-update-3d');
    if (syncEl3d) {
      if (data3d) {
        syncEl3d.innerText = new Date().toLocaleTimeString();
      } else {
        syncEl3d.innerText = '--:--:--';
      }
    }

  } catch (e) {
    console.error('[Cockpit] Failed to update mini heatmap:', e.message);
  }
}

// Auto-Trade toggle handler
autoTradeToggle.addEventListener('change', async (e) => {
  const newValue = e.target.checked;
  isSavingSettings = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoTradeEnabled: newValue })
    });
    if (!res.ok) throw new Error('Settings save failed');
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
    autoTradeToggle.checked = !newValue;
  } finally {
    isSavingSettings = false;
  }
});

// Window resize handler
window.addEventListener('resize', () => {
  if (gaugeChart) gaugeChart.resize();
  if (miniHeatmapChart24h) miniHeatmapChart24h.resize();
  if (miniHeatmapChart3d) miniHeatmapChart3d.resize();
  if (equityCurveChart) equityCurveChart.resize();
});

// Render LSR Bot Status when no active positions exist
function renderLsrBotStatusEmptyState() {
  if (!latestBotStatus) {
    activePositionContent.innerHTML = `<div class="no-active-trade">No active trade. Loading bot status...</div>`;
    return;
  }
  const status = latestBotStatus;

  // LSR Bot Status details
  const poolPrice = status.nearestPool ? '$' + Math.round(status.nearestPool).toLocaleString() : '--';
  const poolSide = status.nearestPoolSide || '--';
  const poolColor = poolSide === 'SUPPORT' ? 'var(--accent-success)' : poolSide === 'RESISTANCE' ? 'var(--accent-alert)' : 'var(--text-muted)';
  const poolDistance = status.nearestPoolDistance || '--';
  
  const probVal = status.reversalProbabilityPreview || status.metrics?.reversalProbability || 0;
  const probColor = probVal >= 65 ? 'var(--accent-success)' : probVal >= 50 ? 'var(--accent-primary)' : 'var(--accent-alert)';
  
  let rrVal = 'No Sweep';
  let rrColor = 'var(--text-muted)';
  if (status.sweepCandidate && status.sweepCandidate.rr) {
    rrVal = '1 : ' + status.sweepCandidate.rr;
    rrColor = status.sweepCandidate.rr >= 2 ? 'var(--accent-success)' : 'var(--accent-alert)';
  }

  // Whale Trade Flow details
  const w = status.whaleData || {};
  const whaleBuy = w.buyVol || 0;
  const whaleSell = w.sellVol || 0;
  const whaleNet = w.netFlow || 0;
  const whaleSignal = w.signal || 'NEUTRAL';
  const signalColor = whaleSignal === 'ACCUMULATION' ? 'var(--accent-success)' : whaleSignal === 'DISTRIBUTION' ? 'var(--accent-alert)' : 'var(--text-muted)';

  // Strategy Guardrails details
  const s = status.settings || {};
  const capital = s.capital || 1000;
  const riskPercent = s.riskPercent || 1.0;
  const riskUsd = capital * (riskPercent / 100);

  let wickHtml = '';
  const sc = status.sweepCandidate;
  if (sc && sc.rejectionStrength !== undefined) {
    wickHtml = `
      <div style="background: rgba(14, 203, 129, 0.04); border: 1px solid rgba(14, 203, 129, 0.15); border-radius: 6px; padding: 10px 12px; margin-top: 8px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--accent-success); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px;">⚡ Active Sweep Candle</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px;">
          <div>
            <span style="color: var(--text-muted)">Rejection Strength</span>
            <div style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-success); margin-top: 1px;">${sc.rejectionStrength.toFixed(3)}%</div>
          </div>
          <div>
            <span style="color: var(--text-muted)">Wick Depth</span>
            <div style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-success); margin-top: 1px;">${sc.wickDepth.toFixed(3)}%</div>
          </div>
          <div style="grid-column: span 2; margin-top: 4px;">
            <span style="color: var(--text-muted)">Confirm Candles: </span>
            <span style="font-family: var(--font-mono); font-weight: 700; color: #fff;">${sc.confirmCount} candle(s)</span>
          </div>
        </div>
      </div>
    `;
  }

  activePositionContent.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 14px; height: 100%;">
      <!-- Card Section 1: Scanning status -->
      <div>
        <div style="font-size: 12px; font-weight: 700; color: var(--accent-primary); border-bottom: 1px dashed var(--border-color); padding-bottom: 6px;">
          🎯 LSR BOT STATUS (SCANNING)
        </div>
        <div class="position-info-grid" style="margin-top: 6px;">
          <div class="info-tile">
            <div class="info-tile-label">Nearest Pool</div>
            <div class="info-tile-val" style="color: ${poolColor}; font-size: 14px;">${poolPrice}</div>
            <div style="font-size: 9px; font-weight: 700; margin-top: 1px; color: ${poolColor}">${poolSide}</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Pool Distance</div>
            <div class="info-tile-val" style="color: var(--accent-primary); font-size: 14px;">${poolDistance}</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Reversal Prob</div>
            <div class="info-tile-val" style="color: ${probColor}; font-size: 14px;">${probVal}%</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Sweep R:R</div>
            <div class="info-tile-val" style="color: ${rrColor}; font-size: 14px;">${rrVal}</div>
          </div>
        </div>
      </div>

      <!-- Card Section 2: Whale Flow Detector -->
      <div>
        <div style="font-size: 12px; font-weight: 700; color: var(--accent-primary); border-bottom: 1px dashed var(--border-color); padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
          <span>🐳 WHALE FLOW DETECTOR (15M)</span>
          <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); color: ${signalColor}; font-weight: 700;">${whaleSignal}</span>
        </div>
        <div class="position-info-grid" style="margin-top: 6px;">
          <div class="info-tile">
            <div class="info-tile-label">Whale Buy Vol</div>
            <div class="info-tile-val" style="color: var(--accent-success); font-size: 13px;">${formatUSD(whaleBuy)}</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Whale Sell Vol</div>
            <div class="info-tile-val" style="color: var(--accent-alert); font-size: 13px;">${formatUSD(whaleSell)}</div>
          </div>
          <div class="info-tile" style="grid-column: span 2;">
            <div class="info-tile-label">Net Whale Flow</div>
            <div class="info-tile-val" style="color: ${whaleNet >= 0 ? 'var(--accent-success)' : 'var(--accent-alert)'}; font-size: 14px; font-family: var(--font-mono);">
              ${whaleNet >= 0 ? '+' : ''}${formatUSD(whaleNet)}
            </div>
          </div>
        </div>
      </div>

      <!-- Card Section 3: Active Constraints -->
      <div>
        <div style="font-size: 12px; font-weight: 700; color: var(--accent-primary); border-bottom: 1px dashed var(--border-color); padding-bottom: 6px;">
          ⚙️ STRATEGY PARAMETERS
        </div>
        <div class="position-info-grid" style="margin-top: 6px;">
          <div class="info-tile">
            <div class="info-tile-label">Capital Allocated</div>
            <div class="info-tile-val" style="font-size: 13px;">$${capital.toLocaleString()}</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Risk per Trade</div>
            <div class="info-tile-val" style="font-size: 13px;">${riskPercent}% ($${riskUsd.toFixed(0)})</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Min Strategy R:R</div>
            <div class="info-tile-val" style="font-size: 13px;">1 : ${s.minRR}</div>
          </div>
          <div class="info-tile">
            <div class="info-tile-label">Min Prob Filter</div>
            <div class="info-tile-val" style="font-size: 13px;">${s.minReversalProbability}%</div>
          </div>
        </div>
      </div>
      
      ${wickHtml}
    </div>
  `;
}

// Translate bot messages to a friendly Indonesian narrative layout
function translateBotMessageToNarrative(msg) {
  if (!msg) return 'Bot sedang memindai pergerakan pasar...';
  
  // Clean clean HTML check helper
  const cleanNum = (str) => {
    const num = parseInt(str.replace(/[,.]/g, ''), 10);
    return isNaN(num) ? str : num.toLocaleString();
  };

  // 1. Approaching Pool
  // Format: ⚠️ Price $59205 approaching SUPPORT pool at $59075 (0.22% away). Preview prob: 57%. Watching for sweep...
  if (msg.includes('approaching') && msg.includes('pool at')) {
    const match = msg.match(/⚠️ Price \$([\d.,]+) approaching (SUPPORT|RESISTANCE) pool at \$([\d.,]+) \(([\d.]+)% away\)\. Preview prob: (\d+)%\. Watching for sweep\.\.\./);
    if (match) {
      const [_, price, side, poolPrice, dist, prob] = match;
      const sideText = side === 'SUPPORT' ? 'SUPPORT (Batas Bawah)' : 'RESISTANCE (Batas Atas)';
      const sideColor = side === 'SUPPORT' ? 'var(--accent-success)' : 'var(--accent-alert)';
      return `⚠️ Harga BTC (<strong>$${cleanNum(price)}</strong>) sedang mendekati kolam <strong style="color: ${sideColor}">${sideText}</strong> di harga <strong>$${cleanNum(poolPrice)}</strong> (selisih <strong>${dist}%</strong>). Estimasi probabilitas pembalikan arah saat ini <strong>${prob}%</strong>. Bot sedang memantau terjadinya sweep...`;
    }
  }

  // 2. RR check skip
  // Format: Sweep detected at $59075 but R:R 1.5 < min 2. Skipping.
  if (msg.includes('Sweep detected') && msg.includes('Skipping')) {
    const match = msg.match(/Sweep detected at \$([\d.,]+) but R:R ([\d.]+) < min ([\d.]+)\. Skipping\./);
    if (match) {
      const [_, price, rr, minRr] = match;
      return `📉 Deteksi sweep terjadi di <strong>$${cleanNum(price)}</strong>, namun rasio Risk-to-Reward (${rr}) lebih kecil dari batas minimum (${minRr}). Eksekusi masuk posisi dilewati.`;
    }
  }

  // 3. Force skip
  // Format: Sweep detected at $59075 but force skipped: negative depth delta
  if (msg.includes('Sweep detected') && msg.includes('force skipped')) {
    const match = msg.match(/Sweep detected at \$([\d.,]+) but force skipped: (.*)/);
    if (match) {
      const [_, price, reason] = match;
      return `⚠️ Deteksi sweep terjadi di <strong>$${cleanNum(price)}</strong>, namun eksekusi dilewati secara otomatis (Force Skip) karena: <strong style="color: var(--accent-primary);">${reason}</strong>.`;
    }
  }

  // 4. Trade execution entry
  // Format: 🎯 LONG entry at $59075 after sweep of $59075 pool. R:R 1:2.5 (Prob: 72%)
  if (msg.includes('entry at') && msg.includes('after sweep')) {
    const match = msg.match(/🎯 (LONG|SHORT) entry at \$([\d.,]+) after sweep of \$([\d.,]+) pool\. R:R 1:([\d.]+) \(Prob: (\d+)%\)/);
    if (match) {
      const [_, dir, entry, pool, rr, prob] = match;
      const dirText = dir === 'LONG' ? 'BUY / LONG' : 'SELL / SHORT';
      const color = dir === 'LONG' ? 'var(--accent-success)' : 'var(--accent-alert)';
      return `🎯 Bot berhasil melakukan eksekusi <strong><span style="color: ${color}">${dirText}</span></strong> di harga <strong>$${cleanNum(entry)}</strong> setelah terjadi sweep pada kolam $${cleanNum(pool)}. Rasio R:R 1:${rr} dengan tingkat keyakinan <strong>${prob}%</strong>.`;
    }
  }

  // Fallback translations
  let translated = msg;
  translated = translated.replace('Bot starting up...', 'Bot sedang memulai sistem...');
  translated = translated.replace('Auto-trade is disabled', 'Sistem perdagangan otomatis (Auto-Trade) sedang dinonaktifkan.');
  translated = translated.replace('No candlestick data available', 'Data candlestick tidak tersedia di server.');
  translated = translated.replace('Waiting for data...', 'Menunggu data masuk...');
  translated = translated.replace('Scanning markets...', 'Sedang memindai pergerakan pasar...');

  return translated;
}

// Global Initialization
window.addEventListener('DOMContentLoaded', () => {
  // Add active state to nav-cockpit sidebar item
  const navCockpit = document.getElementById('nav-cockpit');
  if (navCockpit) navCockpit.classList.add('active');

  initCharts();

  // Liquidity Sweep Map period toggle buttons removed (both 24h & 3d stacked and visible simultaneously)
  
  // Initial Loads
  updateBotStatus();
  updateConnectionStatus();
  updateMarketExtras();
  setTimeout(updateMiniHeatmap, 500); // slight delay to let ECharts initialize size

  // Polling Schedulers
  setInterval(updateBotStatus, 3000);
  setInterval(updateMarketExtras, 5000);
  setInterval(updateConnectionStatus, 10000);
  setInterval(updateMiniHeatmap, 30000);
});
