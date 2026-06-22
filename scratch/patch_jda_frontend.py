import re

base = '/home/binance/tradingview-mcp/src/dashboard/public/'

# ── 1. raw-data.html: add ECharts + JDA section ──
with open(base + 'raw-data.html', 'r') as f:
    html = f.read()

# Add ECharts CDN before closing head
html = html.replace(
    '</head>',
    '  <script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></script>\n</head>'
)

# Add JDA section before </main> or before footer/script
JDA_HTML = '''
    <!-- ── JDA MTF Signal Validation Panel ─────────────────────────── -->
    <section style="margin-top: var(--spacing-md);">
      <div class="card" style="padding: var(--spacing-md);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--spacing-sm); border-bottom:1px solid var(--border-color); padding-bottom:12px;">
          <div>
            <h3 style="font-size:16px; font-weight:700; color:var(--accent-primary);">JDA MTF Signal Engine</h3>
            <span style="font-size:11px; color:var(--text-muted);">FSVZO + ZLEMA Pro — JS Replication for TradingView Validation</span>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <div id="jda-action-badge" style="font-size:13px; font-weight:700; padding:6px 16px; border-radius:8px; background:rgba(152,152,157,0.2); color:#98989D;">LOADING...</div>
            <span id="jda-update-time" style="font-size:10px; color:var(--text-muted);">--</span>
          </div>
        </div>

        <!-- MTF Table — mirrors TradingView dashboard -->
        <div style="overflow-x:auto; margin-bottom:var(--spacing-sm);">
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
              <tr style="background:#000;">
                <th style="padding:8px 12px; color:#fff; text-align:left; font-weight:600; letter-spacing:.5px;">TF</th>
                <th style="padding:8px 12px; color:#fff; text-align:left; font-weight:600;">ZLEMA</th>
                <th style="padding:8px 12px; color:#fff; text-align:left; font-weight:600;">Z-STATUS</th>
                <th style="padding:8px 12px; color:#fff; text-align:left; font-weight:600;">VZO</th>
                <th style="padding:8px 12px; color:#fff; text-align:left; font-weight:600;">ZONE</th>
              </tr>
            </thead>
            <tbody id="jda-mtf-body">
              <tr><td colspan="5" style="padding:20px; text-align:center; color:var(--text-muted);">Loading MTF data...</td></tr>
            </tbody>
          </table>
        </div>

        <!-- Bias + Phase + Action row -->
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:var(--spacing-sm);">
          <div id="jda-bias-cell" style="background:#111; border-radius:8px; padding:10px 14px;">
            <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">BIAS &amp; CONF</div>
            <div id="jda-bias-text" style="font-size:14px; font-weight:700; color:#98989D;">-- | --%</div>
          </div>
          <div style="background:#111; border-radius:8px; padding:10px 14px;">
            <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">PHASE</div>
            <div id="jda-phase-text" style="font-size:14px; font-weight:700; color:#98989D;">--</div>
          </div>
          <div style="background:#111; border-radius:8px; padding:10px 14px;">
            <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">DIR SCORE</div>
            <div id="jda-score-text" style="font-size:14px; font-weight:700; font-family:var(--font-mono); color:#98989D;">--</div>
          </div>
        </div>

        <!-- VZO 1H Chart -->
        <div>
          <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">VZO 1H — Last 40 Candles <span style="color:#555;">(compare with TradingView indicator on 1H chart)</span></div>
          <div id="jda-vzo-chart" style="height:200px; width:100%;"></div>
        </div>
      </div>
    </section>
'''

# Insert before closing </div> of main content or before script tag
html = html.replace('<script src="raw-data.js"></script>', JDA_HTML + '\n  <script src="raw-data.js"></script>')

with open(base + 'raw-data.html', 'w') as f:
    f.write(html)
print('raw-data.html patched')

# ── 2. raw-data.js: add JDA fetch + render ──
with open(base + 'raw-data.js', 'r') as f:
    js = f.read()

JDA_JS = r'''
// ── JDA MTF Signal Panel ──────────────────────────────────────────────────
let jdaChart = null;

function jdaZlemaLabel(trend) {
  return trend === 1 ? 'Bullish' : trend === -1 ? 'Bearish' : 'Neutral';
}

function jdaZStatusLabel(status, above) {
  const dir = above ? '▲' : '▼';
  const label = status === 1 ? 'Bullish' : status === -1 ? 'Bearish' : 'Neutral';
  return dir + ' ' + label;
}

function jdaVzoBg(state) {
  if (state === 'BULL+') return 'rgba(8,153,129,0.15)';
  if (state === 'BULL')  return 'rgba(8,153,129,0.30)';
  if (state === 'BEAR+') return 'rgba(242,54,69,0.15)';
  if (state === 'BEAR')  return 'rgba(242,54,69,0.30)';
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
  if (zone === 'OS') return '#32D74B';
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
    const vzoSign = d.vzo >= 0 ? '+' : '';

    return '<tr>' +
      '<td style="padding:7px 12px; color:#fff; font-weight:700; background:#0a0a0a;">' + labels[key] + '</td>' +
      '<td style="padding:7px 12px; background:' + (d.trend===1?'rgba(8,153,129,0.25)':'rgba(242,54,69,0.25)') + '; color:' + zlColor + '; font-weight:600;">' + jdaZlemaLabel(d.trend) + '</td>' +
      '<td style="padding:7px 12px; background:' + (d.above?'rgba(8,153,129,0.15)':'rgba(242,54,69,0.15)') + '; color:' + stColor + ';">' + jdaZStatusLabel(d.status, d.above) + '</td>' +
      '<td style="padding:7px 12px; background:' + vzoBg + '; color:#fff; font-family:var(--font-mono);">' + d.state + ' (' + vzoSign + d.vzo + '%)</td>' +
      '<td style="padding:7px 12px; background:' + zBg + '; color:' + zCol + '; font-weight:700;">' + d.zone + '</td>' +
      '</tr>';
  }).join('');
}

function renderVZOChart(data1h) {
  if (!data1h || !data1h.series || data1h.series.length === 0) return;
  const dom = document.getElementById('jda-vzo-chart');
  if (!dom) return;
  if (!jdaChart) jdaChart = echarts.init(dom, 'dark', { renderer: 'canvas' });

  const times = data1h.times.map(t => {
    const d = new Date(t);
    return d.getMonth()+1 + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  });
  const vzoData = data1h.series;
  const sigData = data1h.signalSeries;

  const vzoColors = vzoData.map(v => v >= 0 ? '#13fed9' : '#f23744');

  jdaChart.setOption({
    backgroundColor: '#0a0a0a',
    grid: { top: 20, bottom: 30, left: 50, right: 20 },
    tooltip: { trigger: 'axis', backgroundColor: '#121212', borderColor: '#2C2C2E', textStyle: { color: '#fff', fontSize: 11 } },
    xAxis: { type: 'category', data: times, axisLabel: { color: '#555', fontSize: 9, rotate: 30 }, splitLine: { lineStyle: { color: '#1a1a1a' } } },
    yAxis: { type: 'value', min: -100, max: 100, splitLine: { lineStyle: { color: '#1a1a1a' } }, axisLabel: { color: '#555', fontSize: 10 } },
    series: [
      {
        name: 'VZO 1H', type: 'bar', data: vzoData,
        itemStyle: { color: params => params.value >= 0 ? '#13fed9' : '#f23744' },
        barMaxWidth: 8
      },
      {
        name: 'Signal', type: 'line', data: sigData,
        lineStyle: { color: '#FFD60A', width: 1.5 },
        symbol: 'none', smooth: true
      },
      { name: '+40', type: 'line', data: new Array(times.length).fill(40), lineStyle: { color: '#f23744', type: 'dashed', width: 1, opacity: 0.4 }, symbol: 'none' },
      { name: '-40', type: 'line', data: new Array(times.length).fill(-40), lineStyle: { color: '#13fed9', type: 'dashed', width: 1, opacity: 0.4 }, symbol: 'none' },
      { name: 'Zero', type: 'line', data: new Array(times.length).fill(0), lineStyle: { color: '#333', width: 1 }, symbol: 'none' },
    ]
  });
  window.addEventListener('resize', () => jdaChart && jdaChart.resize());
}

async function loadJDASignal() {
  try {
    const res = await fetch('/api/jda-signal');
    if (!res.ok) return;
    const json = await res.json();
    const d = json.data;
    if (!d) return;

    const tfs = d.timeframes;

    // Render table
    renderJDATable(tfs);

    // Render VZO chart (1H)
    renderVZOChart(tfs['1h']);

    // Bias cell
    const biasEl = document.getElementById('jda-bias-text');
    const biasCellEl = document.getElementById('jda-bias-cell');
    if (biasEl) {
      biasEl.innerText = d.marketBias + ' | ' + d.conf + '% (' + d.confLevel + ')';
      biasEl.style.color = d.marketBias === 'BULLISH' ? '#32D74B' : d.marketBias === 'BEARISH' ? '#FF453A' : '#98989D';
    }
    if (biasCellEl) {
      biasCellEl.style.background = d.marketBias === 'BULLISH' ? 'rgba(8,153,129,0.12)' : d.marketBias === 'BEARISH' ? 'rgba(242,54,69,0.12)' : '#111';
    }

    // Phase
    const phaseEl = document.getElementById('jda-phase-text');
    if (phaseEl) {
      phaseEl.innerText = d.phase;
      phaseEl.style.color = d.phase.includes('BULL') ? '#32D74B' : d.phase.includes('BEAR') ? '#FF453A' : d.phase === 'SQUEEZE' ? '#FFD60A' : '#98989D';
    }

    // Dir Score
    const scoreEl = document.getElementById('jda-score-text');
    if (scoreEl) {
      const sign = d.dirScore >= 0 ? '+' : '';
      scoreEl.innerText = sign + d.dirScore + ' (' + (d.aligned ? 'ALIGNED' : 'MIXED') + ')';
      scoreEl.style.color = d.dirScore > 0 ? '#32D74B' : d.dirScore < 0 ? '#FF453A' : '#98989D';
    }

    // Action badge
    const actionEl = document.getElementById('jda-action-badge');
    if (actionEl) {
      actionEl.innerText = d.action;
      const isLong  = d.action.includes('LONG');
      const isShort = d.action.includes('SHORT');
      actionEl.style.background = isLong ? 'rgba(8,153,129,0.25)' : isShort ? 'rgba(242,54,69,0.25)' : 'rgba(152,152,157,0.2)';
      actionEl.style.color = isLong ? '#13fed9' : isShort ? '#f23744' : '#FFD60A';
    }

    const timeEl = document.getElementById('jda-update-time');
    if (timeEl) timeEl.innerText = 'Updated: ' + new Date(d.fetchTime).toLocaleTimeString();

  } catch (e) {
    console.error('[JDA] UI error:', e);
  }
}

// Auto-refresh JDA every 3 minutes
loadJDASignal();
setInterval(loadJDASignal, 3 * 60 * 1000);
'''

# Append JDA JS at end of raw-data.js
js = js + '\n' + JDA_JS

with open(base + 'raw-data.js', 'w') as f:
    f.write(js)
print('raw-data.js patched')
print('ALL DONE')
