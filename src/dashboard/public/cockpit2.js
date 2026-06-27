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
let heatmapChart = null;
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
  const heatmapDom = document.getElementById('heatmap-canvas-container');
  if (heatmapDom) {
    heatmapChart = echarts.init(heatmapDom);
    window.addEventListener('resize', () => heatmapChart.resize());
  }

  const cvdDom = document.getElementById('cvd-chart-container');
  if (cvdDom) {
    cvdChart = echarts.init(cvdDom);
    window.addEventListener('resize', () => cvdChart.resize());
  }
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
    const trades = await tradesRes.json();
    updateActivePosition(trades);

    // Update settings check
    if (!isSavingSettings) {
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        autoTradeToggle.checked = settings.autoTradeEnabled || false;
      }
    }

    // Load Heatmap Data
    await updateHeatmap();

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

function updateReversalStrategy(summary) {
  const bps = summary.botPhaseState;
  if (!bps) return;

  const now = new Date();
  strategyLastUpdate.innerText = now.toLocaleTimeString();

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

function updateOrderbookAndWhales(summary) {
  const m = summary.metrics;
  const now = new Date();
  obUpdateTime.innerText = now.toLocaleTimeString();

  // Bids / Asks ratio
  if (m.depthDelta) {
    // If we have detail ratio in summary
    const bidPct = summary.orderbookRatio?.bidPercent || 50;
    const askPct = summary.orderbookRatio?.askPercent || 50;
    
    obDepthBid.style.width = `${bidPct}%`;
    obDepthBid.innerText = `${bidPct.toFixed(0)}%`;
    obDepthAsk.style.width = `${askPct}%`;
    obDepthAsk.innerText = `${askPct.toFixed(0)}%`;
    depthRatioLabel.innerText = `${bidPct.toFixed(0)}% Bids / ${askPct.toFixed(0)}% Asks`;
  }

  // Whale order book walls
  if (m.whaleOrders && whaleWallsGrid) {
    const buyWalls = m.whaleOrders.top3Buy || [];
    const sellWalls = m.whaleOrders.top3Sell || [];

    let wallsHtml = '';
    const maxLen = Math.max(buyWalls.length, sellWalls.length);

    if (maxLen > 0) {
      for (let i = 0; i < maxLen; i++) {
        const buy = buyWalls[i];
        const sell = sellWalls[i];

        // Bid column item
        if (buy) {
          wallsHtml += `
            <div style="color: var(--accent-success); border-left: 2px solid var(--accent-success); padding-left: 6px; background: rgba(14,203,129,0.03); border-radius: 4px; padding: 4px 6px;">
              <div>$${parseFloat(buy.price).toLocaleString()}</div>
              <div style="font-size: 9px; color: var(--text-muted); margin-top: 1px;">${buy.valueUsdFormatted} (${buy.exchange})</div>
            </div>
          `;
        } else {
          wallsHtml += `<div></div>`;
        }

        // Ask column item
        if (sell) {
          wallsHtml += `
            <div style="color: var(--accent-alert); border-left: 2px solid var(--accent-alert); padding-left: 6px; background: rgba(246,70,93,0.03); border-radius: 4px; padding: 4px 6px; text-align: right;">
              <div>$${parseFloat(sell.price).toLocaleString()}</div>
              <div style="font-size: 9px; color: var(--text-muted); margin-top: 1px;">${sell.valueUsdFormatted} (${sell.exchange})</div>
            </div>
          `;
        } else {
          wallsHtml += `<div></div>`;
        }
      }
      whaleWallsGrid.innerHTML = wallsHtml;
    } else {
      whaleWallsGrid.innerHTML = `<div style="color: var(--text-muted); text-align: center; grid-column: span 2; padding: 15px;">Tidak ada dinding order paus terdeteksi</div>`;
    }
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

async function updateHeatmap() {
  if (!heatmapChart) return;

  const url = activePeriod === '24h' ? '/api/heatmap' : '/api/heatmap3d';
  const res = await fetch(url);
  if (!res.ok) return;
  const raw = await res.json();
  const data = raw.data?.data || raw.data || raw;

  if (!data || !data.xAxis || !data.yAxis || !data.series) return;

  // Render heatmap
  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  if (!heatmapSeries) return;

  // We map heatmap data to ECharts format
  const chartOption = {
    backgroundColor: 'transparent',
    tooltip: {
      show: true,
      position: 'top',
      formatter: (params) => {
        const price = data.yAxis[params.value[1]];
        const vol = params.value[2];
        return `Harga: $${parseFloat(price).toLocaleString()}<br/>Volume Likuidasi: $${formatIntensity(vol)}`;
      }
    },
    grid: { left: 55, right: 15, top: 15, bottom: 25 },
    xAxis: {
      type: 'category',
      data: data.xAxis,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
      axisLabel: { show: false }
    },
    yAxis: {
      type: 'category',
      data: data.yAxis.map(y => `$${(parseFloat(y) / 1000).toFixed(2)}K`),
      axisLine: { show: false },
      axisLabel: { color: 'var(--text-muted)', fontSize: 9 }
    },
    visualMap: {
      min: 0,
      max: activePeriod === '24h' ? 20000000 : 50000000,
      calculable: true,
      realtime: true,
      show: false,
      inRange: {
        color: [
          'rgba(26, 2, 43, 0.4)',
          'rgba(30, 8, 120, 0.6)',
          'rgba(9, 143, 107, 0.8)',
          'rgba(240, 185, 11, 0.95)',
          'rgba(255, 255, 255, 1)'
        ]
      }
    },
    series: [{
      name: 'Liquidation Intensity',
      type: 'heatmap',
      data: heatmapSeries.data,
      label: { show: false },
      emphasis: {
        itemStyle: {
          shadowBlur: 10,
          shadowColor: 'rgba(0, 0, 0, 0.5)'
        }
      }
    }]
  };
  
  heatmapChart.setOption(chartOption, true);
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
      if (heatmapChart) heatmapChart.resize();
      if (cvdChart) cvdChart.resize();
    }, 300);
  });
}

// Period Selection Listeners
btnPeriod24h.addEventListener('click', () => {
  activePeriod = '24h';
  btnPeriod24h.style.background = 'var(--accent-primary)';
  btnPeriod24h.style.color = '#000';
  btnPeriod3d.style.background = 'rgba(255,255,255,0.05)';
  btnPeriod3d.style.color = 'var(--text-muted)';
  updateHeatmap();
});

btnPeriod3d.addEventListener('click', () => {
  activePeriod = '3d';
  btnPeriod3d.style.background = 'var(--accent-primary)';
  btnPeriod3d.style.color = '#000';
  btnPeriod24h.style.background = 'rgba(255,255,255,0.05)';
  btnPeriod24h.style.color = 'var(--text-muted)';
  updateHeatmap();
});

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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  updateData();
  setInterval(updateData, 3000);
});
