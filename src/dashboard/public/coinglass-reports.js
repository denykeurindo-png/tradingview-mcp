document.addEventListener('DOMContentLoaded', () => {
  // Constants & State
  let activeTab = 'depth-delta';
  let charts = {};

  // DOM Elements
  const tabButtons = document.querySelectorAll('.report-tab-btn');
  const panels = document.querySelectorAll('.report-content-panel');
  const refreshBtn = document.getElementById('btn-refresh');
  const connectionStatus = document.getElementById('connection-status');

  // Parse URL tab parameter on load
  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = urlParams.get('tab');
  if (tabParam && ['depth-delta', 'coinbase-premium', 'whale-orders', 'whale-retail-delta', 'top-trader-ls'].includes(tabParam)) {
    activeTab = tabParam;
  }

  // Set initial active tab and load summary
  switchTab(activeTab);
  loadMarketSummary();

  // Tab click handlers
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      // Update URL query parameter without reloading
      const newUrl = `${window.location.pathname}?tab=${targetTab}`;
      window.history.pushState({ path: newUrl }, '', newUrl);
      switchTab(targetTab);
    });
  });

  // Refresh button handler
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadMarketSummary();
      loadTabData(activeTab, true);
    });
  }

  // Handle window resizing to adjust ECharts layout
  window.addEventListener('resize', () => {
    Object.values(charts).forEach(chart => {
      if (chart) chart.resize();
    });
  });

  // Functions
  function switchTab(tabId) {
    activeTab = tabId;

    // Toggle tab buttons active state
    tabButtons.forEach(btn => {
      if (btn.getAttribute('data-tab') === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Toggle panels active state
    panels.forEach(panel => {
      if (panel.id === `panel-${tabId}`) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });

    // Update sidebar navigation active state
    document.querySelectorAll('.sidebar-item').forEach(item => {
      item.classList.remove('active');
    });
    const sidebarItem = document.getElementById(`nav-${tabId}`);
    if (sidebarItem) {
      sidebarItem.classList.add('active');
    }

    // Trigger data loading for current tab
    loadTabData(tabId);
  }

  async function loadTabData(tabId, forceRefresh = false) {
    setLoadingState(tabId, true);
    updateConnectionIndicator('loading');

    try {
      const url = `/api/${tabId}${forceRefresh ? '?refresh=true' : ''}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('A scrape is already in progress. Please try again in a few moments.');
        }
        throw new Error(`HTTP Error ${response.status}`);
      }

      const res = await response.json();
      if (!res.success) {
        throw new Error(res.error || 'Failed to fetch data');
      }

      const timestamp = res.data && res.data.timestamp ? new Date(res.data.timestamp).toLocaleString() : new Date().toLocaleString();
      document.getElementById(`update-${tabId}`).innerText = `Last updated: ${timestamp} (${res.source || 'cache'})`;

      if (tabId === 'whale-orders') {
        renderWhaleOrdersTable(res.data, res.btcPrice || 65000);
      } else if (tabId === 'top-trader-ls') {
        renderTopTraderLsTable(res.data);
      } else {
        renderEChart(tabId, res.data);
      }
      
      updateConnectionIndicator('ok');
    } catch (err) {
      console.error(`Error loading data for ${tabId}:`, err);
      showError(tabId, err.message);
      updateConnectionIndicator('error');
    } finally {
      setLoadingState(tabId, false);
    }
  }

  function setLoadingState(tabId, isLoading) {
    if (tabId === 'whale-orders' || tabId === 'top-trader-ls') {
      const tbodyId = tabId === 'whale-orders' ? 'whale-orders-tbody' : 'top-trader-ls-tbody';
      const cols = tabId === 'whale-orders' ? 9 : 5;
      const msg = tabId === 'whale-orders' ? 'Loading whale orders...' : 'Loading top trader ratios...';
      if (isLoading) {
        document.getElementById(tbodyId).innerHTML = `
          <tr>
            <td colspan="${cols}" style="text-align: center; color: #848E9C;">
              <span class="spinner"></span> ${msg} (CDP scrape might take 10-15s if refreshing)
            </td>
          </tr>
        `;
      }
    } else {
      const container = document.getElementById(`chart-${tabId}`);
      if (isLoading && !charts[tabId]) {
        container.innerHTML = `
          <div style="display:flex; justify-content:center; align-items:center; height:100%; color:#848E9C;">
            Loading chart data... (CDP scrape might take 10-15s if refreshing)
          </div>
        `;
      }
    }
  }

  function showError(tabId, message) {
    if (tabId === 'whale-orders' || tabId === 'top-trader-ls') {
      const tbodyId = tabId === 'whale-orders' ? 'whale-orders-tbody' : 'top-trader-ls-tbody';
      const cols = tabId === 'whale-orders' ? 9 : 5;
      document.getElementById(tbodyId).innerHTML = `
        <tr>
          <td colspan="${cols}" style="text-align: center; color: #F6465D;">
            <strong>Error:</strong> ${message}
          </td>
        </tr>
      `;
    } else {
      const container = document.getElementById(`chart-${tabId}`);
      container.innerHTML = `
        <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:#F6465D; padding:20px; text-align:center;">
          <svg style="width:48px;height:48px;margin-bottom:12px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <strong>Error Loading Report:</strong>
          <span style="font-size:12px; margin-top:6px; color:#848E9C;">${message}</span>
        </div>
      `;
      if (charts[tabId]) {
        charts[tabId].dispose();
        charts[tabId] = null;
      }
    }
  }

  function renderEChart(tabId, cacheData) {
    const container = document.getElementById(`chart-${tabId}`);
    if (!cacheData || !cacheData.data || !cacheData.data.length) {
      throw new Error('No chart data found in response.');
    }

    const firstChart = cacheData.data[0];
    if (!firstChart.xAxis || !firstChart.series) {
      throw new Error('Chart structure is invalid or empty.');
    }

    // Initialize ECharts instance if not done already
    if (!charts[tabId]) {
      container.innerHTML = '';
      charts[tabId] = echarts.init(container, 'dark');
    }

    const isPremium = tabId === 'coinbase-premium' || tabId === 'whale-retail-delta';

    // Build configuration options
    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: '#1E2026',
        borderColor: '#2B3139',
        textStyle: { color: '#EAECEF' }
      },
      legend: {
        data: firstChart.series.map(s => s.name),
        textStyle: { color: '#848E9C' },
        top: 0
      },
      grid: {
        left: '2%',
        right: '2%',
        bottom: '5%',
        top: '12%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        data: firstChart.xAxis || [],
        axisLine: { lineStyle: { color: '#2B3139' } },
        axisLabel: { color: '#848E9C', fontSize: 10 },
        axisTick: { show: false }
      },
      yAxis: isPremium ? [
        {
          type: 'value',
          name: 'Premium',
          scale: true,
          axisLine: { lineStyle: { color: '#2B3139' } },
          axisLabel: { 
            color: '#848E9C', 
            fontSize: 10,
            formatter: '{value}%'
          },
          splitLine: { lineStyle: { color: '#2B3139', type: 'dashed' } }
        },
        {
          type: 'value',
          name: 'Price',
          scale: true,
          axisLine: { lineStyle: { color: '#2B3139' } },
          axisLabel: { 
            color: '#848E9C', 
            fontSize: 10,
            formatter: function(value) {
              return '$' + (value >= 1000 ? (value / 1000).toFixed(0) + 'K' : value);
            }
          },
          splitLine: { show: false }
        }
      ] : {
        type: 'value',
        scale: true,
        axisLine: { lineStyle: { color: '#2B3139' } },
        axisLabel: { color: '#848E9C', fontSize: 10 },
        splitLine: { lineStyle: { color: '#2B3139', type: 'dashed' } }
      },
      series: firstChart.series.map((s, idx) => {
        const isPrice = s.name.toLowerCase().includes('price') || s.name.toLowerCase().includes('close');
        
        let color = '#F0B90B'; // default JDA yellow
        if (s.name.toLowerCase().includes('delta') || s.name.toLowerCase().includes('premium')) {
          color = '#0ECB81'; // Green accent
        } else if (isPrice) {
          color = '#848E9C'; // Muted grey
        }

        return {
          name: s.name,
          type: s.type || 'line',
          data: s.data,
          yAxisIndex: (isPremium && isPrice) ? 1 : 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: color },
          itemStyle: {
            color: function (params) {
              if (s.name.toLowerCase().includes('delta')) {
                const val = Array.isArray(params.value) ? parseFloat(params.value[1]) : parseFloat(params.value);
                return val >= 0 ? '#0ECB81' : '#F6465D';
              }
              return color;
            }
          },
          areaStyle: (tabId === 'depth-delta' && s.type !== 'bar') ? {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(14, 203, 129, 0.2)' },
              { offset: 1, color: 'rgba(14, 203, 129, 0)' }
            ])
          } : undefined
        };
      })
    };

    charts[tabId].setOption(option);
  }

  function renderWhaleOrdersTable(cacheData, btcPrice = 65000) {
    const tbody = document.getElementById('whale-orders-tbody');
    const orders = Array.isArray(cacheData) ? cacheData : (cacheData && cacheData.data ? cacheData.data : []);

    if (!orders || orders.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; color: #848E9C; padding: 20px;">
            No active whale orders found matching the filter (>= $2M, >= 24H).
          </td>
        </tr>
      `;
      return;
    }

    const maxValue = Math.max(...orders.map(o => o.valueUsd || 0), 1);

    tbody.innerHTML = orders.map((order, idx) => {
      const sideClass = order.side === 'buy' ? 'side-buy' : 'side-sell';
      const sideText = order.side ? order.side.toUpperCase() : 'UNKNOWN';
      
      // Clean formatted volume: e.g. $2.00M or $15.50M to match heatmap design
      const formatVolume = (val) => {
        if (val >= 1e9) return (val / 1e9).toFixed(2) + 'B';
        if (val >= 1e6) return (val / 1e6).toFixed(2) + 'M';
        if (val >= 1e3) return (val / 1e3).toFixed(0) + 'K';
        return val.toFixed(0);
      };
      const valueFormatted = '$' + formatVolume(order.valueUsd);
      
      const priceFormatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(order.price);

      // Distance calculation
      const distancePercent = ((order.price - btcPrice) / btcPrice) * 100;
      const distSign = distancePercent > 0 ? '+' : '';
      const distFormatted = `${distSign}${distancePercent.toFixed(2)}%`;
      const distColor = distancePercent > 0 ? '#FF453A' : '#32D74B'; // Red above price, green below

      // Calculate intensity dynamically relative to max order value
      const ratio = (order.valueUsd || 0) / maxValue;
      let badgeClass = 'low';
      let badgeLabel = 'Low';
      if (ratio >= 0.7) {
        badgeClass = 'high';
        badgeLabel = 'High';
      } else if (ratio >= 0.3) {
        badgeClass = 'medium';
        badgeLabel = 'Medium';
      }

      return `
        <tr>
          <td style="color: #848E9C;">#${idx + 1}</td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span>${order.exchange || 'Unknown'}</span>
            </div>
          </td>
          <td><span class="badge select-mono" style="background:#2B3139; color:#EAECEF; padding:2px 6px; border-radius:4px; font-size:11px;">${order.marketType || 'P'}</span></td>
          <td class="select-mono" style="font-weight: 600; color: #FFFFFF;">${priceFormatted}</td>
          <td class="select-mono" style="font-weight: 600; color: ${order.side === 'buy' ? '#32D74B' : '#FF453A'};">${valueFormatted}</td>
          <td class="select-mono" style="font-weight: 500; color: ${distColor};">${distFormatted}</td>
          <td><span class="intensity-badge ${badgeClass}">${badgeLabel}</span></td>
          <td class="select-mono" style="color: #848E9C;">${order.age || '--'}</td>
          <td class="${sideClass}">${sideText}</td>
        </tr>
      `;
    }).join('');
  }

  function updateConnectionIndicator(status) {
    if (!connectionStatus) return;
    
    connectionStatus.className = 'status-indicator';
    const dot = connectionStatus.querySelector('.status-dot');
    const txt = connectionStatus.querySelector('.status-text');

    if (status === 'loading') {
      connectionStatus.classList.add('warning');
      txt.innerText = 'Syncing...';
    } else if (status === 'ok') {
      connectionStatus.classList.add('normal');
      txt.innerText = 'Connected';
    } else {
      connectionStatus.classList.add('critical');
      txt.innerText = 'Error';
    }
  }

  function renderTopTraderLsTable(cacheData) {
    const tbody = document.getElementById('top-trader-ls-tbody');
    const innerData = cacheData && cacheData.data ? cacheData.data : cacheData;
    const rows = innerData && innerData.rows ? innerData.rows : [];

    if (!rows || rows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #848E9C; padding: 20px;">
            No top trader long/short ratio data found.
          </td>
        </tr>
      `;
      return;
    }

    // Accounts columns mapping in the raw scraped table:
    // Binance U (Accounts) is index 8
    // Binance C (Accounts) is index 9
    // HTX U (Accounts) is index 10
    // HTX C (Accounts) is index 11
    // HTX F (Accounts) is index 12
    // OKX (Accounts) is index 13
    const accountsColumns = [
      { name: 'Binance U', index: 8 },
      { name: 'Binance C', index: 9 },
      { name: 'HTX U', index: 10 },
      { name: 'HTX C', index: 11 },
      { name: 'HTX F', index: 12 },
      { name: 'OKX', index: 13 }
    ];

    const mappedRows = [];

    rows.forEach(row => {
      const symbol = row[0] || 'Unknown';
      
      accountsColumns.forEach(col => {
        const val = row[col.index];
        if (val && val.trim() !== '' && val.includes('%')) {
          const longPercentVal = parseFloat(val);
          if (!isNaN(longPercentVal)) {
            const shortPercentVal = 100 - longPercentVal;
            const ratio = shortPercentVal > 0 ? (longPercentVal / shortPercentVal) : longPercentVal;
            mappedRows.push({
              symbol: symbol,
              exchange: col.name,
              ratio: ratio,
              longPercent: longPercentVal.toFixed(2) + '%',
              shortPercent: shortPercentVal.toFixed(2) + '%'
            });
          }
        }
      });
    });

    if (mappedRows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #848E9C; padding: 20px;">
            No active top trader long/short ratio data found.
          </td>
        </tr>
      `;
      return;
    }

    // Sort by ratio desc
    mappedRows.sort((a, b) => b.ratio - a.ratio);

    tbody.innerHTML = mappedRows.map(item => {
      const ratioColor = item.ratio > 1 ? '#0ECB81' : (item.ratio < 1 && item.ratio > 0 ? '#F6465D' : '#EAECEF');

      return `
        <tr>
          <td style="font-weight: 600; color: #FFFFFF;">${item.symbol}</td>
          <td style="color: #848E9C;">${item.exchange}</td>
          <td class="select-mono" style="font-weight: 600; color: ${ratioColor};">${item.ratio.toFixed(2)}</td>
          <td class="select-mono" style="color: #0ECB81;">${item.longPercent}</td>
          <td class="select-mono" style="color: #F6465D;">${item.shortPercent}</td>
        </tr>
      `;
    }).join('');
  }

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
      `;

      summaryCard.style.display = 'block';
    } catch (err) {
      console.error('Error fetching market summary:', err);
      summaryContent.innerHTML = `<span style="color: #F6465D;">Gagal memuat ringkasan pasar: ${err.message}</span>`;
      summaryCard.style.display = 'block';
    }
  }
});
