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
  if (tabParam && ['depth-delta', 'coinbase-premium', 'whale-orders'].includes(tabParam)) {
    activeTab = tabParam;
  }

  // Set initial active tab
  switchTab(activeTab);

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
        renderWhaleOrdersTable(res.data);
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
    if (tabId === 'whale-orders') {
      if (isLoading) {
        document.getElementById('whale-orders-tbody').innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; color: #848E9C;">
              <span class="spinner"></span> Loading whale orders... (CDP scrape might take 10-15s if refreshing)
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
    if (tabId === 'whale-orders') {
      document.getElementById('whale-orders-tbody').innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: #F6465D;">
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

    const isPremium = tabId === 'coinbase-premium';

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
          axisLine: { lineStyle: { color: '#2B3139' } },
          axisLabel: { color: '#848E9C', fontSize: 10 },
          splitLine: { lineStyle: { color: '#2B3139', type: 'dashed' } }
        },
        {
          type: 'value',
          name: 'Price',
          axisLine: { lineStyle: { color: '#2B3139' } },
          axisLabel: { color: '#848E9C', fontSize: 10 },
          splitLine: { show: false }
        }
      ] : {
        type: 'value',
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
          itemStyle: { color: color },
          areaStyle: (tabId === 'depth-delta') ? {
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

  function renderWhaleOrdersTable(cacheData) {
    const tbody = document.getElementById('whale-orders-tbody');
    const orders = Array.isArray(cacheData) ? cacheData : (cacheData && cacheData.data ? cacheData.data : []);

    if (!orders || orders.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: #848E9C; padding: 20px;">
            No active whale orders found matching the filter (>= $2M, >= 24H).
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = orders.map(order => {
      const sideClass = order.side === 'buy' ? 'side-buy' : 'side-sell';
      const sideText = order.side ? order.side.toUpperCase() : 'UNKNOWN';
      const valueFormatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
      }).format(order.valueUsd);
      
      const priceFormatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(order.price);

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span>${order.exchange || 'Unknown'}</span>
            </div>
          </td>
          <td><span class="badge select-mono" style="background:#2B3139; color:#EAECEF; padding:2px 6px; border-radius:4px; font-size:11px;">${order.marketType || 'P'}</span></td>
          <td class="select-mono" style="font-weight: 500;">${priceFormatted}</td>
          <td class="select-mono" style="font-weight: 500;">${valueFormatted}</td>
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
});
