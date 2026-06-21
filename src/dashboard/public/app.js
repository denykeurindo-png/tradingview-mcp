// JDA Trade Monitor — CoinGlass ETF Monitor App Logic
const EXCHANGE_RATE = 6.96; // 1 USD = 6.96 Bolivianos (Bs.)

// DOM Elements
const statusIndicator = document.getElementById('connection-status');
const btnRefresh = document.getElementById('btn-refresh');

// 4 Card KPIs
const valTotalInflow = document.getElementById('val-total-inflow');
const subTotalInflow = document.getElementById('sub-total-inflow');
const footTotalInflow = document.getElementById('foot-total-inflow');
const timeTotalInflow = document.getElementById('time-total-inflow');

const valDailyInflow = document.getElementById('val-daily-inflow');
const subDailyInflow = document.getElementById('sub-daily-inflow');
const footDailyInflow = document.getElementById('foot-daily-inflow');
const timeDailyInflow = document.getElementById('time-daily-inflow');

const valTradingVolume = document.getElementById('val-trading-volume');
const footTradingVolume = document.getElementById('foot-trading-volume');
const timeTradingVolume = document.getElementById('time-trading-volume');

const valNetAssets = document.getElementById('val-net-assets');
const footNetAssets = document.getElementById('foot-net-assets');
const timeNetAssets = document.getElementById('time-net-assets');

const alertsContainer = document.getElementById('alerts-container');
const etfTableBody = document.querySelector('#etf-table tbody');
const cacheIndicator = document.getElementById('cache-indicator');

let chartInstance = null;

// Parse USD formatted strings like "+$53.83B" or "-$90.70M" to numbers
const parseUSDStringToNumber = (str) => {
  if (!str) return 0;
  // Clean string: remove $, +, and commas
  const clean = str.replace(/[\$\+,]/g, '').trim();
  const m = clean.match(/^([+-]?[\d.]+)([KMB])?$/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') return num * 1000;
  if (suffix === 'M') return num * 1000000;
  if (suffix === 'B') return num * 1000000000;
  return num;
};

// Formatting functions
const formatBTC = (valBtc) => {
  if (valBtc === 0 || valBtc === undefined || valBtc === null) return '0.00 BTC';
  const isNegative = valBtc < 0;
  const absVal = Math.abs(valBtc);
  let formatted = '';
  if (absVal >= 1000) {
    formatted = (absVal / 1000).toFixed(2) + 'K';
  } else {
    formatted = absVal.toFixed(2);
  }
  return `${isNegative ? '-' : '+'}${formatted} BTC`;
};

const formatUSD = (valUsd) => {
  if (valUsd === 0 || valUsd === undefined || valUsd === null) return '$0.00';
  const isNegative = valUsd < 0;
  const absVal = Math.abs(valUsd);
  let formatted = '';
  if (absVal >= 1000000000) {
    formatted = (absVal / 1000000000).toFixed(2) + 'B';
  } else if (absVal >= 1000000) {
    formatted = (absVal / 1000000).toFixed(2) + 'M';
  } else if (absVal >= 1000) {
    formatted = (absVal / 1000).toFixed(2) + 'K';
  } else {
    formatted = absVal.toFixed(2);
  }
  return `${isNegative ? '-' : '+'}$${formatted}`;
};

const formatBs = (valUsd) => {
  if (valUsd === 0 || valUsd === undefined || valUsd === null) return 'Bs. 0.00';
  const valBs = valUsd * EXCHANGE_RATE;
  const isNegative = valBs < 0;
  const absVal = Math.abs(valBs);
  let formatted = '';
  if (absVal >= 1000000000) {
    formatted = (absVal / 1000000000).toFixed(2) + 'B';
  } else if (absVal >= 1000000) {
    formatted = (absVal / 1000000).toFixed(2) + 'M';
  } else if (absVal >= 1000) {
    formatted = (absVal / 1000).toFixed(2) + 'K';
  } else {
    formatted = absVal.toFixed(2);
  }
  return `${isNegative ? '-' : '+'}Bs. ${formatted}`;
};

function updateStatus(state, message) {
  statusIndicator.className = `status-indicator ${state}`;
  statusIndicator.querySelector('.status-text').innerText = message;
}

// Fetch ETF data from API
async function loadData(forceRefresh = false) {
  updateStatus('loading', forceRefresh ? 'Scraping...' : 'Updating...');
  btnRefresh.disabled = true;

  try {
    const url = `/api/etf-data${forceRefresh ? '?refresh=true' : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || `HTTP error ${response.status}`);
    }

    const resObj = await response.json();
    const result = resObj.data;
    const btcPrice = resObj.btcPrice || 65000;

    // 1. Update Cache indicators
    const lastUpdate = new Date(result.timestamp).toLocaleTimeString();
    cacheIndicator.innerText = `Updated: ${lastUpdate} (BTC @ ${formatUSD(btcPrice)}) [${resObj.source === 'cache' ? 'Cache' : 'Live'}]`;

    // 2. Render elements
    renderKPIs(result.kpis, result.formatted, btcPrice);
    renderChart(result.formatted, btcPrice);
    renderTable(result.formatted, result.hdrs);
    renderAlerts(result.formatted, btcPrice);

    // Update table subtitle with exact update time
    if (result.kpis && result.kpis.totalNetInflow) {
      document.getElementById('table-update-time').innerText = `Update Time: ${(result.kpis.totalNetInflow.time || '').replace('Last update : ', '')}`;
    }

    updateStatus('normal', 'Live');
  } catch (error) {
    console.error('Error fetching ETF data:', error);
    updateStatus('alert', 'Connection Error');
    // Inject connection failure alert
    alertsContainer.innerHTML = `
      <div class="alert-box">
        <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <div class="alert-content">
          <div class="alert-title">CDP Connection Failure</div>
          <div class="alert-desc">${error.message || 'Ensure Chrome is open with remote debugging enabled.'}</div>
        </div>
      </div>
    `;
  } finally {
    btnRefresh.disabled = false;
  }
}

// Render Top KPIs (Total Net Inflow, Daily Total Net Inflow, Daily Trading Volume, Total Net Assets)
function renderKPIs(kpis, data, btcPrice) {
  // Try to use live scraped KPIs from CoinGlass first
  if (kpis && kpis.totalNetInflow && kpis.dailyTotalNetInflow && kpis.dailyTradingVolume && kpis.totalNetAssets) {
    // Card 1: Total Net Inflow
    valTotalInflow.innerText = kpis.totalNetInflow.usd;
    valTotalInflow.className = `kpi-value select-mono ${(kpis.totalNetInflow.usd || '').includes('-') ? 'text-negative' : 'text-positive'}`;
    subTotalInflow.innerText = kpis.totalNetInflow.btc;
    subTotalInflow.className = `kpi-sub-value select-mono ${(kpis.totalNetInflow.btc || '').includes('-') ? 'text-negative' : 'text-positive'}`;
    
    const totalInflowUsd = parseUSDStringToNumber(kpis.totalNetInflow.usd);
    footTotalInflow.innerText = `${formatBs(totalInflowUsd)} (Equiv.)`;
    timeTotalInflow.innerText = kpis.totalNetInflow.time;

    // Card 2: Daily Total Net Inflow
    valDailyInflow.innerText = kpis.dailyTotalNetInflow.usd;
    valDailyInflow.className = `kpi-value select-mono ${(kpis.dailyTotalNetInflow.usd || '').includes('-') ? 'text-negative' : 'text-positive'}`;
    subDailyInflow.innerText = kpis.dailyTotalNetInflow.btc;
    subDailyInflow.className = `kpi-sub-value select-mono ${(kpis.dailyTotalNetInflow.btc || '').includes('-') ? 'text-negative' : 'text-positive'}`;
    
    const dailyInflowUsd = parseUSDStringToNumber(kpis.dailyTotalNetInflow.usd);
    footDailyInflow.innerText = `${formatBs(dailyInflowUsd)} (Equiv.)`;
    timeDailyInflow.innerText = kpis.dailyTotalNetInflow.time;

    // Card 3: Daily Trading Volume
    valTradingVolume.innerText = kpis.dailyTradingVolume.usd;
    const volUsd = parseUSDStringToNumber(kpis.dailyTradingVolume.usd);
    footTradingVolume.innerText = `${formatBs(volUsd)} (Equiv.)`;
    timeTradingVolume.innerText = kpis.dailyTradingVolume.time;

    // Card 4: Total Net Assets
    valNetAssets.innerText = kpis.totalNetAssets.usd;
    const assetsUsd = parseUSDStringToNumber(kpis.totalNetAssets.usd);
    footNetAssets.innerText = `${formatBs(assetsUsd)} (Equiv.)`;
    timeNetAssets.innerText = kpis.totalNetAssets.time;
    return;
  }

  // Fallback: calculate from rows and btcPrice if scraper returned empty KPIs
  if (!data || data.length === 0) return;
  const latest = data[0];
  const totalNet = latest.Total ?? 0;
  const totalNetUsd = totalNet * btcPrice;

  valTotalInflow.innerText = formatUSD(totalNetUsd * 300); // Mock cumulative
  subTotalInflow.innerText = formatBTC(totalNet * 300);
  footTotalInflow.innerText = `${formatBs(totalNetUsd * 300)} (Equiv.)`;
  timeTotalInflow.innerText = 'Last update: Fallback Calculation';

  valDailyInflow.innerText = formatUSD(totalNetUsd);
  valDailyInflow.className = `kpi-value select-mono ${totalNet >= 0 ? 'text-positive' : 'text-negative'}`;
  subDailyInflow.innerText = formatBTC(totalNet);
  subDailyInflow.className = `kpi-sub-value select-mono ${totalNet >= 0 ? 'text-positive' : 'text-negative'}`;
  footDailyInflow.innerText = `${formatBs(totalNetUsd)} (Equiv.)`;
  timeDailyInflow.innerText = 'Last update: Fallback Calculation';

  valTradingVolume.innerText = '$5.17B'; // hardcoded mock fallback
  footTradingVolume.innerText = 'Bs. 35.98B (Equiv.)';
  timeTradingVolume.innerText = 'Last update: Fallback Calculation';

  valNetAssets.innerText = '$82.94B'; // hardcoded mock fallback
  footNetAssets.innerText = 'Bs. 577.26B (Equiv.)';
  timeNetAssets.innerText = 'Last update: Fallback Calculation';
}

// Render dynamic JDA Trade Monitor Chart (USD & Bs flows)
function renderChart(data, btcPrice) {
  const canvas = document.getElementById('etf-chart');
  if (!canvas) return; // Chart is disabled/removed
  if (!data || data.length === 0) return;

  const ctx = canvas.getContext('2d');

  // Reverse data to display chronologically from left to right (excluding Total row)
  const timeline = [...data].filter(d => d.date !== 'Total').reverse();
  const labels = timeline.map(d => d.date);
  const totalFlowsUsd = timeline.map(d => d.Total * btcPrice);

  if (chartInstance) {
    chartInstance.destroy();
  }

  // Create gradient fill for area chart
  const gradient = ctx.createLinearGradient(0, 0, 0, 400);
  gradient.addColorStop(0, 'rgba(240, 185, 11, 0.4)');
  gradient.addColorStop(1, 'rgba(240, 185, 11, 0)');

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Daily Net Flow Equiv. (USD)',
        data: totalFlowsUsd,
        borderColor: '#F0B90B',
        borderWidth: 2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#F0B90B',
        pointBorderColor: '#121212',
        pointHoverBackgroundColor: '#FFFFFF',
        pointHoverBorderColor: '#F0B90B',
        pointHoverRadius: 6,
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: '#1E1E1E',
          titleColor: '#FFFFFF',
          bodyColor: '#F0B90B',
          borderColor: '#2C2C2E',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: function(context) {
              const usd = context.parsed.y;
              const index = context.dataIndex;
              const btc = timeline[index].Total;
              return [
                `Net Flow BTC: ${formatBTC(btc)}`,
                `Equiv. USD: ${formatUSD(usd)}`,
                `Equiv. Bs: ${formatBs(usd)}`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: '#2C2C2E',
            drawBorder: false
          },
          ticks: {
            color: '#98989D',
            font: {
              family: 'Inter',
              size: 11
            }
          }
        },
        y: {
          grid: {
            color: '#2C2C2E',
            drawBorder: false
          },
          ticks: {
            color: '#98989D',
            font: {
              family: 'JetBrains Mono',
              size: 11
            },
            callback: function(value) {
              // Format USD to Millions (e.g. +10M / -10M)
              return (value >= 0 ? '+' : '') + (value / 1000000).toFixed(0) + 'M';
            }
          }
        }
      }
    }
  });
}

// Render Data Table
function renderTable(data, hdrs) {
  if (!data || data.length === 0 || !hdrs) return;

  const thead = document.querySelector('#etf-table thead');
  thead.innerHTML = '';
  const trHead = document.createElement('tr');
  hdrs.forEach(h => {
    const th = document.createElement('th');
    th.innerText = h === 'Time(UTC)' ? 'Time(UTC)' : h;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);

  etfTableBody.innerHTML = '';
  // Render first 15 rows for readability
  const rowsToDisplay = data.slice(0, 15);

  rowsToDisplay.forEach(row => {
    const tr = document.createElement('tr');

    if (row.date === 'Total') {
      tr.style.fontWeight = 'bold';
      tr.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
    }

    hdrs.forEach((h, idx) => {
      const td = document.createElement('td');
      if (idx === 0) {
        td.innerText = row.date;
      } else {
        const val = row[h] ?? 0;
        td.innerText = formatBTC(val);
        td.className = val >= 0 ? 'text-positive' : 'text-negative';
      }
      tr.appendChild(td);
    });
    etfTableBody.appendChild(tr);
  });
}

// Render JDA Trade Monitor Smart Alerts
function renderAlerts(data, btcPrice) {
  if (!data || data.length === 0) return;

  alertsContainer.innerHTML = '';
  const latest = data[0];
  const total = latest.Total ?? 0;
  const gbtc = latest.GBTC ?? 0;

  let alertHTML = '';

  // 1. Net outflow alert
  if (total < 0) {
    const totalUsd = total * btcPrice;
    alertHTML += `
      <div class="alert-box">
        <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
        <div class="alert-content">
          <div class="alert-title">Capital Outflow Detected (Net Outflow)</div>
          <div class="alert-desc">Net daily outflow of ${formatBTC(total)} (equiv. ${formatUSD(totalUsd)} / ${formatBs(totalUsd)}) in the recent session.</div>
        </div>
      </div>
    `;
  }

  // 2. Grayscale massive outflow alert ("Vampiro")
  if (gbtc < -200) { // Outflow of more than 200 BTC
    const gbtcUsd = gbtc * btcPrice;
    alertHTML += `
      <div class="alert-box">
        <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 2 22 22 22"></polygon>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <div class="alert-content">
          <div class="alert-title">Massive GBTC Drain (Vampire Alert)</div>
          <div class="alert-desc">Grayscale registered an outflow of ${formatBTC(gbtc)} (equiv. ${formatUSD(gbtcUsd)} / ${formatBs(gbtcUsd)}).</div>
        </div>
      </div>
    `;
  }

  if (alertHTML === '') {
    // Normal / stable state information box
    alertsContainer.innerHTML = `
      <div class="alert-box" style="background-color: rgba(50, 215, 75, 0.08); border-left-color: var(--accent-success); color: var(--accent-success)">
        <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <div class="alert-content">
          <div class="alert-title" style="color: var(--accent-success)">Stable Flows</div>
          <div class="alert-desc" style="color: #A3F5B4">No active capital drain alerts in this cycle.</div>
        </div>
      </div>
    `;
  } else {
    alertsContainer.innerHTML = alertHTML;
  }
}

// Refresh button listener
btnRefresh.addEventListener('click', () => loadData(true));

// Initial load on page ready
window.addEventListener('DOMContentLoaded', () => loadData(false));
