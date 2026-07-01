// Initial load of sidebar minimize state (runs immediately to prevent flicker)
if (localStorage.getItem('sidebar-minimized') === 'true') {
  document.body.classList.add('sidebar-minimized');
}

const EXCHANGE_RATE = 16300; // 1 USD = 16300 IDR (Rp)

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
let latestJdaSignal = null;
let latestBidPercent = 50;
let latestAskPercent = 50;
let latestActiveTrade = null;

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

const formatIDR = (val) => {
  if (!val) return 'Rp 0';
  const valBs = val * EXCHANGE_RATE;
  const abs = Math.abs(valBs);
  let formatted = '';
  if (abs >= 1e9) formatted = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) formatted = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) formatted = (abs / 1e3).toFixed(2) + 'K';
  else formatted = abs.toFixed(2);
  return `${valBs < 0 ? '-' : ''}Rp ${formatted}`;
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
          fontSize: 15,
          offsetCenter: [0, '10%'],
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
    miniHeatmapChart24h = echarts.init(heatmapDom24h, 'dark', { renderer: 'canvas' });
  }
  const heatmapDom3d = document.getElementById('chart-mini-heatmap-3d');
  if (heatmapDom3d) {
    miniHeatmapChart3d = echarts.init(heatmapDom3d, 'dark', { renderer: 'canvas' });
  }
}

// Update Bot Status Layout
async function updateBotStatus() {
  try {
    const res = await fetch('/api/bot-status');
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const body = await res.json();
    const data = body.data;
    if (data) {
      data.whaleData = body.whaleData;
    }
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

    // Probability Breakdown details
    const breakdownEl = document.getElementById('prob-breakdown-details');
    if (breakdownEl && data.metrics?.probabilityBreakdown) {
      const b = data.metrics.probabilityBreakdown;
      const items = [];
      if (b.baseScore !== undefined) items.push(`Base: ${b.baseScore}`);
      if (b.poolVolume !== undefined) items.push(`Pool: +${b.poolVolume}`);
      if (b.rejection !== undefined) items.push(`Reject: ${b.rejection >= 0 ? '+' : ''}${b.rejection}`);
      if (b.oiChange !== undefined) items.push(`OI: ${b.oiChange >= 0 ? '+' : ''}${b.oiChange}`);
      if (b.spotCvd !== undefined) items.push(`CVD: ${b.spotCvd >= 0 ? '+' : ''}${b.spotCvd}`);
      if (b.trend !== undefined) items.push(`Trend: ${b.trend >= 0 ? '+' : ''}${b.trend}`);
      if (b.funding !== undefined) items.push(`FR: ${b.funding >= 0 ? '+' : ''}${b.funding}`);
      if (b.lsRatio !== undefined) items.push(`LSR: ${b.lsRatio >= 0 ? '+' : ''}${b.lsRatio}`);
      if (b.coinbasePremium !== undefined) items.push(`CB: ${b.coinbasePremium >= 0 ? '+' : ''}${b.coinbasePremium}`);
      if (b.depthDelta !== undefined) items.push(`Delta: ${b.depthDelta >= 0 ? '+' : ''}${b.depthDelta}`);
      if (b.whaleWall !== undefined) items.push(`Whale: ${b.whaleWall >= 0 ? '+' : ''}${b.whaleWall}`);
      if (b.liquidations !== undefined) items.push(`Liq: ${b.liquidations >= 0 ? '+' : ''}${b.liquidations}`);
      if (b.intensity !== undefined) items.push(`Intensity: ${b.intensity >= 0 ? '+' : ''}${b.intensity}`);
      breakdownEl.innerText = 'Prob Breakdown Score:\n' + items.join(' | ');
      breakdownEl.style.display = 'block';
    }

    // Orderbook update (or from endpoint /api/orderbook-data)
    fetchOrderbookRatio();

    // Render Active Position
    renderActivePosition();

    // Update JDA MTF Strategy metrics
    updateJdaMtfStatus();

  } catch (e) {
    console.error('[Cockpit] Bot Status update failed:', e.message);
  }
}

// Update JDA MTF Strategy Status Widget
async function updateJdaMtfStatus() {
  try {
    const res = await fetch('/api/jda-signal');
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const json = await res.json();
    const d = json.data;
    if (!d) return;
    latestJdaSignal = d; // Store globally

    // 1. Update Time
    const timeEl = document.getElementById('jda-mtf-update-time');
    if (timeEl) {
      timeEl.innerText = 'Updated: ' + new Date(d.fetchTime).toLocaleTimeString();
    }

    // 2. Bias & Conf
    const biasEl = document.getElementById('jda-card-bias');
    if (biasEl) {
      biasEl.innerText = `${d.marketBias} | ${d.conf}% (${d.confLevel})`;
      if (d.marketBias === 'BULLISH') {
        biasEl.className = 'jda-card-val text-bullish';
      } else if (d.marketBias === 'BEARISH') {
        biasEl.className = 'jda-card-val text-bearish';
      } else {
        biasEl.className = 'jda-card-val text-neutral';
      }
    }

    // 3. Phase
    const phaseEl = document.getElementById('jda-card-phase');
    if (phaseEl) {
      phaseEl.innerText = d.phase;
      if (d.phase.includes('BULL')) {
        phaseEl.className = 'jda-card-val text-bullish';
      } else if (d.phase.includes('BEAR')) {
        phaseEl.className = 'jda-card-val text-bearish';
      } else if (d.phase === 'SQUEEZE') {
        phaseEl.className = 'jda-card-val text-squeeze';
      } else {
        phaseEl.className = 'jda-card-val text-neutral';
      }
    }

    // 4. Dir Score
    const scoreEl = document.getElementById('jda-card-score');
    if (scoreEl) {
      const sign = d.dirScore >= 0 ? '+' : '';
      scoreEl.innerText = `${sign}${d.dirScore} (${d.aligned ? 'ALIGNED' : 'MIXED'})`;
      if (d.dirScore > 0) {
        scoreEl.className = 'jda-card-val text-bullish';
      } else if (d.dirScore < 0) {
        scoreEl.className = 'jda-card-val text-bearish';
      } else {
        scoreEl.className = 'jda-card-val text-neutral';
      }
    }

    // 5. EMA50 (4H) Filter
    const emaEl = document.getElementById('jda-card-ema');
    if (emaEl && d.emaFilter) {
      emaEl.innerText = `${d.emaFilter.value} (${d.emaFilter.status})`;
      if (d.emaFilter.status.includes('ABOVE')) {
        emaEl.className = 'jda-card-val text-bullish';
      } else {
        emaEl.className = 'jda-card-val text-bearish';
      }
    }

    // 6. ADX (15M) Filter
    const adxEl = document.getElementById('jda-card-adx');
    if (adxEl && d.adxFilter) {
      adxEl.innerText = `${d.adxFilter.value} (${d.adxFilter.status})`;
      if (d.adxFilter.status.includes('TRENDING')) {
        adxEl.className = 'jda-card-val text-bullish';
      } else {
        adxEl.className = 'jda-card-val text-bearish';
      }
    }

    // 7. EMA13/SMA50 (15M)
    const crossEl = document.getElementById('jda-card-cross');
    if (crossEl && d.crossFilter) {
      crossEl.innerText = d.crossFilter.status;
      if (d.crossFilter.status.includes('GOLDEN')) {
        crossEl.className = 'jda-card-val text-bullish';
      } else {
        crossEl.className = 'jda-card-val text-bearish';
      }
    }

    // 8. Final Call
    const finalCallEl = document.getElementById('jda-card-final-call');
    if (finalCallEl) {
      finalCallEl.innerText = d.finalCall || d.action;
      const isLong = d.action.includes('LONG');
      const isShort = d.action.includes('SHORT');
      if (isLong) {
        finalCallEl.className = 'jda-card-val text-bullish';
      } else if (isShort) {
        finalCallEl.className = 'jda-card-val text-bearish';
      } else {
        finalCallEl.className = 'jda-card-val text-squeeze';
      }
    }

    // 9. Aligned Status
    const alignedEl = document.getElementById('jda-card-aligned');
    if (alignedEl) {
      alignedEl.innerText = d.aligned ? 'ALIGNED ✅' : 'MIXED ⚠️';
      if (d.aligned) {
        alignedEl.className = 'jda-card-val text-bullish';
      } else {
        alignedEl.className = 'jda-card-val text-squeeze';
      }
    }

    // Timeframe trend details rendering
    const tfDetailsEl = document.getElementById('jda-tf-details');
    if (tfDetailsEl && d.timeframes) {
      let html = '';
      const intervals = ['15m', '1h', '4h', '1d', '1w'];
      intervals.forEach(tf => {
        const tData = d.timeframes[tf];
        if (!tData) return;
        const state = tData.state || 'RANGE';
        let color = 'var(--text-muted)';
        if (state.includes('BULL')) color = 'var(--accent-success)';
        else if (state.includes('BEAR')) color = 'var(--accent-alert)';
        
        const scoreVal = latestBotStatus?.metrics?.[`jdaV${tf}`] || tData.trend || 0;
        
        html += `
          <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 2px;">
            <div style="font-size: 7px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">${tf}</div>
            <div style="font-size: 8px; font-weight: 700; color: ${color}; margin-top: 2px;">${state}</div>
            <div style="font-size: 7px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 1px;">${scoreVal >= 0 ? '+' : ''}${scoreVal.toFixed(0)}</div>
          </div>
        `;
      });
      tfDetailsEl.innerHTML = html;
    }

    // Update Market Bias widget
    updateMarketBiasConclusion();

  } catch (e) {
    console.error('[Cockpit] JDA MTF Status update failed:', e.message);
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
  const oi1h = m.oiChange1h || 0;
  const oi15m = m.oiChange15m || 0;
  factors.oi.val.innerText = `1h: ${oi1h >= 0 ? '+' : ''}${oi1h.toFixed(2)}% | 15m: ${oi15m >= 0 ? '+' : ''}${oi15m.toFixed(2)}%`;
  factors.oi.pts.innerText = `${b.oiChange >= 0 ? '+' : ''}${b.oiChange !== undefined ? b.oiChange : 0}`;

  // CVD
  const cvd1h = m.spotCvd1h || 0;
  const cvd15m = m.spotCvd15m || 0;
  factors.cvd.val.innerText = `1h: ${formatUSD(cvd1h)} | 15m: ${formatUSD(cvd15m)}`;
  factors.cvd.val.className = `factor-val ${cvd15m >= 0 ? 'text-positive' : 'text-negative'}`;
  factors.cvd.pts.innerText = `${b.spotCvd >= 0 ? '+' : ''}${b.spotCvd !== undefined ? b.spotCvd : 0}`;

  // Funding Rate
  const fRate = m.fundingRate || 0;
  const pRate = m.premiumRate || 0;
  factors.funding.val.innerText = `Fnd: ${(fRate * 100).toFixed(4)}% | Prem: ${pRate.toFixed(4)}%`;
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
        latestBidPercent = bidPercent; // Store globally
        latestAskPercent = askPercent; // Store globally

        const elBid = document.getElementById('depth-bar-bid');
        const elAsk = document.getElementById('depth-bar-ask');
        const elRatio = document.getElementById('depth-ratio-text');
        const elUpdate = document.getElementById('orderbook-update-text');

        if (elBid) {
          elBid.style.width = `${bidPercent}%`;
          elBid.innerText = `BID ${bidPercent}%`;
        }
        if (elAsk) {
          elAsk.style.width = `${askPercent}%`;
          elAsk.innerText = `${askPercent}% ASK`;
        }
        if (elRatio) {
          elRatio.innerText = `${bidPercent}% / ${askPercent}%`;
        }
        if (elUpdate) {
          const age = body.data.timestamp ? new Date(body.data.timestamp).toLocaleTimeString() : 'N/A';
          elUpdate.innerText = `Last Scraped: ${age}`;
        }

        // Update Market Bias widget
        updateMarketBiasConclusion();
      }
    }
  } catch (e) {
    const elUpdate = document.getElementById('orderbook-update-text');
    if (elUpdate) elUpdate.innerText = `Orderbook Error: ${e.message}`;
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
    latestActiveTrade = activeTrade || null; // Store globally
    
    if (!activeTrade) {
      renderLsrBotStatusEmptyState();
      updateMarketBiasConclusion();
      return;
    }

    const titleEl = document.getElementById('active-position-title');
    if (titleEl) titleEl.innerText = 'Active Market Position';

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

    // Update Market Bias widget
    updateMarketBiasConclusion();

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

function renderSingleMiniChart(chartInstance, title, heatmapData, is3d = false) {
  if (!chartInstance) return;

  // Preserve the user's current zoom/pan across periodic data refreshes
  let savedZoomStart = null;
  let savedZoomEnd = null;
  try {
    const existingDataZoom = chartInstance.getOption().dataZoom;
    if (existingDataZoom && existingDataZoom[0]) {
      savedZoomStart = existingDataZoom[0].start;
      savedZoomEnd = existingDataZoom[0].end;
    }
  } catch (e) { /* chart not yet initialized with options */ }

  const xAxisData = heatmapData.xAxis || [];
  const yAxisData = heatmapData.yAxis || [];
  const minPrice = yAxisData.length > 0 ? parseFloat(yAxisData[0]) : null;
  const maxPrice = yAxisData.length > 0 ? parseFloat(yAxisData[yAxisData.length - 1]) : null;

  const candlestickSeries = heatmapData.series.find(s => s.type === 'candlestick');
  const heatmapSeries = heatmapData.series.find(s => s.type === 'heatmap');

  const maxIntensity = heatmapData.visualMap ? heatmapData.visualMap.max : 20000000;

  const option = {
    backgroundColor: 'transparent',
    title: {
      text: title,
      textStyle: { color: '#848E9C', fontSize: 11, fontWeight: 'bold' },
      left: 10,
      top: 0
    },
    axisPointer: {
      show: true,
      type: 'cross',
      lineStyle: { color: is3d ? '#F0B90B' : '#bfdc21', width: 1, type: 'dashed' }
    },
    tooltip: {
      show: true,
      trigger: 'item',
      className: 'echarts-custom-tooltip',
      alwaysShowContent: false,
      hideDelay: 0,
      transitionDuration: 0,
      backgroundColor: 'rgba(11, 14, 17, 0.95)',
      borderColor: 'rgba(255, 255, 255, 0.08)',
      borderWidth: 1,
      borderRadius: 8,
      padding: [10, 14],
      textStyle: {
        color: '#FFFFFF'
      },
      formatter: function (params) {
        if (params.seriesType === 'heatmap') {
          const xIdx = params.value[0];
          const yIdx = params.value[1];
          const val = parseFloat(params.value[2] || 0);
          const timeStr = xAxisData[xIdx] || '';
          const priceVal = parseFloat(yAxisData[yIdx] || 0);
          
          let levStr = '';
          if (val >= 1e9) levStr = (val / 1e9).toFixed(2) + 'B';
          else if (val >= 1e6) levStr = (val / 1e6).toFixed(2) + 'M';
          else if (val >= 1e3) levStr = (val / 1e3).toFixed(2) + 'K';
          else levStr = val.toFixed(2);

          const activeColor = is3d ? '#F0B90B' : '#bfdc21';
          return `
            <div style="font-family: Inter, system-ui, sans-serif; font-size: 11px; line-height: 1.6; color: #FFFFFF; min-width: 180px;">
              <div style="font-weight: bold; margin-bottom: 8px; color: #848E9C;">${timeStr}</div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${activeColor}; margin-right: 6px;"></span>Price</span>
                <span style="font-family: monospace; font-weight: bold; margin-left: 20px;">${Math.round(priceVal).toLocaleString()}</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${activeColor}; margin-right: 6px;"></span>Liquidation Leverage</span>
                <span style="font-family: monospace; font-weight: bold; margin-left: 20px;">$${levStr}</span>
              </div>
            </div>
          `;
        } else if (params.seriesType === 'candlestick') {
          const timeStr = params.name || '';
          const close = params.value[2]; // [open, close, lowest, highest]
          const activeColor = is3d ? '#F0B90B' : '#bfdc21';
          return `
            <div style="font-family: Inter, system-ui, sans-serif; font-size: 11px; line-height: 1.6; color: #FFFFFF; min-width: 140px;">
              <div style="font-weight: bold; margin-bottom: 8px; color: #848E9C;">${timeStr}</div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${activeColor}; margin-right: 6px;"></span>Price</span>
                <span style="font-family: monospace; font-weight: bold; margin-left: 20px;">${Math.round(close).toLocaleString()}</span>
              </div>
            </div>
          `;
        }
        return '';
      }
    },
    grid: {
      top: 20, bottom: 20, left: 55, right: 10,
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
        color: '#848E9C', fontSize: 10,
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
          color: '#848E9C', fontSize: 10,
          formatter: function (value) { return formatUSD(parseFloat(value)); }
        }
      },
      {
        type: 'value', scale: true, min: minPrice, max: maxPrice, show: false
      }
    ],
    visualMap: {
      show: false,
      seriesIndex: 0,
      min: 0,
      max: maxIntensity,
      inRange: {
        color: is3d ? [
          '#46035c', '#373d77', '#28738f', '#238c89',
          '#24a480', '#3ab56e', '#66c751', '#F0B90B'
        ] : [
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
        progressive: 0,
        progressiveThreshold: 3000,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
      },
      {
        name: 'BTC Price',
        type: 'candlestick',
        yAxisIndex: 1,
        data: candlestickSeries ? candlestickSeries.data.map(c => [
          parseFloat(c[0]), parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3])
        ]) : [],
        itemStyle: {
          color: is3d ? '#0ECB81' : '#32D74B',
          color0: is3d ? '#F6465D' : '#FF453A',
          borderColor: is3d ? '#0ECB81' : '#32D74B',
          borderColor0: is3d ? '#F6465D' : '#FF453A'
        }
      }
    ],
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'filter',
        start: savedZoomStart !== null ? savedZoomStart : Math.max(0, 100 - (72 / Math.max(xAxisData.length, 1)) * 100),
        end: savedZoomEnd !== null ? savedZoomEnd : 100
      }
    ]
  };

  chartInstance.setOption(option, true);
  chartInstance.resize();

  // Explicitly hide tooltip on mouse leave to prevent sticking
  const container = chartInstance.getDom();
  if (container && !container.dataset.hasMouseLeaveListener) {
    container.addEventListener('mouseleave', () => {
      hideAllChartTooltips();
    });
    container.dataset.hasMouseLeaveListener = 'true';
  }
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

      // Real sweep check (wick+close), matching server.js's wasReallySwept() —
      // a mere wick touch without close-through is NOT a sweep, so the "LIQ"
      // badge should only fire when the bot's own logic would also call it swept.
      // Candle format is [open, close, low, high] with NO embedded timestamp —
      // the real time label lives in the parallel heatmapData.xAxis array at
      // the same index, so we look up sweep time by index, not by candle[0].
      const candleCount = (cs && cs.data) ? cs.data.length : 0;
      const sweepLookbackStart = Math.max(0, candleCount - 40);
      const findSweepTime = (price, isAbove) => {
        for (let i = candleCount - 1; i >= sweepLookbackStart; i--) {
          const c = cs.data[i];
          const cClose = parseFloat(c[1]), cLow = parseFloat(c[2]), cHigh = parseFloat(c[3]);
          if (isNaN(cClose) || isNaN(cLow) || isNaN(cHigh)) continue;
          const matched = isAbove ? (cHigh >= price && cClose < price) : (cLow <= price && cClose > price);
          if (matched) return heatmapData.xAxis ? heatmapData.xAxis[i] : null;
        }
        return null;
      };
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

        // Check if price genuinely swept this level recently (wick+close, not just a touch)
        const liquidationTime = findSweepTime(price, isAbove);
        const isLiquidated = liquidationTime !== null;

        // Keep displaying the pool if it has active leverage OR if it was liquidated recently (using historical max value)
        let leverage = latestVal;
        if (isLiquidated && maxRecentVal > 0) {
          leverage = maxRecentVal;
        }

        if (leverage <= 0) return;

        const distancePercent = ((price - refPrice) / refPrice) * 100;
        levels.push({ price, leverage, distance: distancePercent, isAbove, isLiquidated, liquidationTime });
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
    renderSingleMiniChart(miniHeatmapChart24h, '24H SWEEP MAP', data, false);
    const hm24UpdEl = document.getElementById('heatmap-24h-update-time');
    if (hm24UpdEl) hm24UpdEl.innerText = new Date().toLocaleTimeString();
    if (data3d) {
      renderSingleMiniChart(miniHeatmapChart3d, '3D SWEEP MAP', data3d, true);
      const hm3dUpdEl = document.getElementById('heatmap-3d-update-time');
      if (hm3dUpdEl) hm3dUpdEl.innerText = new Date().toLocaleTimeString();
    }

    const renderPoolList = (pools, isAbove, maxLeverage = 1) => {
      if (pools.length === 0) {
        return '<div style="color:var(--text-muted);text-align:center;padding:6px;font-size:10px;">No pools detected</div>';
      }
      return pools.map((lvl, idx) => {
        const isLiq = lvl.isLiquidated;
        const rowStyle = isLiq ? 'opacity: 0.45;' : '';
        const priceColor = isLiq ? 'var(--text-muted)' : '#FFFFFF';
        const volColor = isLiq ? 'var(--text-muted)' : (isAbove ? '#bfdc21' : '#3ab56e');

        let intensityText = 'LOW';
        let intensityColor = '#848E9C';
        let intensityBg = 'rgba(255,255,255,0.05)';
        
        if (isLiq) {
          // xAxis label format is "30 Jun 2026, 20:45" — show just the HH:MM part
          const timePart = lvl.liquidationTime ? lvl.liquidationTime.split(', ').pop() : null;
          intensityText = timePart ? 'LIQ ' + timePart : 'LIQ';
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

        const badgeHtml = `<span style="display: inline-block; padding: 2px 4px; border-radius: 3px; font-size: 8px; font-weight: 700; border: 1px solid ${intensityColor}; background: ${intensityBg}; color: ${intensityColor}; text-transform: uppercase; white-space: nowrap;">${intensityText}</span>`;

        return `
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.02); padding: 4px 0; font-family: var(--font-mono); font-size: 10px; ${rowStyle}">
            <span style="width: 44px; text-align: left; font-weight: 600; color: ${priceColor};">$${Math.round(lvl.price).toLocaleString()}</span>
            <span style="width: 48px; text-align: center; color: ${volColor}; font-weight: 600;">$${formatIntensity(lvl.leverage)}</span>
            <span style="width: 62px; text-align: right; flex-shrink: 0;">${badgeHtml}</span>
          </div>
        `;
      }).join('');
    };

    const resContainer = document.getElementById('cockpit-resistance-pools');
    const supContainer = document.getElementById('cockpit-support-pools');
    if (resContainer) resContainer.innerHTML = renderPoolList(pools24h.above, true, pools24h.maxLeverage);
    if (supContainer) supContainer.innerHTML = renderPoolList(pools24h.below, false, pools24h.maxLeverage);

    // Helper to format values as $1M / $1,5M
    const formatLiqSum = (val) => {
      if (val === undefined || val === null) return '0';
      const abs = Math.abs(val);
      let formatted = '';
      if (abs >= 1e9) {
        const num = abs / 1e9;
        formatted = num % 1 === 0 ? num.toFixed(0) : num.toFixed(2);
        formatted += 'B';
      } else if (abs >= 1e6) {
        const num = abs / 1e6;
        formatted = num % 1 === 0 ? num.toFixed(0) : num.toFixed(1);
        formatted += 'M';
      } else if (abs >= 1e3) {
        const num = abs / 1e3;
        formatted = num % 1 === 0 ? num.toFixed(0) : num.toFixed(1);
        formatted += 'K';
      } else {
        formatted = abs.toFixed(0);
      }
      return formatted.replace('.', ',');
    };

    // Calculate 24H Pools ratio (visible Top 5) and total USD values per side
    const res24hSum = pools24h.above.reduce((sum, p) => sum + p.leverage, 0);
    const sup24hSum = pools24h.below.reduce((sum, p) => sum + p.leverage, 0);
    const total24h = res24hSum + sup24hSum;
    const sup24hPct = total24h > 0 ? Math.round((sup24hSum / total24h) * 100) : 50;
    const res24hPct = 100 - sup24hPct;
    const ratio24hEl = document.getElementById('liq-ratio-24h');
    if (ratio24hEl) {
      ratio24hEl.innerHTML = `<span style="color: var(--accent-success);">${sup24hPct}% - $${formatLiqSum(sup24hSum)}</span> <span style="color: var(--text-muted); margin: 0 4px;">/</span> <span style="color: var(--accent-alert);">${res24hPct}% - $${formatLiqSum(res24hSum)}</span>`;
    }

    const res3dContainer = document.getElementById('cockpit-resistance-pools-3d');
    const sup3dContainer = document.getElementById('cockpit-support-pools-3d');
    if (data3d) {
      if (res3dContainer) res3dContainer.innerHTML = renderPoolList(pools3d.above, true, pools3d.maxLeverage);
      if (sup3dContainer) sup3dContainer.innerHTML = renderPoolList(pools3d.below, false, pools3d.maxLeverage);
      
      // Calculate 3D Pools ratio (visible Top 5) and total USD values per side
      const res3dSum = pools3d.above.reduce((sum, p) => sum + p.leverage, 0);
      const sup3dSum = pools3d.below.reduce((sum, p) => sum + p.leverage, 0);
      const total3d = res3dSum + sup3dSum;
      const sup3dPct = total3d > 0 ? Math.round((sup3dSum / total3d) * 100) : 50;
      const res3dPct = 100 - sup3dPct;
      const ratio3dEl = document.getElementById('liq-ratio-3d');
      if (ratio3dEl) {
        ratio3dEl.innerHTML = `<span style="color: var(--accent-success);">${sup3dPct}% - $${formatLiqSum(sup3dSum)}</span> <span style="color: var(--text-muted); margin: 0 4px;">/</span> <span style="color: var(--accent-alert);">${res3dPct}% - $${formatLiqSum(res3dSum)}</span>`;
      }
    } else {
      if (res3dContainer) res3dContainer.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:6px;font-size:10px;">No 3D data cache yet...</div>';
      if (sup3dContainer) sup3dContainer.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:6px;font-size:10px;">No 3D data cache yet...</div>';
      const ratio3dEl = document.getElementById('liq-ratio-3d');
      if (ratio3dEl) ratio3dEl.innerHTML = '';
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
    
    // Immediately fetch bot status to update layout and breakdown details
    await updateBotStatus();
    
    // Trigger charts resize after layout adjustments
    triggerChartsResize();
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
    autoTradeToggle.checked = !newValue;
  } finally {
    isSavingSettings = false;
  }
});

// Trigger all charts to resize to fit their containers perfectly under layout changes
function triggerChartsResize() {
  const charts = [gaugeChart, miniHeatmapChart24h, miniHeatmapChart3d, equityCurveChart];
  charts.forEach(c => {
    if (c && typeof c.resize === 'function') {
      try { c.resize(); } catch (e) {}
    }
  });
  // Multiple timeouts to handle dynamic browser layout reflow/transitions
  setTimeout(() => {
    charts.forEach(c => {
      if (c && typeof c.resize === 'function') {
        try { c.resize(); } catch (e) {}
      }
    });
  }, 100);
  setTimeout(() => {
    charts.forEach(c => {
      if (c && typeof c.resize === 'function') {
        try { c.resize(); } catch (e) {}
      }
    });
  }, 300);
  setTimeout(() => {
    charts.forEach(c => {
      if (c && typeof c.resize === 'function') {
        try { c.resize(); } catch (e) {}
      }
    });
  }, 600);
}

// Window resize handler
window.addEventListener('resize', triggerChartsResize);

// Render LSR Bot Status when no active positions exist
function renderLsrBotStatusEmptyState() {
  const titleEl = document.getElementById('active-position-title');
  if (titleEl) titleEl.innerText = 'LSR Bot Status & Whale Flow';

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

      ${wickHtml}
    </div>
  `;
  fetchOrderbookRatio();
}

// Calculate overall market bias based on Cockpit indicators
function updateMarketBiasConclusion() {
  const container = document.getElementById('market-bias-conclusion-content');
  if (!container) return;

  // 1. JDA Score (Max 30)
  let jdaScore = 0;
  let jdaValText = 'NEUTRAL';
  let jdaScoreText = '0';
  if (latestJdaSignal) {
    const bias = latestJdaSignal.marketBias || 'NEUTRAL';
    const conf = latestJdaSignal.conf || 0;
    if (bias === 'BULLISH') {
      jdaScore = 30;
      jdaValText = `BULLISH (${conf}%)`;
      jdaScoreText = '+30';
    } else if (bias === 'BEARISH') {
      jdaScore = -30;
      jdaValText = `BEARISH (${conf}%)`;
      jdaScoreText = '-30';
    } else {
      jdaValText = `NEUTRAL (${conf}%)`;
      jdaScoreText = '0';
    }
  }

  // 2. Whale Score (Max 25)
  let whaleScore = 0;
  let whaleValText = 'NEUTRAL';
  let whaleScoreText = '0';
  if (latestBotStatus && latestBotStatus.whaleData) {
    const w = latestBotStatus.whaleData;
    const signal = w.signal || 'NEUTRAL';
    const netFlow = w.netFlow || 0;
    
    // Format net flow for display
    let flowStr = formatUSD(netFlow);
    if (netFlow > 0) flowStr = '+' + flowStr;

    if (signal === 'ACCUMULATION' || netFlow > 0) {
      whaleScore = 25;
      whaleValText = `ACCUMULATION (${flowStr})`;
      whaleScoreText = '+25';
    } else if (signal === 'DISTRIBUTION' || netFlow < 0) {
      whaleScore = -25;
      whaleValText = `DISTRIBUTION (${flowStr})`;
      whaleScoreText = '-25';
    } else {
      whaleValText = `NEUTRAL (${flowStr})`;
      whaleScoreText = '0';
    }
  }

  // 3. Orderbook Ratio Score (Max 20)
  let obScore = 0;
  let obValText = '50% / 50%';
  let obScoreText = '0';
  if (latestBidPercent !== undefined && latestAskPercent !== undefined) {
    obValText = `${latestBidPercent}% Bids / ${latestAskPercent}% Asks`;
    obScore = (latestBidPercent - 50) * 2; // e.g. 55% Bids -> (55-50)*2 = +10. 40% Bids -> (40-50)*2 = -20
    obScore = Math.max(-20, Math.min(20, obScore));
    obScoreText = obScore >= 0 ? `+${obScore.toFixed(0)}` : obScore.toFixed(0);
  }

  // 4. Reversal Probability & Pool / Position (Max 25)
  let poolScore = 0;
  let poolValText = 'NO SIGNAL';
  let poolScoreText = '0';
  
  if (latestActiveTrade) {
    const dir = latestActiveTrade.direction;
    if (dir === 'LONG') {
      poolScore = 25;
      poolValText = 'POSISI LONG AKTIF';
      poolScoreText = '+25';
    } else if (dir === 'SHORT') {
      poolScore = -25;
      poolValText = 'POSISI SHORT AKTIF';
      poolScoreText = '-25';
    }
  } else if (latestBotStatus) {
    const status = latestBotStatus;
    const poolSide = status.nearestPoolSide || '--';
    const probVal = status.reversalProbabilityPreview || status.metrics?.reversalProbability || 0;
    const poolPrice = status.nearestPool ? '$' + Math.round(status.nearestPool).toLocaleString() : '--';

    if (poolSide === 'SUPPORT') {
      // Reversal from support means price goes UP (BULLISH)
      poolScore = (probVal / 100) * 25;
      poolValText = `SUPPORT POOL ${poolPrice} (Prob ${probVal}%)`;
      poolScoreText = `+${poolScore.toFixed(1)}`;
    } else if (poolSide === 'RESISTANCE') {
      // Reversal from resistance means price goes DOWN (BEARISH)
      poolScore = -(probVal / 100) * 25;
      poolValText = `RESIST POOL ${poolPrice} (Prob ${probVal}%)`;
      poolScoreText = `-${Math.abs(poolScore).toFixed(1)}`;
    } else {
      poolValText = `NO POOL NEAREST`;
      poolScoreText = '0';
    }
  }

  // Sum total score (-100 to +100)
  const totalScore = jdaScore + whaleScore + obScore + poolScore;
  
  // Convert score to percentages (clamped between 0 and 100)
  let longPercent = Math.round(50 + (totalScore / 2));
  longPercent = Math.max(0, Math.min(100, longPercent));
  const shortPercent = 100 - longPercent;

  // Determine dominant bias
  let biasText = 'NEUTRAL';
  let biasColor = 'var(--text-muted)';
  let biasDesc = 'Pasar sedang seimbang (Konsolidasi/Neutral).';
  
  if (longPercent > 55) {
    biasText = 'CENDERUNG LONG';
    biasColor = 'var(--accent-success)';
    biasDesc = `Indikator dominan menunjukkan kekuatan beli (${longPercent}% LONG).`;
  } else if (shortPercent > 55) {
    biasText = 'CENDERUNG SHORT';
    biasColor = 'var(--accent-alert)';
    biasDesc = `Indikator dominan menunjukkan tekanan jual (${shortPercent}% SHORT).`;
  }

  // Render content
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; justify-content: space-between; flex: 1; height: 100%; gap: 10px;">
      
      <!-- Dominant Verdict Row -->
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 11px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Arah Bias</span>
        <span style="font-size: 18px; font-weight: 700; color: ${biasColor}; letter-spacing: 0.5px;">
          ${biasText} ${biasText.includes('LONG') ? longPercent : shortPercent}%
        </span>
      </div>

      <!-- Combined Progress Bar -->
      <div style="background: rgba(255,255,255,0.05); height: 22px; border-radius: 6px; overflow: hidden; width: 100%; display: flex; border: 1px solid var(--border-color); position: relative;">
        <!-- LONG BAR -->
        <div style="width: ${longPercent}%; background: rgba(14, 203, 129, 0.25); border-right: 1px solid rgba(14, 203, 129, 0.4); display: flex; align-items: center; padding-left: 8px; font-size: 10px; font-weight: 700; color: var(--accent-success); transition: width 0.3s ease; white-space: nowrap; overflow: hidden;">
          LONG ${longPercent}%
        </div>
        <!-- SHORT BAR -->
        <div style="width: ${shortPercent}%; background: rgba(246, 70, 93, 0.25); display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; font-size: 10px; font-weight: 700; color: var(--accent-alert); transition: width 0.3s ease; white-space: nowrap; overflow: hidden;">
          ${shortPercent}% SHORT
        </div>
      </div>

      <div style="font-size: 11px; color: #fff; font-weight: 500; text-align: center; margin-top: -2px; line-height: 1.3;">
        ${biasDesc}
      </div>

      <!-- Breakdown Table (Indonesian) -->
      <div style="display: flex; flex-direction: column; gap: 4px; font-size: 10px; background: rgba(255,255,255,0.01); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 10px; margin-top: 2px;">
        <!-- JDA -->
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.02); padding-bottom: 4px; align-items: center;">
          <span style="color: var(--text-muted);">JDA MTF Strategy (30%):</span>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="color: #fff; font-weight: 500;">${jdaValText}</span>
            <span style="font-family: var(--font-mono); font-weight: 700; color: ${jdaScore > 0 ? 'var(--accent-success)' : jdaScore < 0 ? 'var(--accent-alert)' : 'var(--text-muted)'}">${jdaScoreText}</span>
          </div>
        </div>
        <!-- Whale -->
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.02); padding-bottom: 4px; align-items: center;">
          <span style="color: var(--text-muted);">Whale Flow 15m (25%):</span>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="color: #fff; font-weight: 500;">${whaleValText}</span>
            <span style="font-family: var(--font-mono); font-weight: 700; color: ${whaleScore > 0 ? 'var(--accent-success)' : whaleScore < 0 ? 'var(--accent-alert)' : 'var(--text-muted)'}">${whaleScoreText}</span>
          </div>
        </div>
        <!-- Orderbook -->
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.02); padding-bottom: 4px; align-items: center;">
          <span style="color: var(--text-muted);">Orderbook Depth 1% (20%):</span>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="color: #fff; font-weight: 500;">${obValText}</span>
            <span style="font-family: var(--font-mono); font-weight: 700; color: ${obScore > 0 ? 'var(--accent-success)' : obScore < 0 ? 'var(--accent-alert)' : 'var(--text-muted)'}">${obScoreText}</span>
          </div>
        </div>
        <!-- LSR / Reversal -->
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--text-muted);">LSR Reversal & Posisi (25%):</span>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="color: #fff; font-weight: 500;">${poolValText}</span>
            <span style="font-family: var(--font-mono); font-weight: 700; color: ${poolScore > 0 ? 'var(--accent-success)' : poolScore < 0 ? 'var(--accent-alert)' : 'var(--text-muted)'}">${poolScoreText}</span>
          </div>
        </div>
      </div>
      
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

  // Sidebar Minimize Toggle
  const btnToggle = document.getElementById('btn-sidebar-toggle');
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-minimized');
      const isMinimized = document.body.classList.contains('sidebar-minimized');
      localStorage.setItem('sidebar-minimized', isMinimized ? 'true' : 'false');
      // Resize charts to fit new layout width
      triggerChartsResize();
    });
  }

  initCharts();

  // Liquidity Sweep Map period toggle buttons removed (both 24h & 3d stacked and visible simultaneously)
  
  // Initial Loads
  updateBotStatus();
  updateConnectionStatus();
  updateMarketExtras();
  updateCoinGlassSummary();
  updateSweepHistory();
  setTimeout(updateMiniHeatmap, 500); // slight delay to let ECharts initialize size

  // Clear Sweep History Button Listener
  const btnClearSweep = document.getElementById('btn-clear-sweep-history');
  if (btnClearSweep) {
    btnClearSweep.addEventListener('click', async () => {
      if (confirm('Are you sure you want to clear all sweep logs?')) {
        try {
          const res = await fetch('/api/sweep-history/clear', { method: 'POST' });
          if (res.ok) {
            updateSweepHistory();
          }
        } catch (e) {
          console.error('Failed to clear sweep history:', e);
        }
      }
    });
  }

  // Polling Schedulers
  setInterval(updateBotStatus, 3000);
  setInterval(updateSweepHistory, 5000);
  setInterval(updateMarketExtras, 5000);
  setInterval(updateConnectionStatus, 10000);
  setInterval(updateMiniHeatmap, 30000);
  setInterval(updateCoinGlassSummary, 30000);
});

// Fetch and display CoinGlass verdict, narrative and walls inside cockpit
async function updateCoinGlassSummary() {
  const verdictBadge = document.getElementById('cockpit-summary-verdict');
  const explanationEl = document.getElementById('cockpit-summary-explanation');
  const summaryContainer = document.getElementById('cockpit-coinglass-summary');
  const wallsEl = document.getElementById('cockpit-summary-walls');

  if (!summaryContainer) return;

  try {
    const res = await fetch('/api/coinglass-summary');
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const body = await res.json();

    if (body.success) {
      // 1. Verdict Badge
      if (verdictBadge) {
        verdictBadge.innerText = body.verdict.toUpperCase();
        let color = '#F0B90B';
        let bg = 'rgba(240, 185, 11, 0.15)';
        if (body.verdict.includes('BULLISH')) {
          color = '#0ECB81';
          bg = 'rgba(14, 203, 129, 0.15)';
        } else if (body.verdict.includes('BEARISH')) {
          color = '#F6465D';
          bg = 'rgba(246, 70, 93, 0.15)';
        }
        verdictBadge.style.color = color;
        verdictBadge.style.borderColor = color;
        verdictBadge.style.background = bg;
        verdictBadge.style.display = 'inline-block';
      }

      // 2. Explanation (bullet points only, strip the whale orders div)
      if (explanationEl) {
        let expHtml = body.explanation || 'Tidak ada analisis deskriptif saat ini.';
        const splitIdx = expHtml.indexOf('<div style="margin-top: 10px;');
        if (splitIdx !== -1) {
          expHtml = expHtml.substring(0, splitIdx);
        }
        explanationEl.innerHTML = expHtml;
      }

      // 3. Whale Orders Text (Column 3)
      if (body.metrics?.whaleOrders) {
        const wo = body.metrics.whaleOrders;
        const buyListStr = wo.top3Buy && wo.top3Buy.length > 0 
          ? wo.top3Buy.map(o => `<b>$${o.price.toLocaleString()}</b> (${o.valueUsdFormatted} di ${o.exchange})`).join(', ')
          : 'Tidak ada';
        
        const sellListStr = wo.top3Sell && wo.top3Sell.length > 0 
          ? wo.top3Sell.map(o => `<b>$${o.price.toLocaleString()}</b> (${o.valueUsdFormatted} di ${o.exchange})`).join(', ')
          : 'Tidak ada';
          
        const buyOrdersTextEl = document.getElementById('whale-buy-orders-text');
        const sellOrdersTextEl = document.getElementById('whale-sell-orders-text');
        
        if (buyOrdersTextEl) buyOrdersTextEl.innerHTML = `📢 <b>Top 3 Whale Buy (Bid):</b> ${buyListStr}`;
        if (sellOrdersTextEl) sellOrdersTextEl.innerHTML = `📢 <b>Top 3 Whale Sell (Ask):</b> ${sellListStr}`;
      }

      // 4. Render Bids & Asks Walls (Column 3)
      if (wallsEl && body.metrics) {
        const topBids = body.metrics.topWalls?.bids || [];
        const topAsks = body.metrics.topWalls?.asks || [];
        
        if (topBids.length > 0 || topAsks.length > 0) {
          const renderWallRow = (wall, isBid) => {
            const color = isBid ? '#0ECB81' : '#F6465D';
            return `<div style="display: flex; justify-content: space-between; font-size: 9.5px; margin-bottom: 2px;">
              <span style="color: ${color}; font-weight: 700;">$${Math.round(wall.price).toLocaleString()}</span>
              <span style="color: #fff;">${parseFloat(wall.quantity).toFixed(1)} BTC</span>
            </div>`;
          };
          
          const bidsHtml = topBids.slice(0, 2).map(b => renderWallRow(b, true)).join('');
          const asksHtml = topAsks.slice(0, 2).map(a => renderWallRow(a, false)).join('');

          wallsEl.innerHTML = `
            <div>
              <div style="font-size: 8px; color: #0ECB81; font-weight: 700; margin-bottom: 4px;">🟢 BIDS WALLS</div>
              ${bidsHtml || '<div style="color:var(--text-muted);font-size:9px;">None</div>'}
            </div>
            <div>
              <div style="font-size: 8px; color: #F6465D; font-weight: 700; margin-bottom: 4px;">🔴 ASKS WALLS</div>
              ${asksHtml || '<div style="color:var(--text-muted);font-size:9px;">None</div>'}
            </div>
          `;
          wallsEl.style.display = 'grid';
        } else {
          wallsEl.style.display = 'none';
        }
      }

      summaryContainer.style.display = 'block';
    }
  } catch (e) {
    console.error('[Cockpit] Failed to load CoinGlass summary:', e.message);
  }
}

// Fetch and update Liquidation Sweep & Reversal Event Log table
async function updateSweepHistory() {
  const tbody = document.getElementById('sweep-history-tbody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/sweep-history');
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const history = await res.json();

    const slUpdEl = document.getElementById('sweep-log-update-time');
    if (slUpdEl) slUpdEl.innerText = new Date().toLocaleTimeString();

    if (!Array.isArray(history) || history.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; color: var(--text-muted);">No sweep events logged yet. Scanning...</td>
        </tr>
      `;
      return;
    }

    let html = '';
    history.forEach(item => {
      const dateStr = new Date(item.timestamp).toLocaleString();
      const symbol = 'BTCUSDT';
      
      // Determine side/direction
      let direction = item.phase || 'UNKNOWN';
      let dirClass = 'text-muted';
      if (direction.includes('LONG') || direction.includes('SUPPORT') || item.nearestPoolSide === 'SUPPORT' || item.nearestPoolSide === 'low') {
        direction = 'LONG';
        dirClass = 'text-positive';
      } else if (direction.includes('SHORT') || direction.includes('RESISTANCE') || item.nearestPoolSide === 'RESISTANCE' || item.nearestPoolSide === 'high') {
        direction = 'SHORT';
        dirClass = 'text-alert';
      }

      // Volume formatting
      let volStr = '--';
      if (item.nearestPoolVolume) {
        const vol = parseFloat(item.nearestPoolVolume);
        if (vol >= 1000000) {
          volStr = `$${(vol / 1000000).toFixed(2)}M`;
        } else if (vol >= 1000) {
          volStr = `$${(vol / 1000).toFixed(1)}K`;
        } else {
          volStr = `$${vol.toFixed(0)}`;
        }
      }

      // Distance
      let distStr = '--';
      if (item.nearestPoolDistance) {
        distStr = typeof item.nearestPoolDistance === 'number' 
          ? `${item.nearestPoolDistance.toFixed(2)}%` 
          : String(item.nearestPoolDistance);
      }

      // Reversal Probability
      let probStr = '0.00%';
      let prob = null;
      if (item.sweepCandidate && typeof item.sweepCandidate.prob === 'number') {
        prob = item.sweepCandidate.prob;
      } else if (item.probabilityBreakdown && typeof item.probabilityBreakdown.score === 'number') {
        prob = item.probabilityBreakdown.score;
      } else {
        // Try parsing from the message if available
        const match = item.message && item.message.match(/probability is (\d+(\.\d+)?)%/);
        if (match) {
          prob = parseFloat(match[1]);
        }
      }
      if (prob !== null) {
        probStr = `${prob.toFixed(2)}%`;
      }

      // Nearest Pool Price — formatted with side color
      let priceStr = '--';
      let priceColor = '#848E9C';
      if (item.nearestPool) {
        const price = parseFloat(item.nearestPool);
        if (!isNaN(price)) {
          priceStr = '$' + price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
          priceColor = item.nearestPoolSide === 'RESISTANCE' ? '#F6465D' : '#0ECB81';
        }
      }

      // Phase badge
      const phaseColors = {
        'STANDBY':          'background:rgba(132,142,156,.15);color:#848E9C;',
        'ALERT':            'background:rgba(255,159,10,.18);color:#FF9F0A;',
        'SWEEP_DETECTED':   'background:rgba(14,203,129,.18);color:#0ECB81;',
        'TRADE_EXECUTED':   'background:rgba(0,144,255,.18);color:#0090FF;',
        'SWEEP_REJECTED':   'background:rgba(246,70,93,.18);color:#F6465D;',
        'CONFLICTING_SWEEP':'background:rgba(255,107,107,.15);color:#FF6B6B;',
        'COOLDOWN':         'background:rgba(191,90,242,.18);color:#BF5AF2;',
        'MAX_ACTIVE':       'background:rgba(255,214,10,.15);color:#FFD60A;',
        'POOL_CHANGED':     'background:rgba(90,200,250,.15);color:#5AC8FA;',
        'DISABLED':         'background:rgba(99,99,102,.12);color:#636366;',
      };
      const triggerStr   = item.phase || 'SCANNING';
      const triggerStyle = phaseColors[triggerStr] || 'background:rgba(0,229,255,.15);color:#00E5FF;';

      // Message — highlight skip/reject reasons
      let messageHtml = item.message || '';
      if (messageHtml.includes('blocked') || messageHtml.includes('REJECTED') || messageHtml.includes('Skipping')) {
        messageHtml = `<span style="color:#FF9F0A;">${messageHtml}</span>`;
      } else if (messageHtml.includes('CONSUMED') || messageHtml.includes('RECALCULATED') || messageHtml.includes('REPLACED')) {
        messageHtml = `<span style="color:#5AC8FA;">${messageHtml}</span>`;
      }

      html += `
        <tr>
          <td style="white-space:nowrap;color:#636366;font-size:11px;">${dateStr}</td>
          <td style="font-weight:600;color:#848E9C;font-size:11px;">${symbol}</td>
          <td><span class="${dirClass}" style="font-weight:700;">${direction}</span></td>
          <td style="color:#00d2ff;font-weight:600;font-family:var(--font-mono);">${volStr}</td>
          <td style="color:${priceColor};font-weight:700;font-family:var(--font-mono);font-size:13px;">${priceStr}</td>
          <td style="color:#F0B90B;font-family:var(--font-mono);">${distStr}</td>
          <td style="font-weight:700;color:${prob !== null && prob >= 65 ? '#0ECB81' : prob !== null && prob >= 50 ? '#F0B90B' : '#848E9C'};">${probStr}</td>
          <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;${triggerStyle}">${triggerStr.replace(/_/g,' ')}</span></td>
          <td style="font-size:11px;max-width:400px;white-space:normal;line-height:1.4;" title="${(item.message||'').replace(/"/g,"'")}">${messageHtml}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  } catch (err) {
    console.error('Failed to update sweep history:', err);
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: var(--accent-alert);">Error loading sweep logs: ${err.message}</td>
      </tr>
    `;
  }
}

// Manual chart refresh helper
async function triggerManualRefresh(btnElement) {
  if (!btnElement) return;
  const icon = btnElement.querySelector('.refresh-icon');
  if (!icon || icon.classList.contains('spinning')) return;

  icon.classList.add('spinning');
  try {
    await updateMiniHeatmap();
  } catch (err) {
    console.error('Manual refresh failed:', err);
  } finally {
    setTimeout(() => {
      icon.classList.remove('spinning');
    }, 600);
  }
}

// Global function to forcefully hide all tooltips
function hideAllChartTooltips() {
  if (miniHeatmapChart24h) {
    try { miniHeatmapChart24h.dispatchAction({ type: 'hideTip' }); } catch(e){}
  }
  if (miniHeatmapChart3d) {
    try { miniHeatmapChart3d.dispatchAction({ type: 'hideTip' }); } catch(e){}
  }
  const globalTooltips = document.querySelectorAll('.echarts-custom-tooltip, .echarts-tooltip');
  globalTooltips.forEach(el => {
    el.style.display = 'none';
    el.style.opacity = '0';
  });
  const allDivs = document.querySelectorAll('div');
  allDivs.forEach(div => {
    if (div.id === 'bell-dropdown' || div.closest('#bell-dropdown')) return;
    if (div.style.position === 'absolute' && (div.innerHTML.includes('Liquidation Leverage') || div.innerHTML.includes('Price'))) {
      div.style.display = 'none';
      div.style.opacity = '0';
    }
  });
}

// Clear sticking tooltips when mouse goes out of charts
document.addEventListener('mousemove', (e) => {
  const inChart = e.target.closest('#chart-mini-heatmap-24h') || 
                  e.target.closest('#chart-mini-heatmap-3d') || 
                  e.target.closest('.echarts-custom-tooltip') || 
                  e.target.closest('.echarts-tooltip') ||
                  e.target.closest('.btn-chart-refresh');
  if (!inChart) {
    hideAllChartTooltips();
  }
});

// Also clear tooltips when mouse leaves the parent widget cards
document.addEventListener('DOMContentLoaded', () => {
  const card24h = document.querySelector('.w-mini-heatmap-24h');
  const card3d = document.querySelector('.w-mini-heatmap-3d');
  if (card24h) {
    card24h.addEventListener('mouseleave', hideAllChartTooltips);
  }
  if (card3d) {
    card3d.addEventListener('mouseleave', hideAllChartTooltips);
  }
});


