// JDA Trade Monitor — Live Trade Journal
const EXCHANGE_RATE = 6.96;

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
const formatBs = (v) => {
  if (!v && v !== 0) return 'Bs. 0.00';
  const bs = v * EXCHANGE_RATE; const neg = bs < 0; const abs = Math.abs(bs);
  let f = abs >= 1e9 ? (abs/1e9).toFixed(2)+'B' : abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(2)+'K' : abs.toFixed(2);
  return `${neg ? '-' : ''}Bs. ${f}`;
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
    direction, entry, tp, sl, capital, riskPercent, riskUsd,
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
  const npBs  = document.getElementById('stat-net-profit-bs');
  if (npUsd) { npUsd.innerText = formatUSD(netPnl); npUsd.className = 'backtest-stat-value ' + (netPnl >= 0 ? 'profit-positive' : 'profit-negative'); }
  if (npBs)  { npBs.innerText  = formatBs(netPnl);  npBs.className  = 'backtest-stat-value ' + (netPnl >= 0 ? 'profit-positive' : 'profit-negative'); }

  if (!total) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:20px;">No trades logged yet.</td></tr>';
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
      <td class="mono">$${trade.entry.toLocaleString(undefined,{minimumFractionDigits:2})}${entrySubtext}</td>
      <td class="mono" style="color:#32D74B;">$${trade.tp.toLocaleString(undefined,{minimumFractionDigits:2})}${tpSubtext}</td>
      <td class="mono" style="color:#FF453A;">$${trade.sl.toLocaleString(undefined,{minimumFractionDigits:2})}${slSubtext}</td>
      <td class="mono">$${trade.positionSizeUsd.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td class="mono">1:${rr}</td>
      <td>${statusHtml[trade.status] || ''}${trade.note ? `<br><span style="font-size:9px;color:var(--text-muted);">${trade.note}</span>` : ''}</td>
      <td class="mono">$${markPrice.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
      <td class="mono ${pnlClass}" style="font-weight:600;">${formatUSD(trade.pnl)}</td>
      <td class="mono ${pnlClass}">${formatBs(trade.pnl)}</td>
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
  set('foot-net-pnl-bs', formatBs(netPnl));

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
