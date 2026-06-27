document.addEventListener('DOMContentLoaded', () => {
  // State
  let activeCoin = 'BTC/USDT';
  let activeTab = 'markets';
  let chartInstances = [];
  let rawCacheData = null;

  // DOM Elements
  const connectionStatus = document.getElementById('connection-status');
  const refreshBtn = document.getElementById('btn-refresh');
  const tickerSearch = document.getElementById('ticker-search');
  const tickerTbody = document.getElementById('ticker-tbody');
  
  const detailCoinSymbol = document.getElementById('detail-coin-symbol');
  const detailCoinPrice = document.getElementById('detail-coin-price');
  const detailCoinChange = document.getElementById('detail-coin-change');
  const rangeDayLow = document.getElementById('range-day-low');
  const rangeDayHigh = document.getElementById('range-day-high');
  const rangeBarFill = document.getElementById('range-bar-fill');
  const rangeBarPointer = document.getElementById('range-bar-pointer');
  
  const statVol = document.getElementById('stat-vol');
  const statFunding = document.getElementById('stat-funding');
  const statOi = document.getElementById('stat-oi');
  const statLsRatio = document.getElementById('stat-ls-ratio');

  const perf7d = document.getElementById('perf-7d');
  const perf30d = document.getElementById('perf-30d');
  const perf90d = document.getElementById('perf-90d');
  const perf180d = document.getElementById('perf-180d');
  const perfYtd = document.getElementById('perf-ytd');
  const perf1y = document.getElementById('perf-1y');

  const perf7dCell = document.getElementById('perf-7d-cell');
  const perf30dCell = document.getElementById('perf-30d-cell');
  const perf90dCell = document.getElementById('perf-90d-cell');
  const perf180dCell = document.getElementById('perf-180d-cell');
  const perfYtdCell = document.getElementById('perf-ytd-cell');
  const perf1yCell = document.getElementById('perf-1y-cell');

  // Load Initial Data
  loadTvData();

  // Refresh handler
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadTvData(true);
    });
  }

  // Search filter
  if (tickerSearch) {
    tickerSearch.addEventListener('input', () => {
      renderTickerTable();
    });
  }

  // Resize window handler
  window.addEventListener('resize', () => {
    chartInstances.forEach(c => c.resize());
  });

  // Ticker tabs
  const tabMarkets = document.getElementById('tab-markets');
  const tabFavorites = document.getElementById('tab-favorites');
  const tabTrending = document.getElementById('tab-trending');

  [tabMarkets, tabFavorites, tabTrending].forEach(btn => {
    if (btn) {
      btn.addEventListener('click', () => {
        [tabMarkets, tabFavorites, tabTrending].forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.id.replace('tab-', '');
        renderTickerTable();
      });
    }
  });

  // Functions
  async function loadTvData(forceRefresh = false) {
    updateStatus('loading', 'Loading data...');
    try {
      const url = `/api/coinglass-tv${forceRefresh ? '?refresh=true' : ''}`;
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('Scrape is already in progress, please wait.');
        }
        throw new Error(`HTTP error ${response.status}`);
      }

      const res = await response.json();
      if (!res.success) {
        throw new Error(res.error || 'Failed to load TV data');
      }

      rawCacheData = res.data;
      
      const timestamp = rawCacheData.timestamp ? new Date(rawCacheData.timestamp).toLocaleString() : new Date().toLocaleString();
      document.getElementById('update-coinglass-tv').innerText = `Last updated: ${timestamp} (${res.source || 'cache'})`;
      document.getElementById('top-bar-update').innerText = `Last updated: ${timestamp}`;

      renderTickerTable();
      updateDetailWidget();
      renderMultiPaneChart();
      updateStatus('ok', 'Connected');
    } catch (err) {
      console.error('Error loading TV data:', err);
      updateStatus('error', err.message);
      showChartError(err.message);
    }
  }

  function updateStatus(state, message) {
    if (connectionStatus) {
      connectionStatus.className = `status-indicator ${state}`;
      connectionStatus.querySelector('.status-text').innerText = message;
    }
  }

  function showChartError(message) {
    const container = document.getElementById('tv-charts-container');
    if (container) {
      container.innerHTML = `
        <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:#F6465D; padding:20px; text-align:center;">
          <svg style="width:48px;height:48px;margin-bottom:12px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <strong>Error Loading CoinGlass TV Chart:</strong>
          <span style="font-size:12px; margin-top:6px; color:#848E9C;">${message}</span>
        </div>
      `;
    }
  }

  // Ticker table rendering
  function renderTickerTable() {
    if (!rawCacheData || !rawCacheData.markets) {
      tickerTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #848E9C; padding: 20px;">No markets data</td></tr>`;
      return;
    }

    let markets = [...rawCacheData.markets];
    
    // Deduplicate by symbol to avoid listing the same instrument multiple times
    const seen = new Set();
    markets = markets.filter(m => {
      const sym = m.symbol.toUpperCase();
      if (seen.has(sym)) return false;
      seen.add(sym);
      return true;
    });
    
    // Sort or filter if activeTab is trending
    if (activeTab === 'trending') {
      markets.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
    } else if (activeTab === 'favorites') {
      markets = markets.filter(m => ['BTC', 'ETH', 'SOL', 'XRP'].includes(m.symbol));
    }

    // Search filter
    const query = tickerSearch.value.trim().toLowerCase();
    if (query) {
      markets = markets.filter(m => m.symbol.toLowerCase().includes(query));
    }

    if (markets.length === 0) {
      tickerTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #848E9C; padding: 20px;">No matching symbols</td></tr>`;
      return;
    }

    tickerTbody.innerHTML = '';
    markets.forEach(m => {
      const tr = document.createElement('tr');
      const cleanSymbol = m.symbol.includes('/') ? m.symbol : `${m.symbol}/USDT`;
      
      if (cleanSymbol === activeCoin) {
        tr.classList.add('active');
      }

      const price = parseFloat(m.price) || 0;
      const change = parseFloat(m.priceChangePercent) || 0;
      const changeClass = change >= 0 ? 'text-success' : 'text-danger';
      const changeText = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
      
      const vol = m.volUsd ? formatNumberShort(m.volUsd) : '--';

      tr.innerHTML = `
        <td style="font-weight: 500;">
          <div style="display:flex; align-items:center; gap:6px;">
            ${m.symbolLogo ? `<img src="${m.symbolLogo}" style="width:16px;height:16px;border-radius:50%;">` : ''}
            <span>${cleanSymbol}</span>
            <span style="font-size:9px; color:#5A6478; background:#14151a; padding:1px 3px; border-radius:2px; margin-left:3px;">Perp</span>
          </div>
        </td>
        <td style="text-align: right; font-family: var(--font-mono);">${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
        <td style="text-align: right; font-weight: 600; font-family: var(--font-mono);" class="${changeClass}">${changeText}</td>
        <td style="text-align: right; font-family: var(--font-mono); color: #848E9C;">${vol}</td>
      `;

      tr.addEventListener('click', () => {
        activeCoin = cleanSymbol;
        // Re-render table to update active class
        renderTickerTable();
        // Update details card
        updateDetailWidget();
      });

      tickerTbody.appendChild(tr);
    });
  }

  // Update Detail card info
  function updateDetailWidget() {
    if (!rawCacheData) return;

    // Try to find the coin in markets list
    const simpleSymbol = activeCoin.split('/')[0];
    const coinData = rawCacheData.markets ? rawCacheData.markets.find(m => m.symbol === simpleSymbol || m.symbol === activeCoin) : null;
    
    detailCoinSymbol.innerText = activeCoin;

    // Setup Price & Change
    let priceVal = 0;
    let changeVal = 0;
    let volVal = 0;
    let oiVal = 0;
    let fundingRateVal = 0;

    if (simpleSymbol === 'BTC') {
      // Use price close of last candlestick in price data
      if (rawCacheData.price && rawCacheData.price.length > 0) {
        const lastCandle = rawCacheData.price[rawCacheData.price.length - 1];
        priceVal = parseFloat(lastCandle[4]);
      }
      
      if (coinData) {
        changeVal = parseFloat(coinData.priceChangePercent) || 0;
        volVal = parseFloat(coinData.volUsd) || 0;
        oiVal = parseFloat(coinData.openInterest) || 0;
        fundingRateVal = parseFloat(coinData.fundingRate) || 0.01;
      }
      
      // Render BTC Performance grid
      if (rawCacheData.performance) {
        renderPerformanceData(rawCacheData.performance);
      }
    } else if (coinData) {
      priceVal = parseFloat(coinData.price) || 0;
      changeVal = parseFloat(coinData.priceChangePercent) || 0;
      volVal = parseFloat(coinData.volUsd) || 0;
      oiVal = parseFloat(coinData.openInterest) || 0;
      fundingRateVal = parseFloat(coinData.fundingRate) || 0;
      
      // Since performance grid is only for BTC, show mock/interpolated or blank for others
      // Let's clear performance fields or show N/A
      clearPerformanceData();
    } else {
      detailCoinPrice.innerText = '$--';
      detailCoinChange.innerText = '--';
      return;
    }

    // Format Price
    detailCoinPrice.innerText = '$' + priceVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    // Format Change
    const changeClass = changeVal >= 0 ? 'text-success' : 'text-danger';
    const changeText = changeVal >= 0 ? `+${changeVal.toFixed(2)}%` : `${changeVal.toFixed(2)}%`;
    detailCoinChange.className = `price-change-pct ${changeClass}`;
    detailCoinChange.innerText = `${changeText} (24h)`;

    // Day's range mock based on current price
    const delta = priceVal * 0.015; // 1.5% day swing
    const low = priceVal - (changeVal > 0 ? delta * 0.4 : delta * 0.8);
    const high = priceVal + (changeVal > 0 ? delta * 0.8 : delta * 0.4);
    rangeDayLow.innerText = '$' + low.toLocaleString(undefined, { maximumFractionDigits: 0 });
    rangeDayHigh.innerText = '$' + high.toLocaleString(undefined, { maximumFractionDigits: 0 });

    const rangePct = Math.max(0, Math.min(100, ((priceVal - low) / (high - low)) * 100));
    rangeBarPointer.style.left = `${rangePct}%`;

    // Stats volume, funding, OI
    statVol.innerText = volVal ? '$' + formatNumberShort(volVal) : '--';
    statFunding.innerText = fundingRateVal ? (fundingRateVal * 100).toFixed(4) + '%' : '0.0100%';
    
    statFunding.className = 'coin-stat-value ' + (fundingRateVal >= 0 ? 'text-success' : 'text-danger');
    statOi.innerText = oiVal ? '$' + formatNumberShort(oiVal) : '--';
    
    // LSR ratio
    const lsrLong = 50 + (changeVal * 0.3); // mock lsr ratio dynamically from change
    const lsrShort = 100 - lsrLong;
    statLsRatio.innerText = `${lsrLong.toFixed(1)}% / ${lsrShort.toFixed(1)}%`;
  }

  function renderPerformanceData(perf) {
    const updatePerfCell = (val, cell, textEl) => {
      const num = parseFloat(val);
      if (isNaN(num)) {
        textEl.innerText = '--';
        cell.className = 'perf-cell';
        return;
      }
      
      const txt = num >= 0 ? `+${num.toFixed(2)}%` : `${num.toFixed(2)}%`;
      textEl.innerText = txt;
      if (num >= 0) {
        textEl.className = 'perf-cell-value positive';
        cell.className = 'perf-cell positive-bg';
      } else {
        textEl.className = 'perf-cell-value negative';
        cell.className = 'perf-cell negative-bg';
      }
    };

    updatePerfCell(perf.d7, perf7dCell, perf7d);
    updatePerfCell(perf.d30, perf30dCell, perf30d);
    updatePerfCell(perf.d90, perf90dCell, perf90d);
    updatePerfCell(perf.d180, perf180dCell, perf180d);
    updatePerfCell(perf.ytd, perfYtdCell, perfYtd);
    updatePerfCell(perf.y1, perf1yCell, perf1y);
  }

  function clearPerformanceData() {
    [perf7d, perf30d, perf90d, perf180d, perfYtd, perf1y].forEach(el => {
      el.innerText = '--';
      el.className = 'perf-cell-value';
    });
    [perf7dCell, perf30dCell, perf90dCell, perf180dCell, perfYtdCell, perf1yCell].forEach(el => {
      el.className = 'perf-cell';
    });
  }

  // Format numbers to B, M, K
  function formatNumberShort(val) {
    const numVal = parseFloat(val);
    if (isNaN(numVal)) return '--';
    const absVal = Math.abs(numVal);
    if (absVal >= 1e9) return (numVal / 1e9).toFixed(2) + 'B';
    if (absVal >= 1e6) return (numVal / 1e6).toFixed(2) + 'M';
    if (absVal >= 1e3) return (numVal / 1e3).toFixed(2) + 'K';
    return numVal.toFixed(2);
  }

  // Render ECharts Multi-Pane Linkage Chart
  function renderMultiPaneChart() {
    const container = document.getElementById('tv-charts-container');
    if (!rawCacheData || !rawCacheData.price || !rawCacheData.price.length) {
      throw new Error('Data price kosong. Tunggu hingga scraper selesai.');
    }

    const { price, cvd, oi, fundingRate, spotCvd, bidAskDelta } = rawCacheData;

    const formatTime = (ts) => {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + 
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    const xAxisData = price.map(p => formatTime(p[0]));

    let cvdBaseline = 0;
    let spotCvdBaseline = 0;
    if (cvd && cvd.length > 0) {
      for (const p of price) {
        const found = cvd.find(x => x[0] === p[0]);
        if (found) {
          cvdBaseline = parseFloat(found[1]) || 0;
          break;
        }
      }
    }
    if (spotCvd && spotCvd.length > 0) {
      for (const p of price) {
        const found = spotCvd.find(x => x[0] === p[0]);
        if (found) {
          spotCvdBaseline = parseFloat(found[1]) || 0;
          break;
        }
      }
    }

    // Align CVD, Spot CVD, Funding Rate, Open Interest, and Delta with Price categories (xAxisData)
    const cvdCandleData = [];
    const spotCvdCandleData = [];
    const frData = [];
    const oiCandleData = [];
    const deltaData = [];

    price.forEach((p, idx) => {
      const ts = p[0];
      const timeStr = formatTime(ts);

      // 1. CVD candles
      const cItem = cvd ? cvd.find(x => x[0] === ts) : null;
      if (cItem) {
        const current = (parseFloat(cItem[1]) || 0) - cvdBaseline;
        const cIdx = cvd.indexOf(cItem);
        const prev = cIdx > 0 ? (parseFloat(cvd[cIdx - 1][1]) || 0) - cvdBaseline : current;
        cvdCandleData.push([
          prev,
          current,
          Math.min(prev, current),
          Math.max(prev, current)
        ]);
      } else {
        cvdCandleData.push([null, null, null, null]);
      }

      // 2. Spot CVD candles
      const sItem = spotCvd ? spotCvd.find(x => x[0] === ts) : null;
      if (sItem) {
        const current = (parseFloat(sItem[1]) || 0) - spotCvdBaseline;
        const sIdx = spotCvd.indexOf(sItem);
        const prev = sIdx > 0 ? (parseFloat(spotCvd[sIdx - 1][1]) || 0) - spotCvdBaseline : current;
        spotCvdCandleData.push([
          prev,
          current,
          Math.min(prev, current),
          Math.max(prev, current)
        ]);
      } else {
        spotCvdCandleData.push([null, null, null, null]);
      }

      // 3. Funding rate
      const fItem = fundingRate ? fundingRate.find(x => x[0] === ts) : null;
      if (fItem) {
        const val = parseFloat(fItem[4]) || 0;
        frData.push({
          value: [timeStr, val],
          itemStyle: {
            color: val >= 0 ? '#0ECB81' : '#F6465D'
          }
        });
      } else {
        frData.push({ value: [timeStr, null] });
      }

      // 4. Open Interest
      const oItem = oi ? oi.find(x => x[0] === ts) : null;
      if (oItem) {
        oiCandleData.push([
          parseFloat(oItem[1]), // open
          parseFloat(oItem[4]), // close
          parseFloat(oItem[3]), // low
          parseFloat(oItem[2])  // high
        ]);
      } else {
        oiCandleData.push([null, null, null, null]);
      }

      // 5. BidAsk Delta
      const dItem = bidAskDelta ? bidAskDelta.find(x => x[0] === ts) : null;
      if (dItem) {
        const val = parseFloat(dItem[1]) || 0;
        deltaData.push({
          value: [timeStr, val],
          itemStyle: {
            color: val >= 0 ? '#0ECB81' : '#F6465D'
          }
        });
      } else {
        deltaData.push({ value: [timeStr, null] });
      }
    });

    // Check if we need to initialize the cards
    if (chartInstances.length !== 5) {
      chartInstances.forEach(c => c.dispose());
      chartInstances = [];

      container.innerHTML = `
        <div class="tv-chart-card">
          <div id="chart-cvd" style="width: 100%; height: 100%;"></div>
        </div>
        <div class="tv-chart-card">
          <div id="chart-spot-cvd" style="width: 100%; height: 100%;"></div>
        </div>
        <div class="tv-chart-card">
          <div id="chart-funding-rate" style="width: 100%; height: 100%;"></div>
        </div>
        <div class="tv-chart-card">
          <div id="chart-open-interest" style="width: 100%; height: 100%;"></div>
        </div>
        <div class="tv-chart-card">
          <div id="chart-bid-ask-delta" style="width: 100%; height: 100%;"></div>
        </div>
      `;

      chartInstances = [
        echarts.init(document.getElementById('chart-cvd'), 'dark'),
        echarts.init(document.getElementById('chart-spot-cvd'), 'dark'),
        echarts.init(document.getElementById('chart-funding-rate'), 'dark'),
        echarts.init(document.getElementById('chart-open-interest'), 'dark'),
        echarts.init(document.getElementById('chart-bid-ask-delta'), 'dark')
      ];

      // Connect instances for sync tooltips & zoom
      echarts.connect(chartInstances);
      chartInstances.forEach((c, idx) => {
        window['chartInst' + idx] = c; // expose for diagnostic script
      });
    }

    const titleStyle = {
      color: '#EAECEF',
      fontSize: 11,
      fontWeight: 'normal',
      fontFamily: 'sans-serif',
      rich: {
        green: { color: '#0ECB81', fontSize: 11, fontFamily: 'sans-serif', fontWeight: 'bold' },
        red: { color: '#F6465D', fontSize: 11, fontFamily: 'sans-serif', fontWeight: 'bold' },
        white: { color: '#EAECEF', fontSize: 11, fontFamily: 'sans-serif', fontWeight: 'bold' }
      }
    };

    function getCardOption(titleText, seriesName, seriesData, yAxisFormatter, seriesConfig) {
      // Find the last non-null data item to place a TradingView-style price/value tag
      let latestValue = null;
      let isUp = true;
      
      if (seriesName === 'CVD Candles' || seriesName === 'Spot CVD' || seriesName === 'Open Interest') {
        const lastNonNull = [...seriesData].reverse().find(d => d && d[1] !== null);
        if (lastNonNull) {
          const openVal = parseFloat(lastNonNull[0]);
          const closeVal = parseFloat(lastNonNull[1]);
          latestValue = closeVal;
          isUp = closeVal >= openVal;
        }
      } else {
        // Bar series (Funding Rate, Bid/Ask Delta)
        const lastNonNull = [...seriesData].reverse().find(d => d && d.value && d.value[1] !== null);
        if (lastNonNull) {
          const val = parseFloat(lastNonNull.value[1]);
          latestValue = val;
          isUp = val >= 0;
        }
      }

      const markLineConfig = latestValue !== null ? {
        silent: true,
        symbol: ['none', 'none'],
        precision: 4,
        lineStyle: {
          type: 'dashed',
          width: 1,
          opacity: 0.5,
          color: isUp ? '#0ECB81' : '#F6465D'
        },
        label: {
          position: 'end',
          show: true,
          backgroundColor: isUp ? '#0ECB81' : '#F6465D',
          color: '#ffffff',
          padding: [2, 4],
          borderRadius: 2,
          fontSize: 10,
          fontWeight: 'bold',
          fontFamily: 'sans-serif',
          formatter: (params) => {
            const v = params.value;
            if (seriesName === 'CVD Candles' || seriesName === 'Spot CVD') {
              return v < 0 ? '-' + formatNumberShort(Math.abs(v), 3) : formatNumberShort(v, 3);
            } else if (seriesName === 'Open Interest') {
              return formatNumberShort(v, 3);
            } else if (seriesName === 'Funding Rate') {
              return v.toFixed(4);
            } else if (seriesName === 'Bid/Ask Delta') {
              return v.toFixed(4);
            }
            return v;
          }
        },
        data: [{ yAxis: latestValue }]
      } : undefined;

      return {
        backgroundColor: 'transparent',
        animation: false,
        title: { text: titleText, left: '10px', top: '5px', textStyle: titleStyle },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: '#2B3139' } },
          backgroundColor: '#1E2026',
          borderColor: '#2B3139',
          textStyle: { color: '#EAECEF', fontSize: 11 },
          formatter: function(params) {
            const p = params[0];
            let val = p.value;
            const getVal = (v) => {
              const num = parseFloat(v);
              return isNaN(num) ? '--' : num.toFixed(1);
            };

            if (p.seriesName === 'CVD Candles' || p.seriesName === 'Spot CVD') {
              if (Array.isArray(p.value)) {
                val = `O: ${getVal(p.value[0])} | C: ${getVal(p.value[1])} | L: ${getVal(p.value[2])} | H: ${getVal(p.value[3])}`;
              }
            } else if (p.seriesName === 'Open Interest') {
              if (Array.isArray(p.value)) {
                val = `O: ${formatNumberShort(p.value[0])} | C: ${formatNumberShort(p.value[1])} | L: ${formatNumberShort(p.value[2])} | H: ${formatNumberShort(p.value[3])}`;
              } else {
                val = formatNumberShort(p.value);
              }
            } else if (p.seriesName === 'Funding Rate') {
              const frVal = Array.isArray(p.value) ? parseFloat(p.value[1]) : parseFloat(p.value);
              val = isNaN(frVal) ? '--' : frVal.toFixed(4);
            } else if (p.seriesName === 'Bid/Ask Delta') {
              const dVal = Array.isArray(p.value) ? parseFloat(p.value[1]) : parseFloat(p.value);
              val = isNaN(dVal) ? '--' : dVal.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' BTC';
            }
            return `${p.name}<br/><span style="display:inline-block;margin-right:5px;border-radius:10px;width:9px;height:9px;background-color:${p.color}"></span> ${p.seriesName}: <b>${val}</b>`;
          }
        },
        grid: { left: 10, right: 65, bottom: 25, top: 40 },
        xAxis: {
          type: 'category',
          data: xAxisData,
          scale: true,
          axisLine: { lineStyle: { color: '#2B3139' } },
          axisLabel: { color: '#848E9C', fontSize: 10 },
          axisTick: { show: false }
        },
        yAxis: {
          position: 'right',
          scale: true,
          axisLine: { lineStyle: { color: '#2B3139' } },
          axisLabel: { color: '#848E9C', fontSize: 9, formatter: yAxisFormatter },
          splitLine: { lineStyle: { color: '#2B3139', type: 'dashed' } }
        },
        series: [{
          name: seriesName,
          data: seriesData,
          markLine: markLineConfig,
          ...seriesConfig
        }],
        dataZoom: [
          {
            type: 'inside',
            start: 70,
            end: 100
          }
        ]
      };
    }

    const cvdConfig = {
      type: 'candlestick',
      itemStyle: {
        color: '#0ECB81',
        color0: '#F6465D',
        borderColor: '#0ECB81',
        borderColor0: '#F6465D'
      }
    };

    const barConfig = {
      type: 'bar'
    };

    const options = [
      getCardOption('<CoinGlass> Cumulative Volume Delta (CVD Candles) 0 open No Filter', 'CVD Candles', cvdCandleData, v => formatNumberShort(v), cvdConfig),
      getCardOption('<CoinGlass> Aggregated Spot Cumulative Volume Delta (CVD Candles) 0 Main chart symbol Coins open No Filter', 'Spot CVD', spotCvdCandleData, v => formatNumberShort(v), cvdConfig),
      getCardOption('<CoinGlass> Funding Rates(Open Interest Weighted) close No Filter', 'Funding Rate', frData, v => v.toFixed(4), barConfig),
      getCardOption('<CoinGlass> Open Interest (Candles) Coins open No Filter', 'Open Interest', oiCandleData, v => formatNumberShort(v), cvdConfig),
      getCardOption('<CoinGlass> Aggregated Futures Bid & Ask Delta 1 Main chart symbol Coins No Filter', 'Bid/Ask Delta', deltaData, v => formatNumberShort(v), barConfig)
    ];

    if (activeCoin !== 'BTC/USDT' && activeCoin !== 'BTCUSDT') {
      options[0].graphic = [
        {
          type: 'text',
          left: 'center',
          top: '35%',
          style: {
            text: 'Charts display BTC/USDT Scraped Data (Scraper Target Symbol)',
            font: 'bold 13px sans-serif',
            fill: 'rgba(255, 255, 255, 0.25)',
            align: 'center'
          },
          z: 100
        }
      ];
    }

    chartInstances.forEach((chart, i) => {
      chart.setOption(options[i]);
    });

    let lastHoveredIndex = null;

    function updateAllTitles(idx) {
      const p = price[idx];
      if (!p) return;
      const ts = p[0];

      const cItem = cvd ? cvd.find(x => x[0] === ts) : null;
      const sItem = spotCvd ? spotCvd.find(x => x[0] === ts) : null;
      const fItem = fundingRate ? fundingRate.find(x => x[0] === ts) : null;
      const oItem = oi ? oi.find(x => x[0] === ts) : null;
      const dItem = bidAskDelta ? bidAskDelta.find(x => x[0] === ts) : null;

      let cText = '--';
      if (cItem) {
        const cIdx = cvd.indexOf(cItem);
        const current = parseFloat(cItem[1]) - cvdBaseline;
        const prev = cIdx > 0 ? parseFloat(cvd[cIdx - 1][1]) - cvdBaseline : current;
        const isCvdUp = current >= prev;
        cText = `{${isCvdUp ? 'green' : 'red'}|${current.toLocaleString(undefined, { maximumFractionDigits: 1 })} BTC}`;
      }

      let sText = '--';
      if (sItem) {
        const sIdx = spotCvd.indexOf(sItem);
        const current = parseFloat(sItem[1]) - spotCvdBaseline;
        const prev = sIdx > 0 ? parseFloat(spotCvd[sIdx - 1][1]) - spotCvdBaseline : current;
        const isSpotCvdUp = current >= prev;
        sText = `{${isSpotCvdUp ? 'green' : 'red'}|${current.toLocaleString(undefined, { maximumFractionDigits: 1 })} BTC}`;
      }

      let fText = '--';
      if (fItem) {
        const fVal = parseFloat(fItem[4]);
        fText = `{${fVal >= 0 ? 'green' : 'red'}|${fVal.toFixed(4)}}`;
      }

      let oText = '--';
      if (oItem) {
        const isOiUp = parseFloat(oItem[4]) >= parseFloat(oItem[1]);
        oText = `{${isOiUp ? 'green' : 'red'}|${formatNumberShort(parseFloat(oItem[4]))}}`;
      }

      let dText = '--';
      if (dItem) {
        const dVal = parseFloat(dItem[1]);
        dText = `{${dVal >= 0 ? 'green' : 'red'}|${dVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}}`;
      }

      chartInstances[0].setOption({ title: { text: `<CoinGlass> Cumulative Volume Delta (CVD Candles) 0 open No Filter ${cText}` } }, { lazyUpdate: true });
      chartInstances[1].setOption({ title: { text: `<CoinGlass> Aggregated Spot Cumulative Volume Delta (CVD Candles) 0 Main chart symbol Coins open No Filter ${sText}` } }, { lazyUpdate: true });
      chartInstances[2].setOption({ title: { text: `<CoinGlass> Funding Rates(Open Interest Weighted) close No Filter ${fText}` } }, { lazyUpdate: true });
      chartInstances[3].setOption({ title: { text: `<CoinGlass> Open Interest (Candles) Coins open No Filter ${oText}` } }, { lazyUpdate: true });
      chartInstances[4].setOption({ title: { text: `<CoinGlass> Aggregated Futures Bid & Ask Delta 1 Main chart symbol Coins No Filter ${dText}` } }, { lazyUpdate: true });
    }

    function restoreLatestTitles() {
      if (price && price.length > 0) {
        updateAllTitles(price.length - 1);
      }
    }

    restoreLatestTitles();

    chartInstances.forEach(chart => {
      chart.on('updateAxisPointer', (event) => {
        const axesInfo = event.axesInfo;
        if (!axesInfo || !axesInfo.length) {
          restoreLatestTitles();
          return;
        }
        const dataIndex = axesInfo[0].value;
        if (typeof dataIndex !== 'number' || dataIndex === lastHoveredIndex) return;
        lastHoveredIndex = dataIndex;
        updateAllTitles(dataIndex);
      });

      chart.on('globalout', () => {
        lastHoveredIndex = null;
        restoreLatestTitles();
      });
    });
  }
});
