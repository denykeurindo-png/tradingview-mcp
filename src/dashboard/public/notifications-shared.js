// Unified Dashboard Notifications Shared Library

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSharedNotifications);
} else {
  initSharedNotifications();
}

// Expose global functions so other scripts can call them
window.addNotification = function(type, title, desc, timestampStr = null, preventSave = false) {
  const container = document.getElementById('notifications-list');
  if (!container) {
    // If not injected yet, let's inject it now
    initSharedNotifications();
  }
  
  const finalContainer = document.getElementById('notifications-list');
  if (!finalContainer) return; // if still not found, ignore
  
  // Clean placeholder text
  if (finalContainer.innerHTML.includes('No alerts or notifications yet')) {
    finalContainer.innerHTML = '';
  }
  
  const now = Date.now();
  if (!preventSave) {
    // Avoid duplicate warnings for identical title/desc in the last 1 minute (only for live notifications)
    const recentDups = Array.from(finalContainer.children).filter(el => {
      return el.dataset.title === title && el.dataset.desc === desc && (now - parseInt(el.dataset.time || 0) < 60000);
    });
    if (recentDups.length > 0) return;
  }
  
  const item = document.createElement('div');
  item.className = 'notif-item';
  item.dataset.title = title;
  item.dataset.desc = desc;
  item.dataset.time = now;
  item.dataset.type = type;
  
  let circleClass = 'notif-circle-success';
  let icon = '✓';
  if (type === 'danger') {
    circleClass = 'notif-circle-danger';
    icon = '✕';
  } else if (type === 'warning') {
    circleClass = 'notif-circle-warning';
    icon = '⚠️';
  }
  
  if (!timestampStr) {
    timestampStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  item.dataset.timestamp = timestampStr;
  
  item.innerHTML = `
    <div class="notif-circle-icon ${circleClass}">${icon}</div>
    <div style="flex: 1;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 11.5px; font-weight: 600; color: #fff;">${title}</span>
        <span style="font-size: 9px; color: var(--text-muted);">${timestampStr}</span>
      </div>
      <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px; line-height: 1.35;">${desc}</div>
    </div>
    <span class="btn-close-notif" style="position: absolute; right: 8px; top: 8px; font-size: 9px; color: var(--text-muted); cursor: pointer; display: none; padding: 4px; line-height: 1;">✕</span>
  `;
  
  // Show close button on hover
  item.addEventListener('mouseenter', () => {
    const btn = item.querySelector('.btn-close-notif');
    if (btn) btn.style.display = 'block';
  });
  item.addEventListener('mouseleave', () => {
    const btn = item.querySelector('.btn-close-notif');
    if (btn) btn.style.display = 'none';
  });
  
  const closeBtn = item.querySelector('.btn-close-notif');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      item.remove();
      updateSavedNotificationsFromDOM();
      updateNotifBadgeCount();
      if (finalContainer.children.length === 0) {
        finalContainer.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 15px; font-size: 10px;">No alerts or notifications yet.</div>';
      }
    });
  }
  
  // Prepend to top
  finalContainer.insertBefore(item, finalContainer.firstChild);
  
  // Keep max 15 notifications
  while (finalContainer.children.length > 15) {
    finalContainer.removeChild(finalContainer.lastChild);
  }
  
  // Save changes to localStorage
  if (!preventSave) {
    updateSavedNotificationsFromDOM();
    updateNotifBadgeCount();
    window.showToastNotification(type, title, desc, timestampStr);
  }
};

window.showToastNotification = function(type, title, desc, timestampStr) {
  const toastContainer = document.getElementById('toast-container');
  if (!toastContainer) return;
  
  const toast = document.createElement('div');
  toast.className = 'toast-item';
  toast.style.cssText = `
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    padding: 10px 14px;
    width: 280px;
    pointer-events: auto;
    transform: translateX(120%);
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s;
    opacity: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
    overflow: hidden;
  `;
  
  let borderLeftColor = 'var(--accent-success)';
  let icon = '✓';
  let iconColor = 'var(--accent-success)';
  
  if (type === 'danger') {
    borderLeftColor = 'var(--accent-alert)';
    icon = '✕';
    iconColor = 'var(--accent-alert)';
  } else if (type === 'warning') {
    borderLeftColor = 'var(--accent-primary)';
    icon = '⚠️';
    iconColor = 'var(--accent-primary)';
  }
  
  toast.style.borderLeft = `4px solid ${borderLeftColor}`;
  toast.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 11px; color: ${iconColor};">
        <span>${icon}</span>
        <span>${title}</span>
      </div>
      <span style="font-size: 8px; color: var(--text-muted);">${timestampStr || 'Now'}</span>
    </div>
    <div style="font-size: 10px; color: var(--text-main); line-height: 1.35; margin-top: 2px;">${desc}</div>
    <span class="btn-close-toast" style="position: absolute; top: 6px; right: 8px; font-size: 8.5px; color: var(--text-muted); cursor: pointer; font-weight: bold; line-height: 1;">✕</span>
  `;
  
  const closeBtn = toast.querySelector('.btn-close-toast');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    });
  }
  
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(0)';
    toast.style.opacity = '1';
  });
  
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 300);
    }
  }, 6000);
};

window.initNotificationsCenter = function() {
  const container = document.getElementById('notifications-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  let saved = null;
  try {
    const data = localStorage.getItem('jda_notifications');
    saved = data ? JSON.parse(data) : null;
  } catch (e) {
    console.error('Failed to parse saved notifications:', e);
  }
  
  if (saved && Array.isArray(saved) && saved.length > 0) {
    // Recreate notifications (oldest first, so newer ones get prepended to the top)
    for (let i = saved.length - 1; i >= 0; i--) {
      const n = saved[i];
      window.addNotification(n.type, n.title, n.desc, n.timestamp, true);
    }
  } else {
    container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 15px; font-size: 10px;">No alerts or notifications yet.</div>';
  }
  
  updateNotifBadgeCount();
};

function updateSavedNotificationsFromDOM() {
  const container = document.getElementById('notifications-list');
  if (!container) return;
  
  const notifs = [];
  Array.from(container.children).forEach(el => {
    if (el.classList.contains('notif-item')) {
      notifs.push({
        type: el.dataset.type,
        title: el.dataset.title,
        desc: el.dataset.desc,
        timestamp: el.dataset.timestamp
      });
    }
  });
  localStorage.setItem('jda_notifications', JSON.stringify(notifs));
}

function updateNotifBadgeCount() {
  const container = document.getElementById('notifications-list');
  const badge = document.getElementById('notif-badge');
  if (!container || !badge) return;
  
  const count = Array.from(container.children).filter(el => el.classList.contains('notif-item')).length;
  if (count > 0) {
    badge.innerText = count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function initSharedNotifications() {
  // If already injected, don't duplicate
  if (document.getElementById('btn-bell-toggle')) return;
  
  const topBarControls = document.querySelector('.top-bar-controls');
  if (!topBarControls) return;
  
  // Inject toast container if missing
  if (!document.getElementById('toast-container')) {
    const tContainer = document.createElement('div');
    tContainer.id = 'toast-container';
    tContainer.style.cssText = 'position: fixed; top: 60px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none;';
    document.body.appendChild(tContainer);
  }
  
  // Inject bell container
  const bellContainer = document.createElement('div');
  bellContainer.className = 'notification-bell-container';
  bellContainer.innerHTML = `
    <button id="btn-bell-toggle" style="background: none; border: none; color: var(--text-muted); cursor: pointer; position: relative; padding: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s;" title="Alerts & Notifications">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
      </svg>
      <span id="notif-badge" style="display: none; position: absolute; top: -2px; right: -2px; background: var(--accent-alert); color: #fff; font-size: 8px; font-weight: bold; border-radius: 50%; width: 14px; height: 14px; align-items: center; justify-content: center; border: 1.5px solid var(--bg-primary);">0</span>
    </button>
    <!-- Dropdown Notifications Menu -->
    <div id="bell-dropdown" style="display: none; position: absolute; top: 38px; right: 0; width: 340px; background: var(--bg-surface); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); z-index: 1100; flex-direction: column; overflow: hidden; background-color: rgba(30, 34, 45, 0.95); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); background: rgba(255,255,255,0.01);">
        <span style="font-size: 13px; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 8px;">🔔 Notifications</span>
        <span style="font-size: 10px; color: var(--text-muted); cursor: pointer; font-weight: 500; text-transform: uppercase; transition: color 0.2s;" id="btn-clear-notifications">Clear All</span>
      </div>
      <div id="notifications-list" style="display: flex; flex-direction: column; gap: 6px; overflow-y: auto; max-height: 290px; padding: 12px;">
        <!-- Loaded dynamically -->
      </div>
      <div style="padding: 12px; border-top: 1px solid rgba(255, 255, 255, 0.06); display: flex; justify-content: center; background: rgba(0,0,0,0.15);">
        <button id="btn-clear-notifications-footer" style="width: 100%; border: 1px solid var(--border-color); background: transparent; padding: 8px 16px; border-radius: 6px; color: var(--text-main); font-weight: 500; font-size: 11px; text-align: center; cursor: pointer; transition: all 0.2s; border: 1px solid rgba(255,255,255,0.12);" onmouseover="this.style.background='rgba(255,255,255,0.06)'; this.style.borderColor='rgba(255,255,255,0.2)';" onmouseout="this.style.background='transparent'; this.style.borderColor='rgba(255,255,255,0.12)';">
          Clear All Notifications
        </button>
      </div>
    </div>
  </div>
  `;
  
  // Append to top bar controls
  topBarControls.appendChild(bellContainer);
  
  // Wire toggle and clear actions
  const btnBellToggle = document.getElementById('btn-bell-toggle');
  const bellDropdown = document.getElementById('bell-dropdown');
  const btnClearNotifications = document.getElementById('btn-clear-notifications');
  const btnClearNotificationsFooter = document.getElementById('btn-clear-notifications-footer');
  
  if (btnBellToggle && bellDropdown) {
    btnBellToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = window.getComputedStyle(bellDropdown).display !== 'none';
      if (isVisible) {
        bellDropdown.style.display = 'none';
      } else {
        bellDropdown.style.display = 'flex';
        // Hide badge when opened
        const badge = document.getElementById('notif-badge');
        if (badge) badge.style.display = 'none';
      }
    });
    
    document.addEventListener('click', (e) => {
      if (!bellDropdown.contains(e.target) && e.target !== btnBellToggle && !btnBellToggle.contains(e.target)) {
        bellDropdown.style.display = 'none';
      }
    });
  }
  
  const handleClearAll = () => {
    const list = document.getElementById('notifications-list');
    if (list) {
      list.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 15px; font-size: 10px;">No alerts or notifications yet.</div>';
    }
    localStorage.removeItem('jda_notifications');
    updateNotifBadgeCount();
  };
  
  if (btnClearNotifications) btnClearNotifications.addEventListener('click', handleClearAll);
  if (btnClearNotificationsFooter) btnClearNotificationsFooter.addEventListener('click', handleClearAll);
  
  // Pre-populate notifications
  window.initNotificationsCenter();
  
  // Listen to storage changes from other tabs to sync in real-time
  window.addEventListener('storage', (e) => {
    if (e.key === 'jda_notifications') {
      window.initNotificationsCenter();
    }
  });
}
