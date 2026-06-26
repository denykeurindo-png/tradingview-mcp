// JDA Trade Monitor — Combined Market Depth Frontend Logic

let depthChart = null;

// Initialize ECharts for Market Depth
function initDepthChart() {
  const chartDom = document.getElementById('depth-chart');
  if (!chartDom) return;
  
  depthChart = echarts.init(chartDom);
  
  const option = {
    backgroundColor: 'transparent',
    title: { show: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20, 22, 26, 0.95)',
      borderColor: 'rgba(255, 255, 255, 0.08)',
      borderWidth: 1,
      textStyle: { color: '#eaecef', fontSize: 11, fontFamily: 'Inter' },
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'rgba(255, 255, 255, 0.15)', type: 'dashed' }
      },
      formatter: function(params) {
        let res = `<div style="font-weight: 700; margin-bottom: 4px;">BTC Price: $${parseFloat(params[0].axisValue).toLocaleString(undefined, {minimumFractionDigits: 1})}</div>`;
        params.forEach(p => {
          const colorDot = `<span style="display:inline-block;margin-right:5px;border-radius:50%;width:8px;height:8px;background-color:${p.color};"></span>`;
          res += `${colorDot}${p.seriesName}: <b>${parseFloat(p.value).toFixed(3)} BTC</b><br/>`;
        });
        return res;
      }
    },
    grid: {
      left: '3%',
      right: '3%',
      bottom: '5%',
      top: '5%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: [],
      axisLine: { lineStyle: { color: '#2B3139' } },
      axisLabel: {
        color: '#848E9C',
        fontSize: 10,
        formatter: value => '$' + parseFloat(value).toLocaleString(undefined, {maximumFractionDigits: 0})
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      position: 'right',
      axisLine: { show: false },
      axisLabel: { color: '#848E9C', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.03)' } }
    },
    series: [
      {
        name: 'Bids (Cumulative)',
        type: 'line',
        smooth: true,
        symbol: 'none',
        sampling: 'average',
        itemStyle: { color: '#0ECB81' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(14, 203, 129, 0.25)' },
            { offset: 1, color: 'rgba(14, 203, 129, 0.01)' }
          ])
        },
        data: []
      },
      {
        name: 'Asks (Cumulative)',
        type: 'line',
        smooth: true,
        symbol: 'none',
        sampling: 'average',
        itemStyle: { color: '#F6465D' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(246, 70, 93, 0.25)' },
            { offset: 1, color: 'rgba(246, 70, 93, 0.01)' }
          ])
        },
        data: []
      }
    ]
  };
  
  depthChart.setOption(option);
}

// Update the visual ECharts depth chart
function updateDepthChart(bids, asks, midPrice) {
  if (!depthChart) return;

  // Filter data to within +/- 3% of the mid price to focus on the active trading zone
  const rangePercent = 0.03;
  const minPrice = midPrice * (1 - rangePercent);
  const maxPrice = midPrice * (1 + rangePercent);

  const filteredBids = bids.filter(b => b.price >= minPrice).sort((a, b) => a.price - b.price); // Ascending for chart
  const filteredAsks = asks.filter(a => a.price <= maxPrice).sort((a, b) => a.price - b.price); // Ascending for chart

  // X-axis: All prices merged and sorted
  const bidPrices = filteredBids.map(b => b.price.toFixed(1));
  const askPrices = filteredAsks.map(a => a.price.toFixed(1));
  const allPrices = [...bidPrices, ...askPrices].sort((a, b) => parseFloat(a) - parseFloat(b));

  // Prepare chart data points
  // Bids cumulative totals: descending from mid price to left side
  const bidChartData = [];
  // Asks cumulative totals: ascending from mid price to right side
  const askChartData = [];

  allPrices.forEach(priceStr => {
    const priceNum = parseFloat(priceStr);
    
    // Find closest bid total
    if (priceNum <= midPrice) {
      // Find exact or closest lower bid
      const bid = filteredBids.find(b => Math.abs(b.price - priceNum) < 1.0);
      bidChartData.push(bid ? bid.total : '-');
      askChartData.push('-');
    } else {
      // Find exact or closest higher ask
      const ask = filteredAsks.find(a => Math.abs(a.price - priceNum) < 1.0);
      askChartData.push(ask ? ask.total : '-');
      bidChartData.push('-');
    }
  });

  // Update ECharts data
  depthChart.setOption({
    xAxis: { data: allPrices },
    series: [
      { data: bidChartData },
      { data: askChartData }
    ]
  });
}

// Format volume to K / M representation
function formatVolume(val) {
  if (val >= 1000000) return (val / 1000000).toFixed(2) + 'M';
  if (val >= 1000) return (val / 1000).toFixed(2) + 'K';
  return val.toFixed(2);
}

// Fetch and render the order book data
async function fetchOrderBook(refresh = false) {
  const syncStatusEl = document.getElementById('val-sync-status');
  const btnRefresh = document.getElementById('btn-refresh');
  
  if (syncStatusEl) syncStatusEl.innerHTML = '⏳ Syncing market depth...';
  if (btnRefresh) btnRefresh.disabled = true;

  try {
    const url = refresh ? '/api/orderbook-data?refresh=true' : '/api/orderbook-data';
    const res = await fetch(url);
    const result = await res.json();

    if (!result.success) {
      throw new Error(result.error || 'Unknown server error');
    }

    const { bids, asks, timestamp } = result.data;
    
    if (bids.length === 0 || asks.length === 0) {
      throw new Error('Order book returned empty bids/asks.');
    }

    // Sort: Bids (highest price first), Asks (lowest price first)
    const sortedBids = [...bids].sort((a, b) => b.price - a.price);
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price);

    const midPrice = (sortedBids[0].price + sortedAsks[0].price) / 2;

    // 1. Calculate KPI Metrics within 2% Range
    const rangeLimit = 0.02;
    const bidRangeLimit = midPrice * (1 - rangeLimit);
    const askRangeLimit = midPrice * (1 + rangeLimit);

    const bidsInRange = sortedBids.filter(b => b.price >= bidRangeLimit);
    const asksInRange = sortedAsks.filter(a => a.price <= askRangeLimit);

    // Sum quantities for the active 2% range
    const totalBidsQty = bidsInRange.reduce((sum, b) => sum + b.quantity, 0);
    const totalAsksQty = asksInRange.reduce((sum, a) => sum + a.quantity, 0);

    const totalBidsUsd = totalBidsQty * midPrice;
    const totalAsksUsd = totalAsksQty * midPrice;

    // Imbalance calculation
    const totalDepth = totalBidsQty + totalAsksQty;
    const bidRatio = totalDepth > 0 ? (totalBidsQty / totalDepth) : 0.5;
    const askRatio = totalDepth > 0 ? (totalAsksQty / totalDepth) : 0.5;
    const imbalanceRatio = totalAsksQty > 0 ? (totalBidsQty / totalAsksQty) : 1.0;

    // 2. Render KPI cards
    document.getElementById('val-btc-price').innerText = '$' + midPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    document.getElementById('foot-btc-price').innerText = `Spread: $${(sortedAsks[0].price - sortedBids[0].price).toFixed(2)} (${((sortedAsks[0].price - sortedBids[0].price)/midPrice*100).toFixed(4)}%)`;
    
    document.getElementById('val-total-bids').innerText = totalBidsQty.toLocaleString(undefined, {maximumFractionDigits: 0}) + ' BTC';
    document.getElementById('foot-total-bids-usd').innerText = `$${formatVolume(totalBidsUsd)} (2% Range)`;

    document.getElementById('val-total-asks').innerText = totalAsksQty.toLocaleString(undefined, {maximumFractionDigits: 0}) + ' BTC';
    document.getElementById('foot-total-asks-usd').innerText = `$${formatVolume(totalAsksUsd)} (2% Range)`;

    document.getElementById('val-imbalance-ratio').innerText = imbalanceRatio.toFixed(2);
    document.getElementById('val-imbalance-bar').style.width = (bidRatio * 100) + '%';
    document.getElementById('foot-imbalance-text').innerText = `${(bidRatio * 100).toFixed(1)}% Bids / ${(askRatio * 100).toFixed(1)}% Asks`;

    // 3. Update Depth Chart
    updateDepthChart(bids, asks, midPrice);

    // 4. Render Table rows (max 50 levels)
    const maxLevels = 50;
    const visibleBids = sortedBids.slice(0, maxLevels);
    const visibleAsks = sortedAsks.slice(0, maxLevels);

    // Find maximum cumulative total to scale the depth bars
    const maxBidTotal = visibleBids.length > 0 ? visibleBids[visibleBids.length - 1].total : 1;
    const maxAskTotal = visibleAsks.length > 0 ? visibleAsks[visibleAsks.length - 1].total : 1;
    const maxOverallTotal = Math.max(maxBidTotal, maxAskTotal);

    // Render Bids table
    const bidsTbody = document.getElementById('bids-table-body');
    bidsTbody.innerHTML = '';
    visibleBids.forEach(b => {
      const barWidth = (b.total / maxOverallTotal * 100).toFixed(1) + '%';
      const tr = document.createElement('tr');
      tr.className = 'bids-row';
      tr.innerHTML = `
        <td style="color: var(--accent-success); font-weight: 600;">$${b.price.toLocaleString(undefined, {minimumFractionDigits: 1})}</td>
        <td style="text-align: right; color: var(--text-main);">${b.quantity.toFixed(3)}</td>
        <td style="text-align: right; color: var(--text-muted);">${b.total.toFixed(2)}</td>
        <div class="depth-bar" style="width: ${barWidth};"></div>
      `;
      bidsTbody.appendChild(tr);
    });

    // Render Asks table (Asks usually rendered sorted from highest to lowest in order book view, but let's keep it lowest to highest for split side-by-side or ascending)
    const asksTbody = document.getElementById('asks-table-body');
    asksTbody.innerHTML = '';
    visibleAsks.forEach(a => {
      const barWidth = (a.total / maxOverallTotal * 100).toFixed(1) + '%';
      const tr = document.createElement('tr');
      tr.className = 'asks-row';
      tr.innerHTML = `
        <td style="color: var(--accent-alert); font-weight: 600;">$${a.price.toLocaleString(undefined, {minimumFractionDigits: 1})}</td>
        <td style="text-align: right; color: var(--text-main);">${a.quantity.toFixed(3)}</td>
        <td style="text-align: right; color: var(--text-muted);">${a.total.toFixed(2)}</td>
        <div class="depth-bar" style="width: ${barWidth};"></div>
      `;
      asksTbody.appendChild(tr);
    });

    // 5. Update Sync Status
    const formattedTime = new Date(timestamp).toLocaleTimeString();
    const sourceText = result.source === 'cache' ? 'Cached' : (result.source === 'fallback-cache' ? 'Fallback Cache' : 'Live');
    if (syncStatusEl) {
      syncStatusEl.innerHTML = `Synced: <b>${formattedTime}</b> (${sourceText})`;
      syncStatusEl.style.color = result.source === 'live' ? 'var(--accent-success)' : 'var(--text-muted)';
    }
  } catch (err) {
    console.error('[Frontend] Failed to fetch combined order book:', err.message);
    if (syncStatusEl) {
      syncStatusEl.innerHTML = `⚠️ Sync Error: <span style="color: var(--accent-alert);">${err.message}</span>`;
    }
  } finally {
    if (btnRefresh) btnRefresh.disabled = false;
  }
}

// Connection Status Monitor
function updateConnectionStatus() {
  const statusIndicator = document.getElementById('connection-status');
  if (statusIndicator) {
    statusIndicator.className = 'status-indicator normal';
    statusIndicator.querySelector('.status-text').innerText = 'Live';
  }
}

// Window resize handler for ECharts responsiveness
window.addEventListener('resize', () => {
  if (depthChart) depthChart.resize();
});

// Fetch and render consolidated market summary
async function loadMarketSummary() {
  const summaryCard = document.getElementById('market-summary-card');
  const summaryVerdict = document.getElementById('summary-verdict');
  const summaryContent = document.getElementById('summary-content');
  const summaryGrid = document.getElementById('summary-metrics-grid');

  if (!summaryCard) return;

  try {
    const response = await fetch('/api/coinglass-summary');
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const res = await response.json();
    if (!res.success) throw new Error(res.error || 'Failed to fetch summary');

    // Update Verdict Badge
    summaryVerdict.innerText = res.verdict;
    
    // Styling according to verdict
    let badgeBg = '#2B3139';
    let badgeColor = '#EAECEF';
    if (res.verdict.includes('STRONG BULLISH')) {
      badgeBg = 'rgba(14, 203, 129, 0.2)';
      badgeColor = '#0ECB81';
      summaryCard.style.border = '1px solid rgba(14, 203, 129, 0.3)';
      summaryCard.style.boxShadow = '0 0 15px rgba(14, 203, 129, 0.05)';
    } else if (res.verdict.includes('BULLISH')) {
      badgeBg = 'rgba(14, 203, 129, 0.15)';
      badgeColor = '#0ECB81';
      summaryCard.style.border = '1px solid rgba(14, 203, 129, 0.2)';
      summaryCard.style.boxShadow = 'none';
    } else if (res.verdict.includes('STRONG BEARISH')) {
      badgeBg = 'rgba(246, 70, 93, 0.2)';
      badgeColor = '#F6465D';
      summaryCard.style.border = '1px solid rgba(246, 70, 93, 0.3)';
      summaryCard.style.boxShadow = '0 0 15px rgba(246, 70, 93, 0.05)';
    } else if (res.verdict.includes('BEARISH')) {
      badgeBg = 'rgba(246, 70, 93, 0.15)';
      badgeColor = '#F6465D';
      summaryCard.style.border = '1px solid rgba(246, 70, 93, 0.2)';
      summaryCard.style.boxShadow = 'none';
    } else {
      badgeBg = 'rgba(240, 185, 11, 0.15)';
      badgeColor = '#F0B90B';
      summaryCard.style.border = '1px solid rgba(255, 255, 255, 0.08)';
      summaryCard.style.boxShadow = 'none';
    }

    summaryVerdict.style.background = badgeBg;
    summaryVerdict.style.color = badgeColor;

    // Update Explanation
    summaryContent.innerHTML = res.explanation.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Populate Grid Metrics
    const m = res.metrics;
    const getSentimentColor = (s) => s === 'bullish' ? '#0ECB81' : (s === 'bearish' ? '#F6465D' : '#848E9C');
    const getSentimentIcon = (s) => s === 'bullish' ? '▲' : (s === 'bearish' ? '▼' : '◆');

    summaryGrid.innerHTML = `
      <div style="background: rgba(255,255,255,0.02); padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 11px; color: #848E9C; margin-bottom: 4px; text-transform: uppercase;">Depth Delta</div>
        <div class="select-mono" style="font-size: 16px; font-weight: bold; color: ${getSentimentColor(m.depthDelta?.sentiment)};">
          ${getSentimentIcon(m.depthDelta?.sentiment)} ${m.depthDelta?.formatted || '--'}
        </div>
        <div style="font-size: 11px; color: #848E9C; margin-top: 4px;">${m.depthDelta?.description || ''}</div>
      </div>
      <div style="background: rgba(255,255,255,0.02); padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 11px; color: #848E9C; margin-bottom: 4px; text-transform: uppercase;">Coinbase Premium</div>
        <div class="select-mono" style="font-size: 16px; font-weight: bold; color: ${getSentimentColor(m.coinbasePremium?.sentiment)};">
          ${getSentimentIcon(m.coinbasePremium?.sentiment)} ${m.coinbasePremium?.formatted || '--'}
        </div>
        <div style="font-size: 11px; color: #848E9C; margin-top: 4px;">${m.coinbasePremium?.description || ''}</div>
      </div>
      <div style="background: rgba(255,255,255,0.02); padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 11px; color: #848E9C; margin-bottom: 4px; text-transform: uppercase;">Whale Orders</div>
        <div class="select-mono" style="font-size: 16px; font-weight: bold; color: ${getSentimentColor(m.whaleOrders?.sentiment)};">
          ${getSentimentIcon(m.whaleOrders?.sentiment)} ${m.whaleOrders?.sentiment === 'bullish' ? 'BUY BIAS' : (m.whaleOrders?.sentiment === 'bearish' ? 'SELL BIAS' : '--')}
        </div>
        <div style="font-size: 11px; color: #848E9C; margin-top: 4px;">${m.whaleOrders?.description || 'Tidak ada data'}</div>
      </div>
      <div style="background: rgba(255,255,255,0.02); padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 11px; color: #848E9C; margin-bottom: 4px; text-transform: uppercase;">Whale vs Retail</div>
        <div class="select-mono" style="font-size: 16px; font-weight: bold; color: ${getSentimentColor(m.whaleRetail?.sentiment)};">
          ${getSentimentIcon(m.whaleRetail?.sentiment)} ${m.whaleRetail?.formatted || '--'}
        </div>
        <div style="font-size: 11px; color: #848E9C; margin-top: 4px;">${m.whaleRetail?.description || ''}</div>
      </div>
      <div style="background: rgba(255,255,255,0.02); padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 11px; color: #848E9C; margin-bottom: 4px; text-transform: uppercase;">Top Trader L/S</div>
        <div class="select-mono" style="font-size: 16px; font-weight: bold; color: ${getSentimentColor(m.topTraderLs?.sentiment)};">
          ${getSentimentIcon(m.topTraderLs?.sentiment)} ${m.topTraderLs?.formatted || '--'}
        </div>
        <div style="font-size: 11px; color: #848E9C; margin-top: 4px;">${m.topTraderLs?.description || ''}</div>
      </div>
      <div style="background: rgba(255,255,255,0.02); padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 11px; color: #848E9C; margin-bottom: 4px; text-transform: uppercase;">Combined Depth</div>
        <div class="select-mono" style="font-size: 16px; font-weight: bold; color: ${getSentimentColor(m.combinedDepth?.sentiment)};">
          ${getSentimentIcon(m.combinedDepth?.sentiment)} ${m.combinedDepth?.formatted || '--'}
        </div>
        <div style="font-size: 11px; color: #848E9C; margin-top: 4px;">${m.combinedDepth?.description || ''}</div>
      </div>
    `;

    summaryCard.style.display = 'block';
  } catch (err) {
    console.error('Error fetching market summary:', err);
    summaryContent.innerHTML = `<span style="color: #F6465D;">Gagal memuat ringkasan pasar: ${err.message}</span>`;
    summaryCard.style.display = 'block';
  }
}

// Document Ready Setup
document.addEventListener('DOMContentLoaded', () => {
  initDepthChart();
  updateConnectionStatus();
  fetchOrderBook(); // Initial load
  loadMarketSummary(); // Load market summary on page load

  // Bind refresh button click event
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      fetchOrderBook(true); // Force refresh depth
      loadMarketSummary(); // Refresh summary too
    });
  }

  // Periodic auto-sync every 30 seconds
  setInterval(() => {
    fetchOrderBook(false); // Passive sync
    loadMarketSummary(); // Passive sync summary
  }, 30000);
});
