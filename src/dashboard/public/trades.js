// JDA Trade Monitor — Live Trade Journal
const EXCHANGE_RATE = 16300;

// ─── Tab System ──────────────────────────────────────────────────────────────
function switchPageTab(tabName) {
  document.querySelectorAll('.page-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const btn = document.querySelector(`[data-tab="${tabName}"]`);
  const content = document.getElementById(`tab-${tabName}`);
  if (btn) btn.classList.add('active');
  if (content) content.classList.add('active');
  if (tabName === 'sweep-history') loadSweepHistory();
}

// ─── Sweep History ───────────────────────────────────────────────────────────
let sweepHistoryData = [];

async function loadSweepHistory() {
  try {
    const res = await fetch('/api/sweep-history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sweepHistoryData = await res.json();
    renderSweepHistory();
  } catch (e) {
    console.error('Error loading sweep history:', e);
    const tbody = document.getElementById('sweep-history-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#FF453A;padding:20px;">Error loading sweep history: ' + e.message + '</td></tr>';
  }
}

function renderSweepHistory() {
  const tbody = document.getElementById('sweep-history-tbody');
  const countEl = document.getElementById('sweep-history-count');
  if (countEl) countEl.innerText = sweepHistoryData.length + ' events';
  renderStrategyReview(sweepHistoryData);

  if (!tbody) return;
  if (!sweepHistoryData || sweepHistoryData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:30px;">No sweep history yet. Bot will record events as it monitors the market in real-time.</td></tr>';
    return;
  }

  const phaseColors = {
    STANDBY: '#98989D', ALERT: '#FF9F0A', SWEEP_DETECTED: '#32D74B',
    TRADE_EXECUTED: '#0090FF', SWEEP_REJECTED: '#FF453A',
    CONFLICTING_SWEEP: '#FF6B6B', COOLDOWN: '#BF5AF2',
    MAX_ACTIVE: '#FFD60A', DISABLED: '#636366',
  };

  let html = '';
  sweepHistoryData.slice(0, 200).forEach(entry => {
    const d = new Date(entry.timestamp);
    const timeStr = `${d.getDate().toString().padStart(2,'0')} ${d.toLocaleString('id-ID',{month:'short'})} ${d.getHours().toString().padStart(2,'0')}.${d.getMinutes().toString().padStart(2,'0')}`;
    const color = phaseColors[entry.phase] || '#636366';
    const phaseBadge = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${color}22;color:${color};">${(entry.phase||'').replace(/_/g,' ')}</span>`;

    const poolStr = entry.nearestPool ? `$${parseFloat(entry.nearestPool).toLocaleString(undefined,{maximumFractionDigits:0})}` : '-';
    const distStr = entry.nearestPoolDistance || '-';
    const volStr  = entry.nearestPoolVolume ? `$${(entry.nearestPoolVolume/1e6).toFixed(1)}M` : '-';
    const sideStr = entry.nearestPoolSide || '-';

    const sc = entry.sweepCandidate;
    const prob = sc && sc.prob ? sc.prob : null;
    const rr   = sc && sc.rr  ? parseFloat(sc.rr).toFixed(1) : null;
    const probHtml = prob
      ? `<span style="color:${prob >= 70 ? '#32D74B' : prob >= 60 ? '#F0B90B' : '#FF453A'};font-weight:600;">${prob}%</span>`
      : '<span style="color:#636366;">-</span>';
    const rrHtml = rr ? ` · <span style="color:#98989D;">1:${rr}</span>` : '';

    // Extract human-readable skip reason from message
    const msg = entry.message || '';
    let skipReason = '', skipColor = '#636366';
    if (entry.phase === 'SWEEP_REJECTED') {
      skipColor = '#FF6B6B';
      if (msg.includes('R:R'))           { skipReason = `Low R:R — pool swept but risk/reward too low (< min ${msg.match(/min ([\d.]+)/)?.[1]||''})`; }
      else if (msg.includes('Coinbase')) { skipReason = 'Coinbase Premium Filter — spot sentiment contradicts sweep direction'; }
      else if (msg.includes('HTF'))      { skipReason = 'HTF Trend Block — higher timeframe trend (1h+4h) opposes sweep direction'; }
      else if (msg.includes('Spoofing')) { skipReason = 'Anti-Spoofing — orderbook depth delta indicates fake order wall'; }
      else if (msg.includes('Prob'))     { skipReason = `Low Probability — score ${msg.match(/Prob (\d+)/)?.[1]||'?'}% below ${msg.match(/min (\d+)/)?.[1]||'?'}% threshold`; }
      else if (msg.includes('force'))    { skipReason = 'Force Skip — override condition triggered'; }
      else                               { skipReason = msg.substring(0, 80); }
    } else if (entry.phase === 'COOLDOWN') {
      skipColor = '#BF5AF2';
      skipReason = 'Cooldown active — waiting after recent trade close';
    } else if (entry.phase === 'CONFLICTING_SWEEP') {
      skipColor = '#FF9F0A';
      skipReason = 'Conflicting sweep — opposing pool also swept in same window (indecision)';
    } else if (entry.phase === 'MAX_ACTIVE') {
      skipColor = '#FFD60A';
      skipReason = 'Max active trades reached — not entering new positions';
    } else if (entry.phase === 'TRADE_EXECUTED') {
      skipColor = '#0090FF';
      skipReason = '✅ Trade executed';
    } else if (entry.phase === 'ALERT') {
      skipColor = '#FF9F0A';
      skipReason = 'Price approaching pool — watching for sweep candle';
    } else {
      skipReason = msg.substring(0, 80) + (msg.length > 80 ? '…' : '');
    }

    const sideColor = sideStr === 'RESISTANCE' ? '#FF453A' : sideStr === 'SUPPORT' ? '#32D74B' : '#636366';

    html += `<tr>
      <td style="color:#98989D;font-size:11px;white-space:nowrap;">${timeStr}</td>
      <td>${phaseBadge}</td>
      <td style="color:${sideColor};font-weight:700;font-size:11px;">${sideStr}</td>
      <td class="mono" style="font-size:12px;">${poolStr}</td>
      <td class="mono" style="color:#F0B90B;font-size:11px;">${distStr}</td>
      <td class="mono" style="color:#848E9C;font-size:11px;">${volStr}</td>
      <td class="mono" style="font-size:12px;">${probHtml}${rrHtml}</td>
      <td style="font-size:11px;color:${skipColor};max-width:300px;">${skipReason}</td>
    </tr>`;
  });

  tbody.innerHTML = html;

  // Rejection breakdown mini-bars
  renderSweepRejectionBars(sweepHistoryData);
}

function renderSweepRejectionBars(data) {
  const el = document.getElementById('sweep-rejection-bars');
  if (!el) return;

  const total = data.length;
  if (total === 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';

  const cats = [
    { label: 'Trade Executed', color: '#0090FF', count: data.filter(d => d.phase === 'TRADE_EXECUTED').length },
    { label: 'Low R:R',        color: '#FF453A', count: data.filter(d => d.phase === 'SWEEP_REJECTED' && (d.message||'').includes('R:R')).length },
    { label: 'Low Prob',       color: '#FF6B6B', count: data.filter(d => d.phase === 'SWEEP_REJECTED' && (d.message||'').includes('Prob')).length },
    { label: 'CB Premium',     color: '#FF9F0A', count: data.filter(d => d.phase === 'SWEEP_REJECTED' && (d.message||'').includes('Coinbase')).length },
    { label: 'HTF Trend',      color: '#F0B90B', count: data.filter(d => d.phase === 'SWEEP_REJECTED' && (d.message||'').includes('HTF')).length },
    { label: 'Anti-Spoof',     color: '#FF453A', count: data.filter(d => d.phase === 'SWEEP_REJECTED' && (d.message||'').includes('Spoofing')).length },
    { label: 'Cooldown',       color: '#BF5AF2', count: data.filter(d => d.phase === 'COOLDOWN').length },
    { label: 'Conflicting',    color: '#FF9F0A', count: data.filter(d => d.phase === 'CONFLICTING_SWEEP').length },
    { label: 'Standby',        color: '#636366', count: data.filter(d => d.phase === 'STANDBY' || d.phase === 'ALERT').length },
  ].filter(c => c.count > 0);

  const barItems = cats.map(c => {
    const pct = ((c.count / total) * 100).toFixed(1);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <span style="width:110px;font-size:11px;color:#848E9C;text-align:right;">${c.label}</span>
      <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:3px;height:14px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${c.color};border-radius:3px;min-width:2px;"></div>
      </div>
      <span style="width:35px;font-size:11px;color:${c.color};font-weight:700;font-family:var(--font-mono);">${c.count}</span>
      <span style="width:35px;font-size:10px;color:#636366;">${pct}%</span>
    </div>`;
  }).join('');

  el.innerHTML = `<div style="background:rgba(0,0,0,0.2);border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;">
    <div style="font-size:10px;font-weight:700;color:#F0B90B;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">Event Breakdown (${total} total)</div>
    ${barItems}
  </div>`;
}

function renderStrategyReview(data) {
  const el = document.getElementById('strategy-review-content');
  if (!el) return;

  const total = data.length;
  const rejected  = data.filter(d => d.phase === 'SWEEP_REJECTED').length;
  const executed  = data.filter(d => d.phase === 'TRADE_EXECUTED').length;
  const cooldown  = data.filter(d => d.phase === 'COOLDOWN').length;
  const conflict  = data.filter(d => d.phase === 'CONFLICTING_SWEEP').length;
  const standby   = data.filter(d => d.phase === 'STANDBY' || d.phase === 'ALERT').length;
  const sweepEvents = rejected + executed + conflict;
  const signalRate = sweepEvents > 0 ? ((executed / sweepEvents) * 100).toFixed(0) : 0;

  const rejections = data.filter(d => d.phase === 'SWEEP_REJECTED');
  const byRR     = rejections.filter(d => (d.message||'').includes('R:R')).length;
  const byProb   = rejections.filter(d => (d.message||'').includes('Prob')).length;
  const byCB     = rejections.filter(d => (d.message||'').includes('Coinbase')).length;
  const byHTF    = rejections.filter(d => (d.message||'').includes('HTF')).length;
  const bySpoof  = rejections.filter(d => (d.message||'').includes('Spoofing')).length;
  const byOther  = rejected - byRR - byProb - byCB - byHTF - bySpoof;

  el.innerHTML = `
    <div class="strategy-review-grid">
      <div class="review-card">
        <div class="review-title">Strategy Configuration</div>
        <table class="review-table">
          <tr><td>Capital</td><td class="mono">$5,000</td></tr>
          <tr><td>Risk / Trade</td><td class="mono">1%</td></tr>
          <tr><td>Min R:R</td><td class="mono">1:1.2</td></tr>
          <tr><td>Min Prob</td><td class="mono">70%</td></tr>
          <tr><td>Sweep Window</td><td class="mono">5 candles</td></tr>
          <tr><td>Cooldown</td><td class="mono">30 min</td></tr>
          <tr><td>ATR Multiplier</td><td class="mono">3×</td></tr>
          <tr><td>Min SL</td><td class="mono">1.2%</td></tr>
          <tr><td>Max TP cap</td><td class="mono">1.5%</td></tr>
          <tr><td>Max Active</td><td class="mono">1 trade</td></tr>
        </table>
      </div>
      <div class="review-card">
        <div class="review-title">Sweep Events (${total} logged)</div>
        <table class="review-table">
          <tr><td>Total Sweeps Detected</td><td class="mono" style="color:#F0B90B;">${sweepEvents}</td></tr>
          <tr><td>Trades Executed</td><td class="mono" style="color:#0090FF;">${executed}</td></tr>
          <tr><td>Sweeps Rejected</td><td class="mono text-negative">${rejected}</td></tr>
          <tr><td>Cooldown Skip</td><td class="mono" style="color:#BF5AF2;">${cooldown}</td></tr>
          <tr><td>Conflicting Sweep</td><td class="mono" style="color:#FF9F0A;">${conflict}</td></tr>
          <tr><td>Standby / Alert</td><td class="mono" style="color:#636366;">${standby}</td></tr>
          <tr><td>Signal → Trade Rate</td><td class="mono" style="color:${parseInt(signalRate) >= 30 ? '#32D74B' : '#FF453A'};font-weight:700;">${signalRate}%</td></tr>
        </table>
      </div>
      <div class="review-card">
        <div class="review-title">Rejection Breakdown</div>
        <table class="review-table">
          <tr><td>Low R:R</td><td class="mono text-negative">${byRR} <span style="color:#636366;font-size:10px;">${rejected > 0 ? ((byRR/rejected)*100).toFixed(0) : 0}%</span></td></tr>
          <tr><td>Low Probability</td><td class="mono text-negative">${byProb} <span style="color:#636366;font-size:10px;">${rejected > 0 ? ((byProb/rejected)*100).toFixed(0) : 0}%</span></td></tr>
          <tr><td>CB Premium Filter</td><td class="mono text-negative">${byCB} <span style="color:#636366;font-size:10px;">${rejected > 0 ? ((byCB/rejected)*100).toFixed(0) : 0}%</span></td></tr>
          <tr><td>Bearish HTF Trend</td><td class="mono text-negative">${byHTF} <span style="color:#636366;font-size:10px;">${rejected > 0 ? ((byHTF/rejected)*100).toFixed(0) : 0}%</span></td></tr>
          <tr><td>Anti-Spoofing</td><td class="mono text-negative">${bySpoof} <span style="color:#636366;font-size:10px;">${rejected > 0 ? ((bySpoof/rejected)*100).toFixed(0) : 0}%</span></td></tr>
          <tr><td>Other</td><td class="mono" style="color:#636366;">${byOther}</td></tr>
        </table>
      </div>
      <div class="review-card">
        <div class="review-title">How Sweeps Become Signals</div>
        <div style="font-size:11px;color:#848E9C;line-height:1.7;">
          <div style="margin-bottom:6px;"><span style="color:#F0B90B;font-weight:600;">1. Pool Detection</span><br>Heatmap pool within 0.2–8% of price</div>
          <div style="margin-bottom:6px;"><span style="color:#F0B90B;font-weight:600;">2. Sweep Candle</span><br>Wick pierces pool, close rebounds (5-candle window)</div>
          <div style="margin-bottom:6px;"><span style="color:#F0B90B;font-weight:600;">3. Filters Pass</span><br>R:R ≥ 1.2 · Prob ≥ 70% · CB Premium · HTF Trend</div>
          <div><span style="color:#32D74B;font-weight:600;">4. Trade Entry</span><br>ATR-based SL · TP at opposing pool · 30min cooldown</div>
        </div>
      </div>
    </div>`;
}

async function clearSweepHistory() {
  if (!confirm('Clear all sweep history? Cannot be undone.')) return;
  try {
    await fetch('/api/sweep-history/clear', { method: 'POST' });
    sweepHistoryData = [];
    renderSweepHistory();
  } catch (e) {
    alert('Failed to clear: ' + e.message);
  }
}

const statusIndicator = document.getElementById('connection-status');
const btnRefresh = document.getElementById('btn-refresh');

let tradeLog = [];
let autoTradeEnabled = true;
let currentBtcPrice = null;
let botStatusIntervalId = null;

// ─── Formatters ──────────────────────────────────────────────
const formatUSD = (v) => {
  if (!v && v !== 0) return '$0.00';
  const neg = v < 0; const abs = Math.abs(v);
  let f = abs >= 1e9 ? (abs/1e9).toFixed(2)+'B' : abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(2)+'K' : abs.toFixed(2);
  return `${neg ? '-' : ''}$${f}`;
};
const formatIDR = (v) => {
  if (!v && v !== 0) return 'Rp 0';
  const bs = v * EXCHANGE_RATE; const neg = bs < 0; const abs = Math.abs(bs);
  let f = abs >= 1e9 ? (abs/1e9).toFixed(2)+'B' : abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(2)+'K' : abs.toFixed(2);
  return `${neg ? '-' : ''}Rp ${f}`;
};

function updateStatus(state, message) {
  statusIndicator.className = `status-indicator ${state}`;
  statusIndicator.querySelector('.status-text').innerText = message;
}

function updateAutoStatus(state, text) {
  const el = document.getElementById('auto-trade-status');
  if (!el) return;
  el.querySelector('.auto-status-dot').className = `auto-status-dot ${state}`;
  el.querySelector('.auto-status-text').innerText = text;
}

// ─── Trade API ───────────────────────────────────────────────
async function loadTradeLog() {
  try {
    const res = await fetch('/api/trades');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    tradeLog = json.data || [];
    renderTradeTable();
    renderKpiStats();
  } catch (e) {
    console.error('Error loading trades:', e);
  }
}

async function addTradeFromForm() {
  const isLong = document.getElementById('btn-toggle-long').classList.contains('active');
  const direction = isLong ? 'LONG' : 'SHORT';
  const tf = document.getElementById('input-tf-select').value || '15m';
  const capital = parseFloat(document.getElementById('input-capital-form').value) || 0;
  const riskPercent = parseFloat(document.getElementById('input-risk-form').value) || 0;
  const entry = parseFloat(document.getElementById('input-entry').value) || 0;
  const tp = parseFloat(document.getElementById('input-tp').value) || 0;
  const sl = parseFloat(document.getElementById('input-sl').value) || 0;

  if (!entry || !tp || !sl || !capital || !riskPercent) {
    alert('Lengkapi semua field: Entry, TP, SL, Capital, Risk %');
    return;
  }
  if (direction === 'LONG') {
    if (tp <= entry) { alert('TP harus lebih tinggi dari Entry untuk LONG'); return; }
    if (sl >= entry) { alert('SL harus lebih rendah dari Entry untuk LONG'); return; }
  } else {
    if (tp >= entry) { alert('TP harus lebih rendah dari Entry untuk SHORT'); return; }
    if (sl <= entry) { alert('SL harus lebih tinggi dari Entry untuk SHORT'); return; }
  }

  const riskUsd = capital * (riskPercent / 100);
  const slDistance = Math.abs(((entry - sl) / entry) * 100);
  const tpDistance = Math.abs(((tp - entry) / entry) * 100);
  const positionSizeUsd = riskUsd / (slDistance / 100);
  const timestamp = Date.now();

  const newTrade = {
    id: 'T' + timestamp, timestamp,
    time: new Date(timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    direction, tf, entry, tp, sl, capital, riskPercent, riskUsd,
    positionSizeUsd, tpDistance, slDistance,
    status: 'ACTIVE', pnl: 0, initialTpVolume: null
  };

  try {
    const res = await fetch('/api/trades/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTrade)
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
    document.getElementById('input-entry').value = '';
    document.getElementById('input-tp').value = '';
    document.getElementById('input-sl').value = '';
    await loadTradeLog();
  } catch (e) {
    console.error('Error adding trade:', e);
    alert('Failed to add trade: ' + e.message);
  }
}

window.manualCutLoss = async (tradeId) => {
  if (!currentBtcPrice) { alert('Harga BTC belum sinkron. Tunggu sebentar.'); return; }
  try {
    const res = await fetch('/api/trades/cut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tradeId, closePrice: currentBtcPrice })
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }
    await loadTradeLog();
  } catch (e) {
    console.error('Error cutting trade:', e);
    alert('Failed to cut trade: ' + e.message);
  }
};

window.deleteTrade = async (tradeId) => {
  try {
    const res = await fetch('/api/trades/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tradeId })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadTradeLog();
  } catch (e) {
    console.error('Error deleting trade:', e);
    alert('Failed to delete trade.');
  }
};

window.clearTradeLog = async () => {
  if (!confirm('Hapus semua trade? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    const res = await fetch('/api/trades/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadTradeLog();
  } catch (e) {
    console.error('Error clearing trades:', e);
    alert('Failed to clear trade log.');
  }
};

function getSignalSource(trade) {
  if (trade.id && (trade.id.startsWith('T_BT_heatmap24h') || trade.id.includes('24h') || trade.id.includes('24H'))) return 'Heatmap 24H';
  if (trade.id && (trade.id.startsWith('T_BT_heatmap3d') || trade.id.includes('3d') || trade.id.includes('3D'))) return 'Heatmap 3D';
  if (trade.note && trade.note.toLowerCase().includes('backtest')) {
    if (trade.note.includes('24H')) return 'Heatmap 24H';
    if (trade.note.includes('3D')) return 'Heatmap 3D';
  }
  if (trade.note && trade.note.toLowerCase().includes('jda')) return 'JDA Signal';
  if (trade.tf) {
    if (trade.tf === '15m') return '15m Heatmap';
    return `${trade.tf} Chart`;
  }
  return 'Manual / Live';
}

// ─── Render Trade Table ──────────────────────────────────────
function renderTradeTable() {
  const tbody = document.getElementById('backtest-log-tbody');
  if (!tbody) return;

  const total = tradeLog.length;
  const hitTp = tradeLog.filter(t => t.status === 'HIT_TP');
  const hitSl = tradeLog.filter(t => t.status === 'HIT_SL');
  const cutLoss = tradeLog.filter(t => t.status === 'CUT_LOSS');
  const closed = tradeLog.filter(t => t.status !== 'ACTIVE').length;
  const winRate = closed > 0 ? (hitTp.length / closed) * 100 : 0;
  const netPnl = tradeLog.reduce((s, t) => s + t.pnl, 0);

  // Stats
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  set('stat-total-trades', total);
  set('stat-winrate', winRate.toFixed(1) + '%');
  set('stat-hit-tp', hitTp.length);
  set('stat-hit-sl', hitSl.length);
  set('stat-cut-loss', cutLoss.length);
  const npUsd = document.getElementById('stat-net-profit-usd');
  const npIDR  = document.getElementById('stat-net-profit-idr');
  if (npUsd) { npUsd.innerText = formatUSD(netPnl); npUsd.className = 'backtest-stat-value ' + (netPnl >= 0 ? 'profit-positive' : 'profit-negative'); }
  if (npIDR) { npIDR.innerText = formatIDR(netPnl); npIDR.className = 'backtest-stat-value ' + (netPnl >= 0 ? 'profit-positive' : 'profit-negative'); }

  if (!total) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:20px;">No trades logged yet.</td></tr>';
    return;
  }

  const statusHtml = {
    'ACTIVE':   '<span class="status-badge active">Active</span>',
    'HIT_TP':   '<span class="status-badge hit-tp">Hit TP</span>',
    'HIT_SL':   '<span class="status-badge hit-sl">Hit SL</span>',
    'CUT_LOSS': '<span class="status-badge cut-loss">Cut Loss</span>'
  };

  const fmtTime = (ts) => {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2,'0') + '.' + d.getMinutes().toString().padStart(2,'0');
    } catch(e) { return ''; }
  };

  let html = '';
  const getTs = (t) => t.timestamp || (t.id && t.id.startsWith('T') ? parseInt(t.id.substring(1), 10) : 0);
  const sortedTrades = [...tradeLog].sort((a, b) => getTs(b) - getTs(a));

  sortedTrades.forEach(trade => {
    let ts = trade.timestamp;
    if (!ts && trade.id && trade.id.startsWith('T')) ts = parseInt(trade.id.substring(1), 10);
    let displayTime = trade.time;
    if (ts) {
      try {
        const d = new Date(ts);
        displayTime = d.getDate().toString().padStart(2,'0') + ' ' +
          d.toLocaleString('id-ID', { month: 'short' }) + ', ' +
          d.getHours().toString().padStart(2,'0') + '.' + d.getMinutes().toString().padStart(2,'0');
      } catch(e) {}
    }

    const rr = (trade.tpDistance / trade.slDistance).toFixed(2);
    const pnlClass = trade.pnl > 0 ? 'text-positive' : (trade.pnl < 0 ? 'text-negative' : '');
    const markPrice = trade.status === 'ACTIVE' ? (currentBtcPrice || trade.entry) : (trade.closePrice || trade.entry);
    const rowOpacity = trade.status !== 'ACTIVE' ? 'style="opacity:0.75;"' : '';
    const actionBtn = trade.status === 'ACTIVE' ? `<button class="btn-action-sm warning" onclick="manualCutLoss('${trade.id}')">Cut</button> ` : '';

    const entrySubtext = ts ? `<br><span style="font-size:9px;color:var(--text-muted);">${fmtTime(ts)}</span>` : '';
    const tpSubtext = trade.status === 'HIT_TP' && trade.closeTimestamp ? `<br><span style="font-size:9px;color:var(--text-muted);">${fmtTime(trade.closeTimestamp)}</span>` : '';
    const slSubtext = (trade.status === 'HIT_SL' || trade.status === 'CUT_LOSS') && trade.closeTimestamp ? `<br><span style="font-size:9px;color:var(--text-muted);">${fmtTime(trade.closeTimestamp)}</span>` : '';

    html += `<tr ${rowOpacity}>
      <td>${displayTime}</td>
      <td style="font-weight:700;color:${trade.direction === 'LONG' ? '#32D74B' : '#FF453A'};">${trade.direction}</td>
      <td style="font-family:var(--font-mono);color:#98989D;">${getSignalSource(trade)}</td>
      <td class="mono">$${trade.entry.toLocaleString(undefined,{minimumFractionDigits:2})}${entrySubtext}</td>
      <td class="mono" style="color:#32D74B;">$${trade.tp.toLocaleString(undefined,{minimumFractionDigits:2})}${tpSubtext}</td>
      <td class="mono" style="color:#FF453A;">$${trade.sl.toLocaleString(undefined,{minimumFractionDigits:2})}${slSubtext}</td>
      <td class="mono">$${trade.positionSizeUsd.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td class="mono">1:${rr}</td>
      <td>${statusHtml[trade.status] || ''}${trade.note ? `<br><span style="font-size:9px;color:var(--text-muted);">${trade.note}</span>` : ''}</td>
      <td class="mono">$${markPrice.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
      <td class="mono ${pnlClass}" style="font-weight:600;">${formatUSD(trade.pnl)}</td>
      <td class="mono ${pnlClass}">${formatIDR(trade.pnl)}</td>
      <td>${actionBtn}<button class="btn-action-sm danger" onclick="deleteTrade('${trade.id}')">Del</button></td>
    </tr>`;
  });
  tbody.innerHTML = html;
}

// ─── KPI Cards ────────────────────────────────────────────────
function renderKpiStats() {
  const total = tradeLog.length;
  const active = tradeLog.filter(t => t.status === 'ACTIVE').length;
  const hitTp = tradeLog.filter(t => t.status === 'HIT_TP').length;
  const hitSl = tradeLog.filter(t => t.status === 'HIT_SL').length;
  const cutLoss = tradeLog.filter(t => t.status === 'CUT_LOSS').length;
  const closed = total - active;
  const winRate = closed > 0 ? ((hitTp / closed) * 100).toFixed(1) : '0.0';
  const netPnl = tradeLog.reduce((s, t) => s + t.pnl, 0);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  const styleEl = (id, cls) => { const el = document.getElementById(id); if (el) el.className = `kpi-value select-mono ${cls}`; };

  set('val-win-rate', winRate + '%');
  styleEl('val-win-rate', parseFloat(winRate) > 50 ? 'text-positive' : parseFloat(winRate) > 0 ? '' : 'text-negative');
  set('foot-win-rate', `${hitTp} TP / ${hitSl} SL / ${cutLoss} Cut`);

  const pnlEl = document.getElementById('val-net-pnl');
  if (pnlEl) { pnlEl.innerText = formatUSD(netPnl); pnlEl.className = `kpi-value select-mono ${netPnl >= 0 ? 'text-positive' : 'text-negative'}`; }
  set('foot-net-pnl-idr', formatIDR(netPnl));

  set('val-total-trades', total);
  set('foot-active-trades', `${active} Active`);
}

// ─── Settings Sync ────────────────────────────────────────────
async function loadSettingsFromServer() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const s = json.data;

    const capForm = document.getElementById('input-capital-form');
    if (capForm) capForm.value = s.capital;
    const riskForm = document.getElementById('input-risk-form');
    if (riskForm) riskForm.value = s.riskPercent;
  } catch (e) {
    console.error('Error loading settings:', e);
  }
}

// ─── Bot Status Polling ───────────────────────────────────────
async function pollBotStatus() {
  if (botStatusIntervalId) clearInterval(botStatusIntervalId);

  const fetch_ = async () => {
    try {
      const res = await fetch('/api/bot-status');
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data;
      currentBtcPrice = json.btcPrice || null;

      // Phase badge (top-bar and KPI card)
      const phaseColors = {
        'STANDBY': { bg: 'rgba(152,152,157,0.2)', color: '#98989D' },
        'ALERT': { bg: 'rgba(255,159,10,0.25)', color: '#FF9F0A' },
        'SWEEP_DETECTED': { bg: 'rgba(50,215,75,0.25)', color: '#32D74B' },
        'TRADE_EXECUTED': { bg: 'rgba(0,229,255,0.25)', color: '#00E5FF' },
        'SWEEP_REJECTED': { bg: 'rgba(255,69,58,0.2)', color: '#FF453A' },
        'CONFLICTING_SWEEP': { bg: 'rgba(255,69,58,0.15)', color: '#FF453A' },
        'COOLDOWN': { bg: 'rgba(191,90,242,0.2)', color: '#BF5AF2' },
        'MAX_ACTIVE': { bg: 'rgba(255,214,10,0.2)', color: '#FFD60A' },
        'DISABLED': { bg: 'rgba(255,69,58,0.15)', color: '#FF453A' },
      };
      const phase = data.phase || 'STANDBY';
      const pc = phaseColors[phase] || { bg: 'rgba(152,152,157,0.15)', color: '#636366' };

      const phaseBadge = document.getElementById('lsr-phase-badge');
      if (phaseBadge) {
        phaseBadge.innerText = phase.replace(/_/g, ' ');
        phaseBadge.style.background = pc.bg;
        phaseBadge.style.color = pc.color;
      }

      // KPI phase card
      const valPhase = document.getElementById('val-bot-phase');
      if (valPhase) { valPhase.innerText = phase.replace(/_/g, ' '); valPhase.style.color = pc.color; }
      const footPool = document.getElementById('foot-bot-phase');
      if (footPool && data.nearestPool) {
        const sideColor = data.nearestPoolSide === 'RESISTANCE' ? '#F6465D' : '#0ECB81';
        footPool.innerHTML = `<span style="color:${sideColor}">${data.nearestPoolSide}</span> $${Math.round(data.nearestPool).toLocaleString()} · ${data.nearestPoolDistance}`;
      }

      // Prob
      const probEl = document.getElementById('lsr-prob-val');
      if (probEl) {
        const prob = data.reversalProbabilityPreview || (data.metrics && data.metrics.reversalProbability) || null;
        if (prob) {
          probEl.innerText = prob + '%';
          probEl.style.color = prob >= 75 ? '#32D74B' : prob >= 65 ? '#FFD60A' : '#FF453A';
        } else { probEl.innerText = '—'; }
      }

      // Nearest pool
      const poolEl = document.getElementById('lsr-nearest-pool');
      if (poolEl && data.nearestPool) {
        const c = data.nearestPoolSide === 'RESISTANCE' ? '#FF453A' : '#32D74B';
        poolEl.innerHTML = `<span style="color:${c};font-weight:600;">$${parseFloat(data.nearestPool).toLocaleString()}</span> <span style="color:#636366;">(${data.nearestPoolSide} ${data.nearestPoolDistance})</span>`;
      }

      // Funding
      const fundEl = document.getElementById('lsr-funding-rate-val');
      if (fundEl && data.metrics) {
        const fr = (data.metrics.fundingRate || 0) * 100;
        fundEl.innerText = fr.toFixed(4) + '%';
        fundEl.style.color = fr >= 0 ? '#FFD60A' : '#32D74B';
      }

      // L/S Ratio
      const lsEl = document.getElementById('lsr-ls-ratio-val');
      if (lsEl && data.metrics) { lsEl.innerText = (data.metrics.longShortRatio || 1.0).toFixed(2); }

      // Message
      const msgEl = document.getElementById('lsr-message');
      if (msgEl) msgEl.innerText = data.message || 'Waiting for data...';

      // Auto status dot
      const dotMap = { STANDBY:'scanning', ALERT:'active', TRADE_EXECUTED:'active', SWEEP_DETECTED:'active', COOLDOWN:'scanning', DISABLED:'', MAX_ACTIVE:'scanning' };
      updateAutoStatus(dotMap[phase] || 'scanning', data.autoTradeEnabled ? `LSR ${phase}` : 'LSR Bot inactive');

    } catch (e) {
      console.error('Error polling bot status:', e);
    }
  };

  await fetch_();
  botStatusIntervalId = setInterval(fetch_, 30000);
}

// ─── localStorage migration (one-time) ───────────────────────
async function migrateLocalTrades() {
  const stored = localStorage.getItem('wattvision_tradelog');
  if (!stored) return;
  try {
    const trades = JSON.parse(stored);
    if (trades && trades.length > 0) {
      for (const t of trades) {
        await fetch('/api/trades/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) });
      }
    }
  } catch (e) { console.error('[Migration] Failed:', e); }
  localStorage.removeItem('wattvision_tradelog');
  await loadTradeLog();
}

// ─── Backtest Engine ─────────────────────────────────────────────────────────
let backtestResults = [];

function calcEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const hi = parseFloat(candles[i][2]), lo = parseFloat(candles[i][3]), pc = parseFloat(candles[i-1][4]);
    sum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
  }
  return sum / period;
}

function findSwingLevels(historicalCandles, lookback) {
  const levels = [];
  for (let j = lookback; j < historicalCandles.length - lookback; j++) {
    const hi = parseFloat(historicalCandles[j][2]);
    const lo = parseFloat(historicalCandles[j][3]);
    let isHigh = true, isLow = true;
    for (let k = j - lookback; k <= j + lookback; k++) {
      if (k === j || k < 0 || k >= historicalCandles.length) continue;
      if (parseFloat(historicalCandles[k][2]) > hi) isHigh = false;
      if (parseFloat(historicalCandles[k][3]) < lo)  isLow  = false;
    }
    if (isHigh) levels.push({ price: hi, type: 'RESISTANCE' });
    if (isLow)  levels.push({ price: lo, type: 'SUPPORT' });
  }
  // Deduplicate within 0.3%
  const dedup = [];
  levels.forEach(l => {
    if (!dedup.some(dl => Math.abs(dl.price - l.price) / l.price < 0.003)) dedup.push(l);
  });
  return dedup;
}

function simulateStrategyBacktest(candles, settings) {
  const { capital, riskPercent, minRR, minProb, atrMultiplier, minSLPercent,
          sweepConfirmCandles, levelLookback, cooldownCandles } = settings;

  const allEvents = [];
  let lastTradeEndIdx = -(cooldownCandles + 1);
  let runningPnl = 0;
  const startIdx = Math.max(200 + levelLookback * 2, 50 + sweepConfirmCandles);

  for (let i = startIdx; i < candles.length - sweepConfirmCandles - 5; i++) {
    const windowEnd = i + sweepConfirmCandles - 1;
    if (windowEnd >= candles.length) break;

    const currentCandle = candles[windowEnd];
    const currentPrice  = parseFloat(currentCandle[4]);
    if (isNaN(currentPrice)) continue;

    const recentCandles  = candles.slice(i, i + sweepConfirmCandles);
    const olderCandles   = candles.slice(Math.max(0, i - 15), i);
    const histCandles    = candles.slice(Math.max(0, i - 80), i - sweepConfirmCandles);

    const levels = findSwingLevels(histCandles, levelLookback);
    const nearbyLevels = levels.filter(l => {
      const dist = Math.abs((l.price - currentPrice) / currentPrice) * 100;
      return dist >= 0.2 && dist <= 8;
    });
    if (nearbyLevels.length === 0) continue;

    // Detect sweeps
    const sweepCandidates = [];
    for (const level of nearbyLevels) {
      const p = level.price;
      const alreadySwepted = olderCandles.some(c => parseFloat(c[3]) <= p && p <= parseFloat(c[2]));
      if (alreadySwepted) continue;

      const sweepIdx = recentCandles.findIndex(c => {
        const cC = parseFloat(c[4]), cL = parseFloat(c[3]), cH = parseFloat(c[2]);
        if (isNaN(cC)||isNaN(cL)||isNaN(cH)) return false;
        return p < currentPrice ? (cL <= p && cC > p) : (cH >= p && cC < p);
      });
      if (sweepIdx === -1) continue;

      const sw = recentCandles[sweepIdx];
      const cC = parseFloat(sw[4]), cL = parseFloat(sw[3]), cH = parseFloat(sw[2]);
      const range = cH - cL;

      if (p < currentPrice) {
        const wick = Math.abs((cL - p) / p * 100);
        const rej  = range > 0 ? (cC - cL) / range : 0;
        sweepCandidates.push({ price: p, direction: 'LONG', sweepLow: cL, sweepHigh: cH, sweepClose: cC, wick, rejectionStrength: rej, score: rej * (1 + wick) });
      } else {
        const wick = Math.abs((cH - p) / p * 100);
        const rej  = range > 0 ? (cH - cC) / range : 0;
        sweepCandidates.push({ price: p, direction: 'SHORT', sweepLow: cL, sweepHigh: cH, sweepClose: cC, wick, rejectionStrength: rej, score: rej * (1 + wick) });
      }
    }
    if (sweepCandidates.length === 0) continue;

    sweepCandidates.sort((a, b) => b.score - a.score);
    const best      = sweepCandidates[0];
    const direction = best.direction;
    const entry     = currentPrice;

    // ─── Probability Scoring (simplified without live OI/CVD) ─────────────
    let prob = 40;

    // 1. Rejection strength (0–20)
    const rejPts = Math.min(20, best.rejectionStrength * 20);
    prob += rejPts;

    // 2. Relative volume of sweep candle vs 20-candle avg (0–15)
    const vols20  = candles.slice(Math.max(0, windowEnd-20), windowEnd).map(c => parseFloat(c[5]));
    const avgVol  = vols20.reduce((a,b)=>a+b,0) / (vols20.length||1);
    const swVol   = parseFloat(recentCandles[0][5]) || avgVol;
    const volPts  = Math.min(15, (swVol / avgVol) * 7.5);
    prob += volPts;

    // 3. EMA50 vs EMA200 trend (0 or ±10)
    const closes50  = candles.slice(Math.max(0, windowEnd-200), windowEnd+1).map(c => parseFloat(c[4]));
    const ema50     = calcEMA(closes50, Math.min(50, closes50.length));
    const ema200    = calcEMA(closes50, Math.min(200, closes50.length));
    const bullish   = ema50 && ema200 && ema50 > ema200;
    const bearish   = ema50 && ema200 && ema50 < ema200;
    let trendPts = 0;
    if (direction === 'LONG'  && bullish) trendPts =  10;
    if (direction === 'LONG'  && bearish) trendPts = -10;
    if (direction === 'SHORT' && bearish) trendPts =  10;
    if (direction === 'SHORT' && bullish) trendPts = -10;
    prob += trendPts;

    // 4. Price position in 20-bar range (momentum, 0–10)
    const hi20 = Math.max(...candles.slice(Math.max(0,windowEnd-20),windowEnd+1).map(c=>parseFloat(c[2])));
    const lo20 = Math.min(...candles.slice(Math.max(0,windowEnd-20),windowEnd+1).map(c=>parseFloat(c[3])));
    const midRange = (hi20 + lo20) / 2;
    let momPts = 0;
    if ((direction === 'LONG' && entry < midRange) || (direction === 'SHORT' && entry > midRange)) momPts = 10;
    prob += momPts;

    prob = Math.max(20, Math.min(99, Math.round(prob)));

    // ─── ATR-based SL ──────────────────────────────────────────────────────
    const atr = calcATR(candles.slice(Math.max(0, windowEnd-14), windowEnd+1), 14);
    const minBuf = entry * (minSLPercent / 100);
    const atrBuf = atr ? atr * atrMultiplier : minBuf;
    const slBuf  = Math.max(minBuf, atrBuf);

    let sl = direction === 'LONG' ? best.sweepLow - slBuf : best.sweepHigh + slBuf;
    let slDist = Math.abs(((entry - sl) / entry) * 100);
    if (slDist < minSLPercent) {
      slDist = minSLPercent;
      sl = direction === 'LONG' ? entry * (1 - minSLPercent/100) : entry * (1 + minSLPercent/100);
    }

    // ─── TP: opposing swing level or fallback ──────────────────────────────
    const maxTpDist = entry * (1.5 / 100);
    const opposing = nearbyLevels
      .filter(l => direction === 'LONG' ? l.price > entry && l.price - entry <= maxTpDist
                                        : l.price < entry && entry - l.price <= maxTpDist)
      .sort((a, b) => direction === 'LONG' ? b.price - a.price : a.price - b.price);

    let tp = 0;
    if (opposing.length > 0) {
      tp = opposing[0].price;
    } else {
      const fallDist = Math.max(slDist * Math.max(minRR, 2.0), 1.5);
      tp = direction === 'LONG' ? entry * (1 + fallDist/100) : entry * (1 - fallDist/100);
    }

    const tpDist = Math.abs(((tp - entry) / entry) * 100);
    const rr     = parseFloat((tpDist / slDist).toFixed(2));

    // ─── Filters ───────────────────────────────────────────────────────────
    let skipReason = null;
    if (rr < minRR)                                                skipReason = `Low R:R ${rr} < ${minRR}`;
    else if (prob < minProb)                                        skipReason = `Low Prob ${prob}% < ${minProb}%`;
    else if (direction === 'LONG'  && bearish && trendPts <= -10)  skipReason = 'Bearish HTF Trend';
    else if (direction === 'SHORT' && bullish && trendPts <= -10)  skipReason = 'Bullish HTF Trend';
    else if (i - lastTradeEndIdx < cooldownCandles)                 skipReason = `Cooldown (${cooldownCandles-(i-lastTradeEndIdx)} left)`;

    const event = {
      idx: i, direction, poolPrice: best.price, entry, sl, tp,
      rr, slDist: parseFloat(slDist.toFixed(3)), tpDist: parseFloat(tpDist.toFixed(3)),
      prob, skipReason,
      rejectionStrength: best.rejectionStrength,
      wickDepth: best.wick,
      timestamp: parseInt(recentCandles[recentCandles.length-1][0]),
      riskUsd: capital * riskPercent / 100,
      probBreakdown: { rejection: Math.round(rejPts*10)/10, volume: Math.round(volPts*10)/10, trend: trendPts, momentum: momPts }
    };

    if (!skipReason) {
      // Simulate forward outcome
      let outcome = 'ACTIVE', closePrice = null, closeTs = null;
      for (let k = windowEnd + 1; k < Math.min(windowEnd + 200, candles.length); k++) {
        const cH = parseFloat(candles[k][2]), cL = parseFloat(candles[k][3]);
        if (direction === 'LONG') {
          if (cL <= sl) { outcome = 'HIT_SL'; closePrice = sl; closeTs = parseInt(candles[k][0]); break; }
          if (cH >= tp) { outcome = 'HIT_TP'; closePrice = tp; closeTs = parseInt(candles[k][0]); break; }
        } else {
          if (cH >= sl) { outcome = 'HIT_SL'; closePrice = sl; closeTs = parseInt(candles[k][0]); break; }
          if (cL <= tp) { outcome = 'HIT_TP'; closePrice = tp; closeTs = parseInt(candles[k][0]); break; }
        }
      }

      const riskUsd = capital * riskPercent / 100;
      const pnl = outcome === 'HIT_TP' ? riskUsd * rr : outcome === 'HIT_SL' ? -riskUsd : 0;
      runningPnl += pnl;

      event.outcome = outcome;
      event.closePrice = closePrice;
      event.closeTimestamp = closeTs;
      event.pnl = pnl;
      event.runningPnl = runningPnl;
      event.positionSizeUsd = riskUsd / (slDist / 100);

      if (outcome !== 'ACTIVE') {
        // Find close candle index for cooldown tracking
        const closeIdx = closeTs ? candles.findIndex(c => parseInt(c[0]) >= closeTs) : windowEnd;
        lastTradeEndIdx = closeIdx > 0 ? closeIdx : windowEnd;
      }
      i += 4; // skip a few candles to avoid re-detecting same sweep
    } else {
      event.outcome = 'SKIPPED';
      event.pnl = 0;
    }

    allEvents.push(event);
  }

  return allEvents;
}

async function runBacktest() {
  const days     = parseInt(document.getElementById('bt-days').value)    || 14;
  const capital  = parseFloat(document.getElementById('bt-capital').value) || 5000;
  const riskPct  = parseFloat(document.getElementById('bt-risk').value)   || 1;
  const minRR    = parseFloat(document.getElementById('bt-minrr').value)  || 1.2;
  const minProb  = parseInt(document.getElementById('bt-minprob').value)  || 60;
  const atrMult  = parseFloat(document.getElementById('bt-atrmult').value)|| 3;
  const minSLPct = parseFloat(document.getElementById('bt-minsl').value)  || 1.2;
  const lookback = parseInt(document.getElementById('bt-lookback').value) || 10;

  const btn  = document.getElementById('btn-run-backtest');
  const prog = document.getElementById('bt-progress');
  btn.disabled = true; btn.innerText = 'Running...';
  prog.style.display = 'block';

  try {
    const limit = Math.min(1000, days * 96); // 96 × 15m = 1 day
    prog.innerText = `Fetching ${limit} × 15m BTC candles (${days} days) from Binance…`;

    let candles;
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=${limit}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      candles = await r.json();
    } catch (fetchErr) {
      // Fallback Binance endpoint
      const r2 = await fetch(`https://api1.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=${limit}`);
      if (!r2.ok) throw new Error(`Binance API unreachable: ${fetchErr.message}`);
      candles = await r2.json();
    }

    prog.innerText = `Got ${candles.length} candles. Identifying swing levels & simulating sweeps…`;
    await new Promise(r => setTimeout(r, 30));

    backtestResults = simulateStrategyBacktest(candles, {
      capital, riskPercent: riskPct, minRR, minProb,
      atrMultiplier: atrMult, minSLPercent: minSLPct,
      sweepConfirmCandles: 5, levelLookback: lookback, cooldownCandles: 8
    });

    prog.innerText = `Done — ${backtestResults.length} sweep events found.`;
    renderBacktestResults(backtestResults, capital, riskPct);
    setTimeout(() => { prog.style.display = 'none'; }, 2500);
  } catch (e) {
    prog.innerText = `Error: ${e.message}`;
    console.error('Backtest error:', e);
  } finally {
    btn.disabled = false; btn.innerText = '▶ Run Backtest';
  }
}

function renderBacktestResults(events, capital, riskPct) {
  const trades   = events.filter(e => e.outcome !== 'SKIPPED');
  const skipped  = events.filter(e => e.outcome === 'SKIPPED');
  const hitTp    = trades.filter(t => t.outcome === 'HIT_TP');
  const hitSl    = trades.filter(t => t.outcome === 'HIT_SL');
  const active   = trades.filter(t => t.outcome === 'ACTIVE');
  const closed   = trades.filter(t => t.outcome !== 'ACTIVE');
  const winRate  = closed.length > 0 ? ((hitTp.length / closed.length) * 100).toFixed(1) : '0.0';
  const netPnl   = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const maxDD    = calcMaxDrawdown(trades);
  const roi      = capital > 0 ? ((netPnl / capital) * 100).toFixed(2) : '0.00';

  const s = id => document.getElementById(id);
  const set = (id, v) => { const el = s(id); if (el) el.innerText = v; };

  set('bt-stat-total',    events.length);
  set('bt-stat-traded',   trades.length);
  set('bt-stat-skipped',  skipped.length);
  set('bt-stat-winrate',  winRate + '%');
  set('bt-stat-tp',       hitTp.length);
  set('bt-stat-sl',       hitSl.length);
  set('bt-stat-active',   active.length);

  const pnlEl = s('bt-stat-pnl');
  if (pnlEl) { pnlEl.innerText = formatUSD(netPnl); pnlEl.style.color = netPnl >= 0 ? '#32D74B' : '#FF453A'; }
  const roiEl = s('bt-stat-roi');
  if (roiEl) { roiEl.innerText = roi + '%'; roiEl.style.color = parseFloat(roi) >= 0 ? '#32D74B' : '#FF453A'; }
  const ddEl = s('bt-stat-drawdown');
  if (ddEl) { ddEl.innerText = formatUSD(maxDD); ddEl.style.color = '#FF453A'; }

  const tbody = s('bt-result-tbody');
  if (!tbody) return;

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:30px;">No sweep events detected. Try lowering Min Prob or adjusting Level Lookback.</td></tr>';
    return;
  }

  let html = '';
  [...events].reverse().forEach(ev => {
    const d = new Date(ev.timestamp);
    const t = `${d.getDate().toString().padStart(2,'0')} ${d.toLocaleString('id-ID',{month:'short'})} ${d.getHours().toString().padStart(2,'0')}.${d.getMinutes().toString().padStart(2,'0')}`;

    let statusCell = '', pnlCell = '-', cumCell = '-';
    if (ev.outcome === 'HIT_TP') {
      statusCell = '<span class="status-badge hit-tp">Hit TP</span>';
      pnlCell = `<span style="color:#32D74B;font-weight:600;">+${formatUSD(ev.pnl)}</span>`;
      cumCell = `<span style="color:${(ev.runningPnl||0)>=0?'#32D74B':'#FF453A'};font-size:11px;">${formatUSD(ev.runningPnl||0)}</span>`;
    } else if (ev.outcome === 'HIT_SL') {
      statusCell = '<span class="status-badge hit-sl">Hit SL</span>';
      pnlCell = `<span style="color:#FF453A;font-weight:600;">${formatUSD(ev.pnl)}</span>`;
      cumCell = `<span style="color:${(ev.runningPnl||0)>=0?'#32D74B':'#FF453A'};font-size:11px;">${formatUSD(ev.runningPnl||0)}</span>`;
    } else if (ev.outcome === 'ACTIVE') {
      statusCell = '<span class="status-badge active">Active</span>';
    } else {
      // SKIPPED
      const sr = ev.skipReason || 'Filtered';
      statusCell = `<span style="font-size:10px;color:#636366;">${sr}</span>`;
    }

    const dirC = ev.direction === 'LONG' ? '#32D74B' : '#FF453A';
    const probC = ev.prob >= 70 ? '#32D74B' : ev.prob >= 60 ? '#F0B90B' : '#FF453A';
    const pb = ev.probBreakdown || {};
    const probTip = `title="Rej:+${pb.rejection||0} Vol:+${pb.volume||0} Trend:${pb.trend>=0?'+':''}${pb.trend||0} Mom:+${pb.momentum||0}"`;

    const actionCell = ev.outcome !== 'SKIPPED'
      ? `<button class="btn-action-sm" onclick="importBtTrade(${ev.idx})">Import</button>`
      : '';

    html += `<tr style="${ev.outcome==='SKIPPED'?'opacity:0.5;':''}">
      <td style="color:#98989D;font-size:10px;white-space:nowrap;">${t}</td>
      <td style="font-weight:700;color:${dirC};font-size:12px;">${ev.direction}</td>
      <td class="mono" style="color:#848E9C;font-size:11px;">$${ev.poolPrice.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td class="mono" style="font-size:11px;">$${ev.entry.toFixed(0)}</td>
      <td class="mono" style="color:#32D74B;font-size:11px;">$${ev.tp.toFixed(0)}</td>
      <td class="mono" style="color:#FF453A;font-size:11px;">$${ev.sl.toFixed(0)}</td>
      <td class="mono" style="font-size:11px;">1:${ev.rr}</td>
      <td class="mono" style="color:${probC};font-size:12px;" ${probTip}>${ev.prob}%</td>
      <td style="font-size:11px;">${statusCell}</td>
      <td>${pnlCell}</td>
      <td>${cumCell}</td>
      <td>${actionCell}</td>
    </tr>`;
  });
  tbody.innerHTML = html;

  const importBtn = document.getElementById('btn-import-all-backtest');
  if (importBtn && trades.length > 0) importBtn.style.display = 'inline-flex';
}

function calcMaxDrawdown(trades) {
  let peak = 0, maxDD = 0, running = 0;
  trades.forEach(t => {
    running += t.pnl || 0;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  });
  return maxDD;
}

window.importBtTrade = async function(idx) {
  const ev = backtestResults.find(e => e.idx === idx);
  if (!ev || ev.outcome === 'SKIPPED') return;

  const capital  = parseFloat(document.getElementById('bt-capital').value) || 5000;
  const riskPct  = parseFloat(document.getElementById('bt-risk').value)    || 1;
  const riskUsd  = capital * riskPct / 100;
  const posSize  = riskUsd / (ev.slDist / 100);

  const trade = {
    id: `T_BT_${ev.idx}_${ev.timestamp}`,
    timestamp: ev.timestamp,
    time: new Date(ev.timestamp).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
    direction: ev.direction, tf: '15m',
    entry: ev.entry, tp: ev.tp, sl: ev.sl,
    capital, riskPercent: riskPct, riskUsd, positionSizeUsd: posSize,
    tpDistance: ev.tpDist, slDistance: ev.slDist,
    status: ev.outcome === 'HIT_TP' ? 'HIT_TP' : ev.outcome === 'HIT_SL' ? 'HIT_SL' : 'ACTIVE',
    pnl: ev.pnl || 0,
    closePrice: ev.closePrice || ev.entry,
    closeTimestamp: ev.closeTimestamp || null,
    note: `Backtest 15m LSR | Pool:$${ev.poolPrice.toFixed(0)} | Prob:${ev.prob}% | RR:1:${ev.rr}`,
    initialTpVolume: null
  };

  try {
    const r = await fetch('/api/trades/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(trade) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    alert(`✅ Imported: ${ev.direction} $${ev.entry.toFixed(0)} → ${ev.outcome}`);
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
};

window.importAllBacktestTrades = async function() {
  const tradable = backtestResults.filter(e => e.outcome !== 'SKIPPED');
  if (tradable.length === 0) { alert('No trades to import.'); return; }
  if (!confirm(`Import ${tradable.length} backtest trades to journal?`)) return;

  const capital = parseFloat(document.getElementById('bt-capital').value) || 5000;
  const riskPct = parseFloat(document.getElementById('bt-risk').value)    || 1;

  let imported = 0;
  for (const ev of tradable) {
    const riskUsd = capital * riskPct / 100;
    const posSize = riskUsd / (ev.slDist / 100);
    const trade = {
      id: `T_BT_${ev.idx}_${ev.timestamp}`,
      timestamp: ev.timestamp,
      time: new Date(ev.timestamp).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
      direction: ev.direction, tf: '15m',
      entry: ev.entry, tp: ev.tp, sl: ev.sl,
      capital, riskPercent: riskPct, riskUsd, positionSizeUsd: posSize,
      tpDistance: ev.tpDist, slDistance: ev.slDist,
      status: ev.outcome === 'HIT_TP' ? 'HIT_TP' : ev.outcome === 'HIT_SL' ? 'HIT_SL' : 'ACTIVE',
      pnl: ev.pnl || 0,
      closePrice: ev.closePrice || ev.entry,
      closeTimestamp: ev.closeTimestamp || null,
      note: `Backtest 15m LSR | Pool:$${ev.poolPrice.toFixed(0)} | Prob:${ev.prob}% | RR:1:${ev.rr}`,
      initialTpVolume: null
    };
    try {
      await fetch('/api/trades/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(trade) });
      imported++;
    } catch (e) { console.error('Import error:', e); }
  }

  alert(`✅ ${imported}/${tradable.length} trades imported to journal!`);
  switchPageTab('journal');
  await loadTradeLog();
};

// ─── Init ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  updateStatus('loading', 'Loading...');

  // Read URL params (pre-fill from heatmap E/TP quick buttons)
  const params = new URLSearchParams(window.location.search);
  const preEntry = params.get('entry');
  const preTp    = params.get('tp');
  const preSl    = params.get('sl');
  if (preEntry) document.getElementById('input-entry').value = preEntry;
  if (preTp)    document.getElementById('input-tp').value    = preTp;
  if (preSl)    document.getElementById('input-sl').value    = preSl;

  await loadSettingsFromServer();
  await migrateLocalTrades();
  await loadTradeLog();
  pollBotStatus();

  updateStatus('normal', 'Live');

  // Sync now button
  btnRefresh.addEventListener('click', async () => {
    updateStatus('loading', 'Updating...');
    await loadTradeLog();
    await pollBotStatus();
    updateStatus('normal', 'Live');
  });



  // Direction toggle
  const btnLong = document.getElementById('btn-toggle-long');
  const btnShort = document.getElementById('btn-toggle-short');
  if (btnLong) btnLong.addEventListener('click', () => { btnLong.classList.add('active'); btnShort.classList.remove('active'); });
  if (btnShort) btnShort.addEventListener('click', () => { btnShort.classList.add('active'); btnLong.classList.remove('active'); });

  // Add trade button
  const btnAdd = document.getElementById('btn-add-trade');
  if (btnAdd) btnAdd.addEventListener('click', addTradeFromForm);

  // Clear log button
  const btnClear = document.getElementById('btn-clear-backtest-log');
  if (btnClear) btnClear.addEventListener('click', window.clearTradeLog);

  // Auto-refresh trades every 30 seconds
  setInterval(loadTradeLog, 30000);
});
