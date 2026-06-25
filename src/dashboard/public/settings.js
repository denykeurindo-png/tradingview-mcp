// JDA Trade Monitor — Settings Controller
let autoTradeEnabled = true;
let botStatusIntervalId = null;

const toast = document.getElementById('save-toast');
const btnToggle = document.getElementById('btn-auto-trade-toggle');
const btnTele = document.getElementById('btn-test-telegram');

function showToast() {
  if (!toast) return;
  toast.style.display = 'flex';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 2500);
}

function updateAutoStatus(state, text) {
  const el = document.getElementById('auto-trade-status');
  if (!el) return;
  el.querySelector('.auto-status-dot').className = `auto-status-dot ${state}`;
  el.querySelector('.auto-status-text').innerText = text;
}

// ─── Settings API ────────────────────────────────────────────
async function loadSettingsFromServer() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const s = json.data;

    document.getElementById('input-capital').value = s.capital;
    document.getElementById('input-risk').value = s.riskPercent;
    document.getElementById('auto-min-rr').value = s.minRR;
    document.getElementById('auto-min-prob').value = s.minReversalProbability || 65;
    document.getElementById('auto-max-active').value = s.maxActive;
    document.getElementById('auto-sweep-candles').value = s.sweepConfirmCandles || 5;
    document.getElementById('auto-cooldown').value = s.cooldownMinutes || 60;
    document.getElementById('auto-max-tp-percent').value = s.maxTPPercent !== undefined ? s.maxTPPercent : 1.5;
    document.getElementById('auto-cut-dist-threshold').value = s.autoCutDistanceThreshold !== undefined ? s.autoCutDistanceThreshold : 1.0;
    document.getElementById('auto-breakeven-enabled').checked = s.breakevenEnabled !== false;
    document.getElementById('tele-bot-token').value = s.telegramBotToken || '';
    document.getElementById('tele-chat-id').value = s.telegramChatId || '';

    autoTradeEnabled = s.autoTradeEnabled;
    if (btnToggle) {
      btnToggle.className = `auto-toggle-btn ${autoTradeEnabled ? 'on' : 'off'}`;
      btnToggle.innerText = autoTradeEnabled ? 'ON' : 'OFF';
    }
    updateAutoStatus(autoTradeEnabled ? 'active' : '', autoTradeEnabled ? 'Bot active (server)' : 'Bot inactive');
  } catch (e) {
    console.error('Error loading settings:', e);
  }
}

async function saveSettingsToServer() {
  const getNum = (id, def) => {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : def;
    return isNaN(v) ? def : v;
  };
  const getInt = (id, def) => {
    const el = document.getElementById(id);
    const v = el ? parseInt(el.value, 10) : def;
    return isNaN(v) ? def : v;
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capital: getNum('input-capital', 1000),
        riskPercent: getNum('input-risk', 1.0),
        minRR: getNum('auto-min-rr', 2.0),
        minReversalProbability: getInt('auto-min-prob', 65),
        maxActive: getInt('auto-max-active', 1),
        sweepConfirmCandles: getInt('auto-sweep-candles', 5),
        cooldownMinutes: getInt('auto-cooldown', 60),
        maxTPPercent: getNum('auto-max-tp-percent', 1.5),
        autoCutDistanceThreshold: getNum('auto-cut-dist-threshold', 1.0),
        breakevenEnabled: document.getElementById('auto-breakeven-enabled').checked,
        autoTradeEnabled,
        telegramBotToken: document.getElementById('tele-bot-token').value.trim(),
        telegramChatId: document.getElementById('tele-chat-id').value.trim()
      })
    });
    if (res.ok) {
      showToast();
    }
  } catch (e) {
    console.error('Error saving settings:', e);
  }
}

// ─── Bot Status Polling ───────────────────────────────────────
async function pollBotStatus() {
  const fetch_ = async () => {
    try {
      const res = await fetch('/api/bot-status');
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data;

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

      const dotMap = { STANDBY:'scanning', ALERT:'active', TRADE_EXECUTED:'active', SWEEP_DETECTED:'active', COOLDOWN:'scanning', DISABLED:'', MAX_ACTIVE:'scanning' };
      updateAutoStatus(dotMap[phase] || 'scanning', data.autoTradeEnabled ? `LSR ${phase}` : 'LSR Bot inactive');
    } catch (e) {
      console.error('Error polling bot status:', e);
    }
  };

  await fetch_();
  if (botStatusIntervalId) clearInterval(botStatusIntervalId);
  botStatusIntervalId = setInterval(fetch_, 10000);
}

// ─── Init ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await loadSettingsFromServer();
  pollBotStatus();

  // Attach change listeners to strategy inputs to save automatically
  const autoSaveIds = [
    'input-capital', 'input-risk', 'auto-min-rr', 'auto-min-prob', 
    'auto-max-active', 'auto-sweep-candles', 'auto-cooldown', 
    'auto-max-tp-percent', 'auto-cut-dist-threshold', 'auto-breakeven-enabled',
    'tele-bot-token', 'tele-chat-id'
  ];
  autoSaveIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', saveSettingsToServer);
    }
  });

  // Bot ON/OFF Toggle
  if (btnToggle) {
    btnToggle.addEventListener('click', async () => {
      autoTradeEnabled = !autoTradeEnabled;
      btnToggle.className = `auto-toggle-btn ${autoTradeEnabled ? 'on' : 'off'}`;
      btnToggle.innerText = autoTradeEnabled ? 'ON' : 'OFF';
      updateAutoStatus(autoTradeEnabled ? 'active' : '', autoTradeEnabled ? 'Bot active (server)' : 'Bot inactive');
      await saveSettingsToServer();
    });
  }

  // Telegram test send
  if (btnTele) {
    btnTele.addEventListener('click', async () => {
      const token = document.getElementById('tele-bot-token').value.trim();
      const chatId = document.getElementById('tele-chat-id').value.trim();
      if (!token || !chatId) { alert('Lengkapi Bot Token dan Chat ID.'); return; }
      
      btnTele.disabled = true;
      btnTele.innerText = '⏳ Sending...';
      try {
        const res = await fetch('/api/telegram/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, chatId })
        });
        const json = await res.json();
        alert(json.success ? 'Berhasil! Pesan tes dikirim ke Telegram.' : `Gagal: ${json.error}`);
      } catch (e) {
        alert('Gagal mengirim pesan tes.');
      } finally {
        btnTele.disabled = false;
        btnTele.innerText = '⚡ Test Send';
      }
    });
  }
});
