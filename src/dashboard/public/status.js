const ICONS = {
  server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
  cdp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  binance_spot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  binance_futures: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  telegram: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
};

const BADGE_LABEL = { ok: 'OK', error: 'ERROR', warning: 'WARNING', unconfigured: 'NOT SET' };

function statusCard(check) {
  const s = check.status;
  const icon = ICONS[check.key] || ICONS.server;
  const latencyStr = check.latency > 0 ? `${check.latency}ms` : '—';

  return `
    <div class="conn-card status-${s}">
      <div class="conn-card-header">
        <div class="conn-icon ${s}">${icon}</div>
        <span class="conn-name">${check.name}</span>
        <span class="conn-badge badge-${s}">${BADGE_LABEL[s] || s}</span>
      </div>
      <div class="conn-detail">${escHtml(check.detail)}</div>
      <div class="conn-latency">Latency: ${latencyStr}</div>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fetchStatus() {
  const btn = document.getElementById('btn-refresh');
  const statusEl = document.getElementById('connection-status');
  const statusDot = statusEl.querySelector('.status-dot');
  const statusText = statusEl.querySelector('.status-text');

  btn.disabled = true;
  btn.textContent = 'Checking...';
  statusText.textContent = 'Checking...';
  statusEl.className = 'status-indicator normal';

  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const grid = document.getElementById('status-grid');
    grid.innerHTML = data.checks.map(statusCard).join('');

    const errCount = data.errCount;
    const warnCount = data.checks.filter(c => c.status === 'warning').length;
    const unconfigCount = data.checks.filter(c => c.status === 'unconfigured').length;
    const okCount = data.okCount;

    // Summary bar
    const bar = document.getElementById('summary-bar');
    bar.style.display = 'flex';
    document.getElementById('sum-ok').textContent = `${okCount} OK`;
    document.getElementById('sum-err').textContent = errCount > 0 ? `${errCount} Error` : '';
    document.getElementById('sum-warn').textContent = (warnCount + unconfigCount) > 0 ? `${warnCount + unconfigCount} Warning` : '';
    document.getElementById('sum-ts').textContent = `Checked at ${new Date(data.checkedAt).toLocaleTimeString()}`;

    // Top-bar status dot
    if (errCount > 0) {
      statusEl.className = 'status-indicator alert';
      statusText.textContent = `${errCount} connection error${errCount > 1 ? 's' : ''}`;
    } else if (warnCount + unconfigCount > 0) {
      statusEl.className = 'status-indicator warning';
      statusText.textContent = 'Some services need attention';
    } else {
      statusEl.className = 'status-indicator normal';
      statusText.textContent = 'All systems OK';
    }
  } catch (e) {
    document.getElementById('status-grid').innerHTML =
      `<div class="conn-card status-error" style="grid-column:1/-1"><div class="conn-detail">Failed to reach /api/status: ${escHtml(e.message)}</div></div>`;
    statusText.textContent = 'Check failed';
    statusEl.className = 'status-indicator alert';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Check Now`;
  }
}

document.getElementById('btn-refresh').addEventListener('click', fetchStatus);

// Auto-check on load + every 30s
fetchStatus();
setInterval(fetchStatus, 30000);
