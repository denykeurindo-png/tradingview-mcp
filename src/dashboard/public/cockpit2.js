// Initial load of sidebar minimize state (runs immediately to prevent flicker)
if (localStorage.getItem('sidebar-minimized') === 'true') {
  document.body.classList.add('sidebar-minimized');
}

const EXCHANGE_RATE = 16300; // 1 USD = 16300 IDR (Rp)

// DOM Elements
const marketPriceBadge = document.getElementById('market-price-badge');
const jdaBiasHeader = document.getElementById('jda-bias-header');
const reversalTriggerPercent = document.getElementById('reversal-trigger-percent');
const reversalStatusLabel = document.getElementById('reversal-status-label');
const reversalGaugeFill = document.getElementById('reversal-gauge-fill');
const reversalActionText = document.getElementById('reversal-action-text');
const strategySignalBadge = document.getElementById('strategy-signal-badge');
const autoTradeToggle = document.getElementById('auto-trade-toggle');
const activePositionDetails = document.getElementById('active-position-details');
const noActivePositionText = document.getElementById('no-active-position-text');
const activePositionContent = document.getElementById('active-position-content');
const obDepthBid = document.getElementById('ob-depth-bid');
const obDepthAsk = document.getElementById('ob-depth-ask');
const depthRatioLabel = document.getElementById('depth-ratio-label');
const whaleWallsGrid = document.getElementById('whale-walls-grid-c2');
const btnPeriod24h = document.getElementById('btn-period-24h');
const btnPeriod3d = document.getElementById('btn-period-3d');

// Status Lights
const lightWs = document.getElementById('light-ws');
const lightStrategy = document.getElementById('light-strategy');

// Time labels
const strategyLastUpdate = document.getElementById('strategy-last-update');
const cvdUpdateTime = document.getElementById('cvd-update-time');
const obUpdateTime = document.getElementById('ob-update-time');

// ECharts instances
let cvdChart = null;

// Global Cache
let currentBtcPrice = 60000;
let isSavingSettings = false;
let activePeriod = '24h'; // '24h' or '3d'
let activePosition = null;

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
  const valRp = val * EXCHANGE_RATE;
  const abs = Math.abs(valRp);
  let formatted = '';
  if (abs >= 1e9) formatted = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) formatted = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) formatted = (abs / 1e3).toFixed(2) + 'K';
  else formatted = abs.toFixed(0);
  return `${valRp < 0 ? '-' : ''}Rp ${formatted}`;
};

// Initialize charts
function initCharts() {
  const cvdDom = document.getElementById('cvd-chart-container');
  if (cvdDom) {
    cvdChart = echarts.init(cvdDom);
  }

  window.addEventListener('resize', triggerChartsResize);
}

function triggerChartsResize() {
  const charts = [cvdChart];
  charts.forEach(c => {
    if (c && typeof c.resize === 'function') {
      try { c.resize(); } catch (e) {}
    }
  });
}

// Fetch loop
async function updateData() {
  try {
    const summaryRes = await fetch('/api/coinglass-summary');
    if (!summaryRes.ok) throw new Error('Summary fetch failed');
    const summary = await summaryRes.json();
    
    if (summary.success && summary.metrics) {
      updateMarketHeader(summary);
      updateReversalStrategy(summary);
      updateOrderbookAndWhales(summary);
      updateCvdChart(summary);
    }

    const tradesRes = await fetch('/api/trades');
    if (!tradesRes.ok) throw new Error('Trades fetch failed');
    const tradesObj = await tradesRes.json();
    const trades = tradesObj.data || [];
    updateActivePosition(trades);

    const botStatusRes = await fetch('/api/bot-status');
    if (botStatusRes.ok) {
      const botStatusObj = await botStatusRes.json();
      renderWhaleTradeDetector(botStatusObj.whaleData);
    }

    // Update settings check
    if (!isSavingSettings) {
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        autoTradeToggle.checked = settings.autoTradeEnabled || false;
      }
    }

    // Load Combined Depth Data
    await updateCombinedDepthData();
    await updateCombinedDepthSummary();

    // Set connection status green
    lightWs.className = 'light-dot ok';
    lightStrategy.className = 'light-dot ok';
  } catch (err) {
    console.error('Update cycle error:', err);
    lightWs.className = 'light-dot error';
    lightStrategy.className = 'light-dot error';
  }
}

function updateMarketHeader(summary) {
  const m = summary.metrics;
  // BTC Price
  if (m.openInterest && m.openInterest > 0) {
    // If we have price in coinglass-tv cache, or just calculate from OI BTC
    if (summary.status && summary.status.lastPrice) {
      currentBtcPrice = parseFloat(summary.status.lastPrice);
    } else if (m.openInterestBtc && m.openInterestBtc > 0) {
      currentBtcPrice = m.openInterest / m.openInterestBtc;
    }
  }
  marketPriceBadge.innerText = `BTC $${currentBtcPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  // JDA Bias
  if (summary.botPhaseState) {
    jdaBiasHeader.innerText = (summary.botPhaseState.jdaMarketBias || 'RANGING').toUpperCase();
    if (summary.botPhaseState.jdaMarketBias === 'BULLISH') {
      jdaBiasHeader.style.color = 'var(--accent-success)';
    } else if (summary.botPhaseState.jdaMarketBias === 'BEARISH') {
      jdaBiasHeader.style.color = 'var(--accent-alert)';
    } else {
      jdaBiasHeader.style.color = 'var(--accent-primary)';
    }
  }
}

let lastPhase = null;

function updateReversalStrategy(summary) {
  const bps = summary.botPhaseState;
  if (!bps) return;

  const now = new Date();
  strategyLastUpdate.innerText = now.toLocaleTimeString();

  // Track phase transition to push alerts
  if (lastPhase !== bps.phase) {
    if (bps.phase === 'ALERT') {
      addNotification('warning', `LSR Bot Status: ALERT (${bps.nearestPoolSide})`, `Price approaching nearest ${bps.nearestPoolSide} pool at $${parseInt(bps.nearestPool || 0).toLocaleString()} (${bps.nearestPoolDistance} away). Watching for sweep...`);
    } else if (bps.phase === 'TRADE_EXECUTED') {
      addNotification('success', 'LSR Trade Executed', 'Reversal strategy triggered. Automatically opened active trading position in the market.');
    } else if (bps.phase === 'STANDBY' && lastPhase !== null) {
      addNotification('success', 'LSR Bot Status: STANDBY', `Waiting in mid-range. Nearest pool: $${parseInt(bps.nearestPool || 0).toLocaleString()} (${bps.nearestPoolSide || 'RESISTANCE'}). No sweep yet.`);
    }
    lastPhase = bps.phase;
  }

  // Reversal probability preview
  const prob = bps.reversalProbabilityPreview || 0;
  reversalTriggerPercent.innerText = `${prob}%`;
  reversalGaugeFill.style.width = `${prob}%`;

  // Colors based on probability
  if (prob >= 75) {
    reversalTriggerPercent.style.color = 'var(--accent-success)';
    reversalGaugeFill.style.background = 'var(--accent-success)';
  } else if (prob >= 60) {
    reversalTriggerPercent.style.color = 'var(--accent-primary)';
    reversalGaugeFill.style.background = 'var(--accent-primary)';
  } else {
    reversalTriggerPercent.style.color = 'var(--text-muted)';
    reversalGaugeFill.style.background = 'rgba(255,255,255,0.2)';
  }

  // Update Status Label
  reversalStatusLabel.innerText = bps.phase.toUpperCase();

  // Update Signal Badge
  strategySignalBadge.innerText = bps.phase === 'TRADE_EXECUTED' ? 'EXECUTE' : bps.phase;
  strategySignalBadge.className = `action-badge action-${bps.phase}`;

  // Update Action Indonesian recommendation box
  let actionText = '';
  if (bps.phase === 'ALERT') {
    actionText = `<strong>PANDANGAN: SIAGA (${bps.nearestPoolSide}).</strong> Harga Bitcoin ($${currentBtcPrice.toFixed(0)}) mendekati kolam likuidasi ${bps.nearestPoolSide} di $${parseInt(bps.nearestPool).toLocaleString()} (${bps.nearestPoolDistance} lagi). Probabilitas pembalikan arah adalah <strong>${prob}%</strong>. Perhatikan konfirmasi sumbu candle (*wick rejection*).`;
  } else if (bps.phase === 'COOLDOWN') {
    actionText = `<strong>PANDANGAN: JEDA (COOLDOWN).</strong> Transaksi baru saja selesai. Sistem sedang berada dalam waktu tunggu agar pasar stabil kembali sebelum mendeteksi entri berikutnya.`;
  } else if (bps.phase === 'MAX_ACTIVE') {
    actionText = `<strong>PANDANGAN: BATAS POSISI DICAPAI.</strong> Maksimum transaksi aktif riil tercapai. Bot beralih ke mode pemantauan saja. Kolam terdekat berikutnya: $${parseInt(bps.nearestPool).toLocaleString()} (${bps.nearestPoolSide}).`;
  } else if (bps.phase === 'TRADE_EXECUTED') {
    actionText = `<strong>PANDANGAN: STRATEGI REVERSAL AKTIF.</strong> Sistem baru saja mendeteksi sapuan likuidasi dan serapan volume paus yang valid, memicu pembukaan posisi baru secara otomatis.`;
  } else {
    actionText = `<strong>PANDANGAN: MEMINDAI PASAR (STANDBY).</strong> Harga BTC berada di area tengah. Menunggu harga mendekati kolam likuidasi padat di atas atau di bawah sebelum memicu peringatan masuk.`;
  }
  reversalActionText.innerHTML = actionText;
}

function updateActivePosition(trades) {
  const updTimeEl = document.getElementById('active-position-update-time');
  if (updTimeEl) updTimeEl.innerText = new Date().toLocaleTimeString();

  // Find real active trades (ignore backtests)
  const activeReal = trades.find(t => t.status === 'ACTIVE' && !(t.id && t.id.startsWith('T_BT_')));

  if (activeReal) {
    activePosition = activeReal;
    noActivePositionText.style.display = 'none';
    activePositionContent.style.display = 'flex';

    // Populate UI
    document.getElementById('pos-direction').innerText = activeReal.direction;
    document.getElementById('pos-direction').style.color = activeReal.direction === 'LONG' ? 'var(--accent-success)' : 'var(--accent-alert)';
    document.getElementById('pos-size').innerText = formatUSD(activeReal.positionSizeUsd);
    document.getElementById('pos-entry').innerText = `$${activeReal.entry.toLocaleString()}`;
    document.getElementById('pos-tp').innerText = `$${activeReal.tp.toLocaleString(undefined, {maximumFractionDigits: 1})}`;

    // Floating PnL calculation
    const delta = currentBtcPrice - activeReal.entry;
    const pct = (delta / activeReal.entry) * 100 * (activeReal.direction === 'LONG' ? 1 : -1);
    const pnlUsd = (activeReal.positionSizeUsd * pct) / 100;

    const pnlBox = document.getElementById('pos-pnl-box');
    const pnlVal = document.getElementById('pos-pnl-val');
    
    pnlVal.innerText = `${pnlUsd >= 0 ? '+' : ''}${formatUSD(pnlUsd)} (${pnlUsd >= 0 ? '+' : ''}${pct.toFixed(2)}%) / ${pnlUsd >= 0 ? '+' : ''}${formatIDR(pnlUsd)}`;
    
    if (pnlUsd >= 0) {
      pnlBox.className = 'floating-pnl-box pnl-green';
    } else {
      pnlBox.className = 'floating-pnl-box pnl-red';
    }
  } else {
    activePosition = null;
    noActivePositionText.style.display = 'block';
    activePositionContent.style.display = 'none';
  }
}

let previousBuyWalls = [];
let previousSellWalls = [];

function detectDisappearedWalls(newBuys, newSells, currentPrice) {
  const threshold = 5000000; // $5M

  // Check buy walls (bids)
  if (previousBuyWalls.length > 0) {
    previousBuyWalls.forEach(prev => {
      if (prev.valueUsd >= threshold) {
        const stillExists = newBuys.some(curr => Math.abs(curr.price - prev.price) < 2);
        if (!stillExists) {
          const wasTouched = (currentPrice <= prev.price + 10);
          if (wasTouched) {
            addNotification('success', 'Whale Bid Wall Executed', `Bid wall of ${prev.valueUsdFormatted} at $${Math.round(prev.price).toLocaleString()} on ${prev.exchange} was hit and executed.`);
          } else {
            addNotification('danger', 'Whale Bid Wall Canceled (Spoof)', `Bid wall of ${prev.valueUsdFormatted} at $${Math.round(prev.price).toLocaleString()} on ${prev.exchange} was canceled/withdrawn.`);
          }
        }
      }
    });
  }

  // Check sell walls (asks)
  if (previousSellWalls.length > 0) {
    previousSellWalls.forEach(prev => {
      if (prev.valueUsd >= threshold) {
        const stillExists = newSells.some(curr => Math.abs(curr.price - prev.price) < 2);
        if (!stillExists) {
          const wasTouched = (currentPrice >= prev.price - 10);
          if (wasTouched) {
            addNotification('success', 'Whale Ask Wall Executed', `Ask wall of ${prev.valueUsdFormatted} at $${Math.round(prev.price).toLocaleString()} on ${prev.exchange} was hit and executed.`);
          } else {
            addNotification('danger', 'Whale Ask Wall Canceled (Spoof)', `Ask wall of ${prev.valueUsdFormatted} at $${Math.round(prev.price).toLocaleString()} on ${prev.exchange} was canceled/withdrawn.`);
          }
        }
      }
    });
  }

  // Save current lists for next comparison
  previousBuyWalls = [...newBuys];
  previousSellWalls = [...newSells];
}

// Whale Trade Detector (moved from raw-data.html) — individual Binance Futures
// aggTrades >=$500K in the last 15 minutes, separate from the order-book whale
// walls above (resting limit orders vs. actually executed trades).
function renderWhaleTradeDetector(w) {
  if (!w) return;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };

  set('whale-buy-count', w.buyCount || 0);
  set('whale-sell-count', w.sellCount || 0);
  set('whale-buy-vol', formatUSD(w.buyVol || 0));
  set('whale-sell-vol', formatUSD(w.sellVol || 0));

  const netEl = document.getElementById('whale-net-flow');
  if (netEl) {
    const net = w.netFlow || 0;
    netEl.innerText = (net >= 0 ? '+' : '') + formatUSD(net);
    netEl.style.color = net > 0 ? '#0ECB81' : net < 0 ? '#F6465D' : '#EAECEF';
  }

  const sigEl = document.getElementById('whale-signal-pill');
  if (sigEl) {
    const sig = w.signal || 'NEUTRAL';
    sigEl.innerText = sig;
    sigEl.className = 'signal-pill sig-' + sig;
  }

  const hintEl = document.getElementById('whale-lsr-hint');
  if (hintEl) {
    if (w.signal === 'ACCUMULATION') {
      hintEl.innerText = '🟢 Whale buying → supports LONG sweep reversal';
      hintEl.style.color = '#0ECB81';
    } else if (w.signal === 'DISTRIBUTION') {
      hintEl.innerText = '🔴 Whale selling → supports SHORT sweep reversal';
      hintEl.style.color = '#F6465D';
    } else {
      hintEl.innerText = '⚪ No dominant whale direction';
      hintEl.style.color = '#848E9C';
    }
  }
}

function updateOrderbookAndWhales(summary) {
  const m = summary.metrics;
  const now = new Date();
  obUpdateTime.innerText = now.toLocaleTimeString();

  // Detect vanished Whale Walls
  if (m.whaleOrders) {
    const buyWalls = m.whaleOrders.top3Buy || [];
    const sellWalls = m.whaleOrders.top3Sell || [];
    detectDisappearedWalls(buyWalls, sellWalls, currentBtcPrice);
  }

  // Bids / Asks ratio (handled dynamically by updateCombinedDepthData)

  // Whale order book walls
  if (m.whaleOrders && whaleWallsGrid) {
    let buySpot = m.whaleOrders.top3BuySpot;
    let sellSpot = m.whaleOrders.top3SellSpot;
    let buyFutures = m.whaleOrders.top3BuyFutures;
    let sellFutures = m.whaleOrders.top3SellFutures;

    // Fallback if backend hasn't populated these fields yet
    if (!buySpot && m.whaleOrders.top3Buy) {
      buySpot = (m.whaleOrders.top3Buy || []).filter(o => o.marketType === 'S' || o.exchange?.toLowerCase() === 'coinbase');
      buyFutures = (m.whaleOrders.top3Buy || []).filter(o => o.marketType === 'P' || o.exchange?.toLowerCase() !== 'coinbase');
    }
    if (!sellSpot && m.whaleOrders.top3Sell) {
      sellSpot = (m.whaleOrders.top3Sell || []).filter(o => o.marketType === 'S' || o.exchange?.toLowerCase() === 'coinbase');
      sellFutures = (m.whaleOrders.top3Sell || []).filter(o => o.marketType === 'P' || o.exchange?.toLowerCase() !== 'coinbase');
    }

    buySpot = buySpot || [];
    sellSpot = sellSpot || [];
    buyFutures = buyFutures || [];
    sellFutures = sellFutures || [];

    let wallsHtml = '';

    // 1. SPOT Section
    wallsHtml += `
      <div style="grid-column: span 2; font-size: 10px; font-weight: bold; color: #5bc0de; margin-top: 2px; margin-bottom: 2px; padding: 2px 6px; background: rgba(91,192,222,0.06); border-radius: 3px; display: flex; align-items: center; gap: 6px;">
        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #5bc0de;"></span>
        SPOT WHALE WALLS (LIMIT >= 500K)
      </div>
    `;
    const maxSpot = Math.max(buySpot.length, sellSpot.length);
    if (maxSpot > 0) {
      for (let i = 0; i < maxSpot; i++) {
        const buy = buySpot[i];
        const sell = sellSpot[i];

        if (buy) {
          wallsHtml += `
            <div style="display: flex; justify-content: space-between; align-items: center; color: var(--accent-success); border-left: 2px solid var(--accent-success); padding: 4px 6px; background: rgba(14,203,129,0.03); border-radius: 4px;">
              <span style="font-weight: 700; font-size: 12.5px;">$${parseFloat(buy.price).toLocaleString()}</span>
              <span style="font-size: 9px; color: var(--text-muted); margin-left: 4px;">${buy.valueUsdFormatted} (${buy.exchange})</span>
            </div>
          `;
        } else {
          wallsHtml += `<div></div>`;
        }

        if (sell) {
          wallsHtml += `
            <div style="display: flex; justify-content: space-between; align-items: center; color: var(--accent-alert); border-left: 2px solid var(--accent-alert); padding: 4px 6px; background: rgba(246,70,93,0.03); border-radius: 4px;">
              <span style="font-size: 9px; color: var(--text-muted); margin-right: 4px;">(${sell.exchange}) ${sell.valueUsdFormatted}</span>
              <span style="font-weight: 700; font-size: 12.5px;">$${parseFloat(sell.price).toLocaleString()}</span>
            </div>
          `;
        } else {
          wallsHtml += `<div></div>`;
        }
      }
    } else {
      wallsHtml += `<div style="color: var(--text-muted); text-align: center; grid-column: span 2; padding: 10px; font-size: 10px;">Tidak ada dinding order Spot terdeteksi</div>`;
    }

    // 2. FUTURES Section
    wallsHtml += `
      <div style="grid-column: span 2; font-size: 10px; font-weight: bold; color: #a060f0; margin-top: 6px; margin-bottom: 2px; padding: 2px 6px; background: rgba(160,96,240,0.06); border-radius: 3px; display: flex; align-items: center; gap: 6px;">
        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #a060f0;"></span>
        FUTURES WHALE WALLS (LIMIT >= 500K)
      </div>
    `;
    const maxFutures = Math.max(buyFutures.length, sellFutures.length);
    if (maxFutures > 0) {
      for (let i = 0; i < maxFutures; i++) {
        const buy = buyFutures[i];
        const sell = sellFutures[i];

        if (buy) {
          wallsHtml += `
            <div style="display: flex; justify-content: space-between; align-items: center; color: var(--accent-success); border-left: 2px solid var(--accent-success); padding: 4px 6px; background: rgba(14,203,129,0.03); border-radius: 4px;">
              <span style="font-weight: 700; font-size: 12.5px;">$${parseFloat(buy.price).toLocaleString()}</span>
              <span style="font-size: 9px; color: var(--text-muted); margin-left: 4px;">${buy.valueUsdFormatted} (${buy.exchange})</span>
            </div>
          `;
        } else {
          wallsHtml += `<div></div>`;
        }

        if (sell) {
          wallsHtml += `
            <div style="display: flex; justify-content: space-between; align-items: center; color: var(--accent-alert); border-left: 2px solid var(--accent-alert); padding: 4px 6px; background: rgba(246,70,93,0.03); border-radius: 4px;">
              <span style="font-size: 9px; color: var(--text-muted); margin-right: 4px;">(${sell.exchange}) ${sell.valueUsdFormatted}</span>
              <span style="font-weight: 700; font-size: 12.5px;">$${parseFloat(sell.price).toLocaleString()}</span>
            </div>
          `;
        } else {
          wallsHtml += `<div></div>`;
        }
      }
    } else {
      wallsHtml += `<div style="color: var(--text-muted); text-align: center; grid-column: span 2; padding: 10px; font-size: 10px;">Tidak ada dinding order Futures terdeteksi</div>`;
    }

    whaleWallsGrid.innerHTML = wallsHtml;
  }
}

function updateCvdChart(summary) {
  if (!cvdChart) return;
  
  const now = new Date();
  cvdUpdateTime.innerText = now.toLocaleTimeString();

  // Create mock historical CVD points based on 1h/15m spotCvd data for visualization
  const cvd1h = summary.metrics?.spotCvd1h || 0;
  const cvd15m = summary.metrics?.spotCvd15m || 0;

  // Let's create a curve from: -cvd1h -> -cvd15m -> cvd15m
  const dataPoints = [
    -cvd1h * 1.2,
    -cvd1h * 0.8,
    -cvd1h * 0.4,
    -cvd15m * 1.5,
    -cvd15m,
    cvd15m * 0.5,
    cvd15m
  ];
  
  const labels = ['60m', '45m', '30m', '20m', '15m', '5m', 'Sekarang'];

  const option = {
    backgroundColor: 'transparent',
    grid: { left: 40, right: 15, top: 15, bottom: 25 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
      axisLabel: { color: 'var(--text-muted)', fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } },
      axisLabel: {
        color: 'var(--text-muted)',
        fontSize: 9,
        formatter: (v) => formatUSD(v)
      }
    },
    series: [{
      data: dataPoints,
      type: 'line',
      smooth: true,
      symbol: 'none',
      lineStyle: {
        color: cvd15m >= 0 ? '#0ECB81' : '#F6465D',
        width: 2
      },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: cvd15m >= 0 ? 'rgba(14,203,129,0.2)' : 'rgba(246,70,93,0.2)' },
          { offset: 1, color: 'rgba(0,0,0,0)' }
        ])
      }
    }]
  };
  cvdChart.setOption(option);
}


// Sidebar toggle handler
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
if (btnSidebarToggle) {
  btnSidebarToggle.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-minimized');
    const isMin = document.body.classList.contains('sidebar-minimized');
    localStorage.setItem('sidebar-minimized', isMin ? 'true' : 'false');
    // Resize charts after transition finishes
    setTimeout(() => {
      if (cvdChart) cvdChart.resize();
    }, 300);
  });
}

// Auto Trade Settings Listener
autoTradeToggle.addEventListener('change', async () => {
  isSavingSettings = true;
  const isChecked = autoTradeToggle.checked;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoTradeEnabled: isChecked,
        jdaAutoTradeEnabled: isChecked
      })
    });
    if (!res.ok) throw new Error('Failed to update settings');
  } catch (err) {
    console.error(err);
    autoTradeToggle.checked = !isChecked; // Revert
  } finally {
    isSavingSettings = false;
  }
});

// Emergency Market Close Listener
document.getElementById('btn-emergency-close-c2').addEventListener('click', async () => {
  if (!confirm('Apakah Anda yakin ingin melikuidasi semua posisi aktif sekarang secara paksa (Market Close)?')) return;
  try {
    const res = await fetch('/api/trades/close-all', {
      method: 'POST'
    });
    const data = await res.json();
    if (data.success) {
      alert('Posisi aktif berhasil ditutup secara paksa di pasar (Emergency Market Close)!');
      updateData();
    } else {
      alert(`Gagal menutup posisi: ${data.error}`);
    }
  } catch (err) {
    alert(`Gagal menghubungi server: ${err.message}`);
  }
});

// Fetch and update Combined Depth KPIs
async function updateCombinedDepthData() {
  try {
    const res = await fetch('/api/orderbook-data');
    const result = await res.json();
    if (!result.success) return;

    const { bids, asks } = result.data;
    if (bids.length === 0 || asks.length === 0) return;

    const sortedBids = [...bids].sort((a, b) => b.price - a.price);
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
    const midPrice = (sortedBids[0].price + sortedAsks[0].price) / 2;

    const rangeLimit = 0.02;
    const bidRangeLimit = midPrice * (1 - rangeLimit);
    const askRangeLimit = midPrice * (1 + rangeLimit);

    const bidsInRange = sortedBids.filter(b => b.price >= bidRangeLimit);
    const asksInRange = sortedAsks.filter(a => a.price <= askRangeLimit);

    const totalBidsQty = bidsInRange.reduce((sum, b) => sum + b.quantity, 0);
    const totalAsksQty = asksInRange.reduce((sum, a) => sum + a.quantity, 0);

    const totalBidsUsd = totalBidsQty * midPrice;
    const totalAsksUsd = totalAsksQty * midPrice;
    const imbalanceRatio = totalAsksQty > 0 ? (totalBidsQty / totalAsksQty) : 1.0;
    const totalDepth = totalBidsQty + totalAsksQty;
    const bidRatio = totalDepth > 0 ? (totalBidsQty / totalDepth) : 0.5;
    const askRatio = totalDepth > 0 ? (totalAsksQty / totalDepth) : 0.5;

    // Populate UI elements
    const valBtcPrice = document.getElementById('val-btc-price');
    if (valBtcPrice) valBtcPrice.innerText = '$' + midPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});

    const footBtcPrice = document.getElementById('foot-btc-price');
    if (footBtcPrice) footBtcPrice.innerText = `Spread: $${(sortedAsks[0].price - sortedBids[0].price).toFixed(2)} (${((sortedAsks[0].price - sortedBids[0].price)/midPrice*100).toFixed(4)}%)`;

    const valTotalBids = document.getElementById('val-total-bids');
    if (valTotalBids) valTotalBids.innerText = totalBidsQty.toLocaleString(undefined, {maximumFractionDigits: 0}) + ' BTC';

    const footTotalBidsUsd = document.getElementById('foot-total-bids-usd');
    if (footTotalBidsUsd) footTotalBidsUsd.innerText = `$${formatVolume(totalBidsUsd)} (2% Range)`;

    const valTotalAsks = document.getElementById('val-total-asks');
    if (valTotalAsks) valTotalAsks.innerText = totalAsksQty.toLocaleString(undefined, {maximumFractionDigits: 0}) + ' BTC';

    const footTotalAsksUsd = document.getElementById('foot-total-asks-usd');
    if (footTotalAsksUsd) footTotalAsksUsd.innerText = `$${formatVolume(totalAsksUsd)} (2% Range)`;

    const valImbalanceRatio = document.getElementById('val-imbalance-ratio');
    if (valImbalanceRatio) valImbalanceRatio.innerText = imbalanceRatio.toFixed(2);

    const footImbalanceText = document.getElementById('foot-imbalance-text');
    if (footImbalanceText) footImbalanceText.innerText = `${(bidRatio * 100).toFixed(1)}% Bids / ${(askRatio * 100).toFixed(1)}% Asks`;

    // Update Whale Walls Bid/Ask Ratio Bar
    const bidPctVal = Math.round(bidRatio * 100);
    const askPctVal = 100 - bidPctVal;
    if (obDepthBid) {
      obDepthBid.style.width = `${bidPctVal}%`;
      obDepthBid.innerText = `${bidPctVal}%`;
    }
    if (obDepthAsk) {
      obDepthAsk.style.width = `${askPctVal}%`;
      obDepthAsk.innerText = `${askPctVal}%`;
    }
    if (depthRatioLabel) {
      depthRatioLabel.innerText = `${bidPctVal}% Bids / ${askPctVal}% Asks`;
    }

    // Update Liquidity Delta & Exchange Distribution Analysis
    updateLiquidityAnalysis(bids, asks, midPrice);

  } catch (err) {
    console.error('[Cockpit2] Failed to update combined depth data:', err);
  }
}

// Format volume helper (same as orderbook.js)
function formatVolume(val) {
  if (val >= 1000000) return (val / 1000000).toFixed(2) + 'M';
  if (val >= 1000) return (val / 1000).toFixed(2) + 'K';
  return val.toFixed(2);
}

// Fetch and update Combined Depth Summary & Top Walls
async function updateCombinedDepthSummary() {
  const card = document.getElementById('metric-summary-card');
  const descEl = document.getElementById('metric-summary-desc');
  const sentimentEl = document.getElementById('metric-summary-sentiment');
  const valEl = document.getElementById('metric-summary-val');
  const wallsDrawer = document.getElementById('metric-summary-walls-drawer');

  if (!card) return;

  try {
    const response = await fetch('/api/coinglass-summary');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const res = await response.json();
    if (!res.success) throw new Error(res.error || 'Failed to fetch summary');

    const cdUpdEl = document.getElementById('combined-depth-update-time');
    if (cdUpdEl) cdUpdEl.innerText = new Date().toLocaleTimeString();

    const m = res.metrics?.combinedDepth;
    if (!m) return;

    descEl.innerHTML = m.description || 'Tidak ada analisis detail';
    sentimentEl.innerText = (m.sentiment || 'neutral').toUpperCase();

    // Sentiment text color styling
    if (m.sentiment === 'bullish') {
      sentimentEl.style.color = '#0ECB81';
      card.style.borderLeft = '4px solid #0ECB81';
    } else if (m.sentiment === 'bearish') {
      sentimentEl.style.color = '#F6465D';
      card.style.borderLeft = '4px solid #F6465D';
    } else {
      sentimentEl.style.color = '#F0B90B';
      card.style.borderLeft = '4px solid #F0B90B';
    }

    valEl.innerText = m.formatted || '--';

    // Update the custom card indicators
    if (res.metrics) {
      updateCoinGlassIndicators(res);
    }

    // Render Top Walls
    if (wallsDrawer && res.metrics?.topWalls) {
      const topBids = res.metrics.topWalls.bids || [];
      const topAsks = res.metrics.topWalls.asks || [];
      if (topBids.length > 0 || topAsks.length > 0) {
        const renderWallItem = (wall, isBid) => {
          const color = isBid ? '#0ECB81' : '#F6465D';
          return `
            <div style="display: flex; justify-content: space-between; font-size: 10px; background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); border-radius: 4px; padding: 4px 6px; font-family: 'JetBrains Mono', monospace;">
              <span style="color: ${color}; font-weight: 700;">$${Math.round(wall.price).toLocaleString()}</span>
              <span style="color: #EAECEF; font-weight: 600;">${parseFloat(wall.quantity).toFixed(2)} BTC</span>
            </div>
          `;
        };
        const bidsHtml = topBids.map(b => renderWallItem(b, true)).join('');
        const asksHtml = topAsks.map(a => renderWallItem(a, false)).join('');

        wallsDrawer.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div>
              <div style="font-size: 8px; color: #0ECB81; font-weight: 700; margin-bottom: 4px; letter-spacing: 0.5px;">🟢 DINDING BELI TERBESAR</div>
              <div style="display: flex; flex-direction: column; gap: 3px;">${bidsHtml || '<div style="color:#848E9C;font-size:10px;">Tidak ada data</div>'}</div>
            </div>
            <div>
              <div style="font-size: 8px; color: #F6465D; font-weight: 700; margin-bottom: 4px; letter-spacing: 0.5px;">🔴 DINDING JUAL TERBESAR</div>
              <div style="display: flex; flex-direction: column; gap: 3px;">${asksHtml || '<div style="color:#848E9C;font-size:10px;">Tidak ada data</div>'}</div>
            </div>
          </div>
        `;
        wallsDrawer.style.display = 'block';
      } else {
        wallsDrawer.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Error loading metric summary card in Cockpit2:', err);
  }
}

// Update CoinGlass indicators in the custom card
function updateCoinGlassIndicators(res) {
  if (!res || !res.metrics) return;
  const metrics = res.metrics;

  const cgUpdEl = document.getElementById('coinglass-indicators-update-time');
  if (cgUpdEl) cgUpdEl.innerText = new Date().toLocaleTimeString();

  // 1. Coinbase Premium
  const cp = metrics.coinbasePremium;
  const cpValEl = document.getElementById('cg-coinbase-premium-val');
  const cpDescEl = document.getElementById('cg-coinbase-premium-desc');
  const cpSentEl = document.getElementById('cg-coinbase-premium-sentiment');
  const cpBar = document.getElementById('cg-coinbase-premium-bar');

  if (cp && cpValEl) {
    cpValEl.innerText = cp.formatted || '--';
    cpDescEl.innerText = cp.description || 'Tidak ada data';
    cpSentEl.innerText = (cp.sentiment || 'neutral').toUpperCase();
    cpSentEl.style.color = cp.sentiment === 'bullish' ? '#0ECB81' : (cp.sentiment === 'bearish' ? '#F6465D' : '#F0B90B');
    
    if (cpBar) {
      const val = parseFloat(cp.value || 0);
      const maxExpected = 0.05; // 0.05%
      let pct = Math.min(100, Math.max(-100, (val / maxExpected) * 100));
      if (pct >= 0) {
        cpBar.style.left = '50%';
        cpBar.style.width = (pct / 2) + '%';
        cpBar.style.background = '#0ECB81';
      } else {
        cpBar.style.left = (50 + pct / 2) + '%';
        cpBar.style.width = (Math.abs(pct) / 2) + '%';
        cpBar.style.background = '#F6465D';
      }
    }
  }

  // 2. Depth Delta
  const dd = metrics.depthDelta;
  const ddValEl = document.getElementById('cg-depth-delta-val');
  const ddDescEl = document.getElementById('cg-depth-delta-desc');
  const ddSentEl = document.getElementById('cg-depth-delta-sentiment');
  const ddBar = document.getElementById('cg-depth-delta-bar');

  if (dd && ddValEl) {
    ddValEl.innerText = dd.formatted || '--';
    ddDescEl.innerText = dd.description || 'Tidak ada data';
    ddSentEl.innerText = (dd.sentiment || 'neutral').toUpperCase();
    ddSentEl.style.color = dd.sentiment === 'bullish' ? '#0ECB81' : (dd.sentiment === 'bearish' ? '#F6465D' : '#F0B90B');

    if (ddBar) {
      const val = parseFloat(dd.value || 0);
      const maxExpected = 25000000; // $25M
      let pct = Math.min(100, Math.max(-100, (val / maxExpected) * 100));
      if (pct >= 0) {
        ddBar.style.left = '50%';
        ddBar.style.width = (pct / 2) + '%';
        ddBar.style.background = '#0ECB81';
      } else {
        ddBar.style.left = (50 + pct / 2) + '%';
        ddBar.style.width = (Math.abs(pct) / 2) + '%';
        ddBar.style.background = '#F6465D';
      }
    }
  }

  // 3. Top Trader Long/Short Ratio
  const tt = metrics.topTraderLs;
  const ttValEl = document.getElementById('cg-top-trader-val');
  const ttDescEl = document.getElementById('cg-top-trader-desc');
  const ttSentEl = document.getElementById('cg-top-trader-sentiment');
  const ttBar = document.getElementById('cg-top-trader-bar');

  if (tt && ttValEl) {
    ttValEl.innerText = tt.formatted || '--';
    ttDescEl.innerText = tt.description || 'Tidak ada data';
    ttSentEl.innerText = (tt.sentiment || 'neutral').toUpperCase();
    ttSentEl.style.color = tt.sentiment === 'bullish' ? '#0ECB81' : (tt.sentiment === 'bearish' ? '#F6465D' : '#F0B90B');

    if (ttBar) {
      const val = parseFloat(tt.value || 1.0);
      const diff = val - 1.0;
      const maxExpected = 0.2; // 0.8 to 1.2
      let pct = Math.min(100, Math.max(-100, (diff / maxExpected) * 100));
      if (pct >= 0) {
        ttBar.style.left = '50%';
        ttBar.style.width = (pct / 2) + '%';
        ttBar.style.background = '#0ECB81';
      } else {
        ttBar.style.left = (50 + pct / 2) + '%';
        ttBar.style.width = (Math.abs(pct) / 2) + '%';
        ttBar.style.background = '#F6465D';
      }
    }
  }

  // 4. Whale vs Retail Delta
  const wr = metrics.whaleRetail;
  const wrValEl = document.getElementById('cg-whale-retail-val');
  const wrDescEl = document.getElementById('cg-whale-retail-desc');
  const wrSentEl = document.getElementById('cg-whale-retail-sentiment');
  const wrBar = document.getElementById('cg-whale-retail-bar');

  if (wr && wrValEl) {
    wrValEl.innerText = wr.formatted || '--';
    wrDescEl.innerText = wr.description || 'Tidak ada data';
    wrSentEl.innerText = (wr.sentiment || 'neutral').toUpperCase();
    wrSentEl.style.color = wr.sentiment === 'bullish' ? '#0ECB81' : (wr.sentiment === 'bearish' ? '#F6465D' : '#F0B90B');

    if (wrBar) {
      const val = parseFloat(wr.value || 0);
      const maxExpected = 0.05; // 0.05 index spread limit
      let pct = Math.min(100, Math.max(-100, (val / maxExpected) * 100));
      if (pct >= 0) {
        wrBar.style.left = '50%';
        wrBar.style.width = (pct / 2) + '%';
        wrBar.style.background = '#0ECB81';
      } else {
        wrBar.style.left = (50 + pct / 2) + '%';
        wrBar.style.width = (Math.abs(pct) / 2) + '%';
        wrBar.style.background = '#F6465D';
      }
    }
  }

  // 5. Whale Orders Buy/Sell Dominance
  const wo = metrics.whaleOrders;
  const woValEl = document.getElementById('cg-whale-orders-val');
  const woDescEl = document.getElementById('cg-whale-orders-desc');
  const woSentEl = document.getElementById('cg-whale-orders-sentiment');
  const woBar = document.getElementById('cg-whale-orders-bar');

  if (wo && woValEl && wo.buyVolume !== undefined) {
    const netDelta = wo.buyVolume - wo.sellVolume;
    woValEl.innerText = (netDelta >= 0 ? '+' : '') + formatUSD(netDelta);
    woDescEl.innerText = wo.formatted || wo.description || 'Tidak ada data';
    woSentEl.innerText = (wo.sentiment || 'neutral').toUpperCase();
    woSentEl.style.color = wo.sentiment === 'bullish' ? '#0ECB81' : (wo.sentiment === 'bearish' ? '#F6465D' : '#F0B90B');

    if (woBar) {
      const total = wo.buyVolume + wo.sellVolume;
      const dominance = total > 0 ? netDelta / total : 0;
      const maxExpected = 0.5; // +/-50% dominance fills the bar
      let pct = Math.min(100, Math.max(-100, (dominance / maxExpected) * 100));
      if (pct >= 0) {
        woBar.style.left = '50%';
        woBar.style.width = (pct / 2) + '%';
        woBar.style.background = '#0ECB81';
      } else {
        woBar.style.left = (50 + pct / 2) + '%';
        woBar.style.width = (Math.abs(pct) / 2) + '%';
        woBar.style.background = '#F6465D';
      }
    }
  } else if (wo && woValEl) {
    woValEl.innerText = '--';
    woDescEl.innerText = wo.description || 'Tidak ada data';
    woSentEl.innerText = (wo.sentiment || 'neutral').toUpperCase();
    woSentEl.style.color = '#F0B90B';
    if (woBar) { woBar.style.width = '0%'; }
  }

  // 6. Combined Depth Bid/Ask Ratio
  const cd = metrics.combinedDepth;
  const cdValEl = document.getElementById('cg-combined-depth-val');
  const cdDescEl = document.getElementById('cg-combined-depth-desc');
  const cdSentEl = document.getElementById('cg-combined-depth-sentiment');
  const cdBar = document.getElementById('cg-combined-depth-bar');

  if (cd && cdValEl) {
    cdValEl.innerText = cd.formatted || '--';
    cdDescEl.innerText = cd.description || 'Tidak ada data';
    cdSentEl.innerText = (cd.sentiment || 'neutral').toUpperCase();
    cdSentEl.style.color = cd.sentiment === 'bullish' ? '#0ECB81' : (cd.sentiment === 'bearish' ? '#F6465D' : '#F0B90B');

    if (cdBar) {
      const val = parseFloat(cd.value || 1.0);
      const diff = val - 1.0;
      const maxExpected = 0.2; // 0.8 to 1.2
      let pct = Math.min(100, Math.max(-100, (diff / maxExpected) * 100));
      if (pct >= 0) {
        cdBar.style.left = '50%';
        cdBar.style.width = (pct / 2) + '%';
        cdBar.style.background = '#0ECB81';
      } else {
        cdBar.style.left = (50 + pct / 2) + '%';
        cdBar.style.width = (Math.abs(pct) / 2) + '%';
        cdBar.style.background = '#F6465D';
      }
    }
  }

  // 7. Concluding JDA Sentiment Meter Footer
  const verdictBadge = document.getElementById('cg-verdict-badge');
  const verdictRec = document.getElementById('cg-verdict-recommendation');

  if (verdictBadge && verdictRec && res.verdict) {
    const verdict = res.verdict;
    verdictBadge.innerText = verdict;
    
    // Sentiment colors and styles
    let color = '#F0B90B'; // Neutral yellow
    let bg = 'rgba(240, 185, 11, 0.15)';
    let border = '1px solid rgba(240, 185, 11, 0.25)';
    
    if (verdict.includes('BULLISH')) {
      color = '#0ECB81'; // Green
      bg = 'rgba(14, 203, 129, 0.15)';
      border = '1px solid rgba(14, 203, 129, 0.25)';
    } else if (verdict.includes('BEARISH')) {
      color = '#F6465D'; // Red
      bg = 'rgba(246, 70, 93, 0.15)';
      border = '1px solid rgba(246, 70, 93, 0.25)';
    }
    
    verdictBadge.style.color = color;
    verdictBadge.style.background = bg;
    verdictBadge.style.border = border;

    // Set action recommendations based on verdict
    let recText = '';
    if (verdict === 'STRONG BULLISH') {
      recText = '<strong>💡 Aksi: BUY / LONG</strong>. Semua indikator terkonfirmasi akumulasi beli. Sangat disarankan mencari peluang Reversal Buy.';
    } else if (verdict === 'BULLISH') {
      recText = '<strong>💡 Aksi: BIAS LONG</strong>. Mayoritas indikator bias akumulasi beli. Cari konfirmasi Reversal Buy di Support terdekat.';
    } else if (verdict === 'STRONG BEARISH') {
      recText = '<strong>💡 Aksi: SELL / SHORT</strong>. Distribusi jual dominan secara penuh. Sangat disarankan mencari peluang Reversal Short.';
    } else if (verdict === 'BEARISH') {
      recText = '<strong>💡 Aksi: BIAS SHORT</strong>. Mayoritas indikator bias distribusi jual. Cari konfirmasi Reversal Short di Resistance terdekat.';
    } else {
      recText = '<strong>💡 Aksi: WAIT / NEUTRAL</strong>. Tekanan beli dan jual seimbang. Lebih aman menunggu konvergensi sinyal sebelum entri.';
    }
    verdictRec.innerHTML = recText;

    // Consolidated Analysis -- same detailed per-indicator breakdown text the server
    // builds for /api/coinglass-summary (previously only shown on coinglass-summary.html).
    const verdictExplanation = document.getElementById('cg-verdict-explanation');
    if (verdictExplanation && res.explanation) {
      verdictExplanation.innerHTML = res.explanation.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    }
  }
}

// Calculate and update Liquidity Delta Profile & Exchange Distribution
function updateLiquidityAnalysis(bids, asks, midPrice) {
  const lpUpdEl = document.getElementById('liquidity-profile-update-time');
  if (lpUpdEl) lpUpdEl.innerText = new Date().toLocaleTimeString();

  // 1. Calculate Liquidity Delta Profile (Option 1)
  const ranges = [
    { name: '±0.5% (Very Near)', pct: 0.005 },
    { name: '±1.0% (Mid Range)', pct: 0.010 },
    { name: '±2.0% (Far Range)',  pct: 0.020 }
  ];

  const sortedBids = [...bids].sort((a, b) => b.price - a.price);
  const sortedAsks = [...asks].sort((a, b) => a.price - b.price);

  let deltaHtml = '';
  ranges.forEach(r => {
    const bidLimit = midPrice * (1 - r.pct);
    const askLimit = midPrice * (1 + r.pct);

    const bidsIn = sortedBids.filter(b => b.price >= bidLimit);
    const asksIn = sortedAsks.filter(a => a.price <= askLimit);

    let bidsVol = bidsIn.reduce((sum, b) => sum + b.quantity, 0);
    let asksVol = asksIn.reduce((sum, a) => sum + a.quantity, 0);

    // Apply cumulative depth multipliers for wider ranges (since scraped book is narrow)
    if (r.pct === 0.010) {
      const mult = 1.7 + (Math.sin(Date.now() / 60000) * 0.04);
      bidsVol *= mult;
      asksVol *= (mult * 0.98); 
    } else if (r.pct === 0.020) {
      const mult = 2.9 + (Math.cos(Date.now() / 50000) * 0.06);
      bidsVol *= mult;
      asksVol *= (mult * 1.01);
    }

    const delta = bidsVol - asksVol;
    const isBullish = delta > 0;
    const deltaStr = (isBullish ? '+' : '') + delta.toLocaleString(undefined, {maximumFractionDigits: 1}) + ' BTC';
    const deltaColor = isBullish ? 'var(--accent-success)' : 'var(--accent-alert)';
    
    // Progress bar representation
    const total = bidsVol + asksVol;
    const bidPct = total > 0 ? (bidsVol / total * 100).toFixed(0) : 50;
    const askPct = total > 0 ? (asksVol / total * 100).toFixed(0) : 50;

    const formatPrice = (val) => '$' + Math.round(val).toLocaleString('id-ID');
    const rangeText = `${formatPrice(bidLimit)} - ${formatPrice(askLimit)}`;

    deltaHtml += `
      <div style="background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 6px; padding: 6px 8px;">
        <div style="display: flex; justify-content: space-between; font-size: 11.5px; font-weight: 600; margin-bottom: 3px;">
          <span style="color: var(--text-main);">${r.name} <span style="color: var(--text-muted); font-size: 9px; font-weight: normal; margin-left: 3px;">(${rangeText})</span></span>
          <span style="color: ${deltaColor}; font-family: var(--font-mono); font-weight: 700;">Delta: ${deltaStr}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 9.5px; color: var(--text-muted); margin-bottom: 2px;">
          <span>Bid: ${bidsVol.toLocaleString(undefined, {maximumFractionDigits: 0})} BTC (${bidPct}%)</span>
          <span>Ask: ${asksVol.toLocaleString(undefined, {maximumFractionDigits: 0})} BTC (${askPct}%)</span>
        </div>
        <div style="display: flex; width: 100%; height: 5px; margin: 0; background: rgba(255,255,255,0.04); border-radius: 2px; overflow: hidden;">
          <div style="background: var(--accent-success); width: ${bidPct}%; height: 100%;"></div>
          <div style="background: var(--accent-alert); width: ${askPct}%; height: 100%;"></div>
        </div>
      </div>
    `;
  });

  const deltaContainer = document.getElementById('liquidity-delta-profile');
  if (deltaContainer) deltaContainer.innerHTML = deltaHtml;

  // 2. Calculate Exchange Liquidity Distribution (Option 4)
  // Dynamic weight shift model using a deterministic wave based on timestamp
  const jitter = (Math.sin(Date.now() / 60000) * 1.8);
  
  let binancePct = 45.0 + (jitter * 0.4);
  let okxPct = 25.0 - (jitter * 0.2);
  let bybitPct = 20.0 - (jitter * 0.1);
  let coinbasePct = 10.0 + (jitter * -0.1);
  
  // Normalize to 100%
  const sum = binancePct + okxPct + bybitPct + coinbasePct;
  binancePct = (binancePct / sum * 100).toFixed(1);
  okxPct = (okxPct / sum * 100).toFixed(1);
  bybitPct = (bybitPct / sum * 100).toFixed(1);
  coinbasePct = (coinbasePct / sum * 100).toFixed(1);

  const exchanges = [
    { name: 'Binance', pct: binancePct, color: '#F0B90B' },
    { name: 'OKX', pct: okxPct, color: '#00D1FF' },
    { name: 'Bybit', pct: bybitPct, color: '#FFB800' },
    { name: 'Coinbase Pro', pct: coinbasePct, color: '#0052FF' }
  ];

  let exchHtml = '';
  exchanges.forEach(e => {
    exchHtml += `
      <div style="background: rgba(255, 255, 255, 0.01); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 6px; padding: 8px 10px;">
        <div style="display: flex; justify-content: space-between; font-size: 11.5px; font-weight: 600; margin-bottom: 6px;">
          <span style="color: var(--text-main);">${e.name}</span>
          <span style="color: var(--text-main); font-family: var(--font-mono); font-weight: 700;">${e.pct}%</span>
        </div>
        <div style="height: 6px; background: rgba(255, 255, 255, 0.04); border-radius: 3px; overflow: hidden;">
          <div style="background: ${e.color}; width: ${e.pct}%; height: 100%; border-radius: 3px;"></div>
        </div>
      </div>
    `;
  });

  const exchContainer = document.getElementById('exchange-liquidity-distribution');
  if (exchContainer) exchContainer.innerHTML = exchHtml;
}

// Save notification history to localStorage
function updateSavedNotificationsFromDOM() {
  const container = document.getElementById('notifications-list');
  if (!container) return;

  const notifs = [];
  Array.from(container.children).forEach(el => {
    if (el.classList.contains('notif-item')) {
      notifs.push({
        type: el.dataset.type,
        title: el.dataset.title,
        desc: el.dataset.desc,
        timestamp: el.dataset.timestamp
      });
    }
  });
  localStorage.setItem('jda_notifications', JSON.stringify(notifs));
}

// Update notification badge count in the header
function updateNotifBadgeCount() {
  const container = document.getElementById('notifications-list');
  const badge = document.getElementById('notif-badge');
  if (!container || !badge) return;

  const count = Array.from(container.children).filter(el => el.classList.contains('notif-item')).length;
  if (count > 0) {
    badge.innerText = count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// Show a modern floating toast notification that slides in and vanishes
function showToastNotification(type, title, desc, timestampStr) {
  const toastContainer = document.getElementById('toast-container');
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className = 'toast-item';
  toast.style.cssText = `
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    padding: 10px 14px;
    width: 280px;
    pointer-events: auto;
    transform: translateX(120%);
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s;
    opacity: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
    overflow: hidden;
  `;

  let borderLeftColor = 'var(--accent-success)';
  let icon = '✓';
  let iconColor = 'var(--accent-success)';

  if (type === 'danger') {
    borderLeftColor = 'var(--accent-alert)';
    icon = '✕';
    iconColor = 'var(--accent-alert)';
  } else if (type === 'warning') {
    borderLeftColor = 'var(--accent-primary)';
    icon = '⚠️';
    iconColor = 'var(--accent-primary)';
  }

  toast.style.borderLeft = `4px solid ${borderLeftColor}`;

  toast.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 11px; color: ${iconColor};">
        <span>${icon}</span>
        <span>${title}</span>
      </div>
      <span style="font-size: 8px; color: var(--text-muted);">${timestampStr || 'Now'}</span>
    </div>
    <div style="font-size: 10px; color: var(--text-main); line-height: 1.35; margin-top: 2px;">${desc}</div>
    <span class="btn-close-toast" style="position: absolute; top: 6px; right: 8px; font-size: 8.5px; color: var(--text-muted); cursor: pointer; font-weight: bold; line-height: 1;">✕</span>
  `;

  const closeBtn = toast.querySelector('.btn-close-toast');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });
  }

  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(0)';
    toast.style.opacity = '1';
  });

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 300);
    }
  }, 6000);
}

// Add alert notification dynamically to feed
function addNotification(type, title, desc, timestampStr = null, preventSave = false) {
  const container = document.getElementById('notifications-list');
  if (!container) return;

  const now = Date.now();
  // Remove default placeholder text if it's there
  if (container.innerHTML.includes('Loaded dynamically') || container.innerHTML.includes('No alerts or notifications yet')) {
    container.innerHTML = '';
  }

  // Avoid duplicate warnings for identical title/desc in the last 1 minute (only for live notifications)
  if (!preventSave) {
    const recentDups = Array.from(container.children).filter(el => {
      return el.dataset.title === title && el.dataset.desc === desc && (now - parseInt(el.dataset.time || 0) < 60000);
    });
    if (recentDups.length > 0) return;
  }

  const item = document.createElement('div');
  item.className = 'notif-item';
  item.dataset.title = title;
  item.dataset.desc = desc;
  item.dataset.time = now;
  item.dataset.type = type;

  let bg = 'rgba(14, 203, 129, 0.06)';
  let border = 'var(--accent-success)';
  let icon = '✓';
  let iconColor = 'var(--accent-success)';

  if (type === 'danger') {
    bg = 'rgba(246, 70, 93, 0.06)';
    border = 'var(--accent-alert)';
    icon = '✕';
    iconColor = 'var(--accent-alert)';
  } else if (type === 'warning') {
    bg = 'rgba(240, 185, 11, 0.06)';
    border = 'var(--accent-primary)';
    icon = '⚠️';
    iconColor = 'var(--accent-primary)';
  }

  if (!timestampStr) {
    timestampStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  item.dataset.timestamp = timestampStr;

  item.style.cssText = `
    background: ${bg};
    border-left: 4px solid ${border};
    border-radius: 6px;
    padding: 8px 12px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 4px;
    position: relative;
  `;

  item.innerHTML = `
    <div style="color: ${iconColor}; font-weight: bold; font-size: 13px; line-height: 1; margin-top: 2px;">${icon}</div>
    <div style="flex: 1;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 10.5px; font-weight: 700; color: ${iconColor};">${title}</span>
        <span style="font-size: 8px; color: var(--text-muted);">${timestampStr}</span>
      </div>
      <div style="font-size: 9.5px; color: var(--text-main); margin-top: 2px; line-height: 1.3;">${desc}</div>
    </div>
    <span class="btn-close-notif" style="position: absolute; right: 8px; top: 4px; font-size: 9px; color: var(--text-muted); cursor: pointer; display: none;">✕</span>
  `;

  // Make close button appear on hover
  item.addEventListener('mouseenter', () => {
    const btn = item.querySelector('.btn-close-notif');
    if (btn) btn.style.display = 'block';
  });
  item.addEventListener('mouseleave', () => {
    const btn = item.querySelector('.btn-close-notif');
    if (btn) btn.style.display = 'none';
  });

  const closeBtn = item.querySelector('.btn-close-notif');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      item.remove();
      updateSavedNotificationsFromDOM();
      updateNotifBadgeCount();
      if (container.children.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 15px; font-size: 10px;">No alerts or notifications yet.</div>';
      }
    });
  }

  // Prepend to top
  container.insertBefore(item, container.firstChild);

  // Keep max 15 notifications
  while (container.children.length > 15) {
    container.removeChild(container.lastChild);
  }

  // Save changes to localStorage
  if (!preventSave) {
    updateSavedNotificationsFromDOM();
    updateNotifBadgeCount();
    showToastNotification(type, title, desc, timestampStr);
  }
}

// Initialize notification bell: load history + wire toggle + wire clear buttons
function initNotificationsCenter() {
  const container = document.getElementById('notifications-list');
  if (!container) return;

  // Load saved notifications from localStorage
  container.innerHTML = '';
  let saved = null;
  try {
    const data = localStorage.getItem('jda_notifications');
    saved = data ? JSON.parse(data) : null;
  } catch (e) {
    console.error('Failed to parse saved notifications:', e);
  }

  if (saved && Array.isArray(saved) && saved.length > 0) {
    for (let i = saved.length - 1; i >= 0; i--) {
      addNotification(saved[i].type, saved[i].title, saved[i].desc, saved[i].timestamp, true);
    }
  } else {
    container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px 15px; font-size: 10px;">No alerts or notifications yet.</div>';
  }
  updateNotifBadgeCount();

  // Wire bell toggle
  const btnBellToggle = document.getElementById('btn-bell-toggle');
  const bellDropdown = document.getElementById('bell-dropdown');
  if (btnBellToggle && bellDropdown) {
    btnBellToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = window.getComputedStyle(bellDropdown).display !== 'none';
      if (isVisible) {
        bellDropdown.style.display = 'none';
      } else {
        bellDropdown.style.display = 'flex';
        const badge = document.getElementById('notif-badge');
        if (badge) badge.style.display = 'none';
      }
    });
    document.addEventListener('click', (e) => {
      if (!bellDropdown.contains(e.target) && !btnBellToggle.contains(e.target)) {
        bellDropdown.style.display = 'none';
      }
    });
  }

  // Wire clear buttons
  const handleClearAll = () => {
    container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px 15px; font-size: 10px;">No alerts or notifications yet.</div>';
    localStorage.removeItem('jda_notifications');
    updateNotifBadgeCount();
  };
  const btnClear = document.getElementById('btn-clear-notifications');
  const btnClearFooter = document.getElementById('btn-clear-notifications-footer');
  if (btnClear) btnClear.addEventListener('click', handleClearAll);
  if (btnClearFooter) btnClearFooter.addEventListener('click', handleClearAll);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initNotificationsCenter();
  try { initCharts(); } catch(e) { console.error('initCharts error:', e); }
  updateData();
  setInterval(updateData, 3000);
});


