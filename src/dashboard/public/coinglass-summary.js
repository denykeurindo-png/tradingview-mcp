document.addEventListener('DOMContentLoaded', () => {
  const summaryVerdict = document.getElementById('summary-verdict');
  const summaryContent = document.getElementById('summary-content');
  const summaryGrid = document.getElementById('summary-metrics-grid');
  const wallsContainer = document.getElementById('summary-walls-container');
  const btnRefresh = document.getElementById('btn-refresh');

  async function fetchSummary() {
    try {
      summaryContent.innerHTML = 'Mengambil analisis data dari seluruh laporan CoinGlass...';
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
      } else if (res.verdict.includes('BULLISH')) {
        badgeBg = 'rgba(14, 203, 129, 0.15)';
        badgeColor = '#0ECB81';
      } else if (res.verdict.includes('STRONG BEARISH')) {
        badgeBg = 'rgba(246, 70, 93, 0.2)';
        badgeColor = '#F6465D';
      } else if (res.verdict.includes('BEARISH')) {
        badgeBg = 'rgba(246, 70, 93, 0.15)';
        badgeColor = '#F6465D';
      } else {
        badgeBg = 'rgba(240, 185, 11, 0.15)';
        badgeColor = '#F0B90B';
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
        <div class="metric-card">
          <div class="metric-header">Depth Delta</div>
          <div class="metric-value" style="color: ${getSentimentColor(m.depthDelta?.sentiment)};">
            ${getSentimentIcon(m.depthDelta?.sentiment)} ${m.depthDelta?.formatted || '--'}
          </div>
          <div class="metric-desc">${m.depthDelta?.description || ''}</div>
        </div>
        <div class="metric-card">
          <div class="metric-header">Coinbase Premium</div>
          <div class="metric-value" style="color: ${getSentimentColor(m.coinbasePremium?.sentiment)};">
            ${getSentimentIcon(m.coinbasePremium?.sentiment)} ${m.coinbasePremium?.formatted || '--'}
          </div>
          <div class="metric-desc">${m.coinbasePremium?.description || ''}</div>
        </div>
        <div class="metric-card">
          <div class="metric-header">Whale Orders</div>
          <div class="metric-value" style="color: ${getSentimentColor(m.whaleOrders?.sentiment)};">
            ${getSentimentIcon(m.whaleOrders?.sentiment)} ${m.whaleOrders?.sentiment === 'bullish' ? 'BUY BIAS' : (m.whaleOrders?.sentiment === 'bearish' ? 'SELL BIAS' : '--')}
          </div>
          <div class="metric-desc">${m.whaleOrders?.description || 'Tidak ada data'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-header">Whale vs Retail</div>
          <div class="metric-value" style="color: ${getSentimentColor(m.whaleRetail?.sentiment)};">
            ${getSentimentIcon(m.whaleRetail?.sentiment)} ${m.whaleRetail?.formatted || '--'}
          </div>
          <div class="metric-desc">${m.whaleRetail?.description || ''}</div>
        </div>
        <div class="metric-card">
          <div class="metric-header">Top Trader L/S</div>
          <div class="metric-value" style="color: ${getSentimentColor(m.topTraderLs?.sentiment)};">
            ${getSentimentIcon(m.topTraderLs?.sentiment)} ${m.topTraderLs?.formatted || '--'}
          </div>
          <div class="metric-desc">${m.topTraderLs?.description || ''}</div>
        </div>
        <div class="metric-card">
          <div class="metric-header">Combined Depth</div>
          <div class="metric-value" style="color: ${getSentimentColor(m.combinedDepth?.sentiment)};">
            ${getSentimentIcon(m.combinedDepth?.sentiment)} ${m.combinedDepth?.formatted || '--'}
          </div>
          <div class="metric-desc">${m.combinedDepth?.description || ''}</div>
        </div>
      `;

      // Populate Top Walls & Whales
      if (wallsContainer && m) {
        const topBids = m.topWalls?.bids || [];
        const topAsks = m.topWalls?.asks || [];
        const whaleBids = m.whaleOrders?.top3Buy || [];
        const whaleAsks = m.whaleOrders?.top3Sell || [];
        
        if (topBids.length > 0 || topAsks.length > 0 || whaleBids.length > 0 || whaleAsks.length > 0) {
          const renderWallItem = (wall, isBid) => {
            const color = isBid ? '#0ECB81' : '#F6465D';
            return `
              <div style="display: flex; justify-content: space-between; font-size: 12px; background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); border-radius: 4px; padding: 6px 10px; font-family: 'JetBrains Mono', monospace;">
                <span style="color: ${color}; font-weight: 700;">$${Math.round(wall.price).toLocaleString()}</span>
                <span style="color: #EAECEF; font-weight: 600;">${parseFloat(wall.quantity).toFixed(2)} BTC</span>
              </div>
            `;
          };

          const renderWhaleItem = (order, isBuy) => {
            const color = isBuy ? '#0ECB81' : '#F6465D';
            return `
              <div style="display: flex; justify-content: space-between; font-size: 12px; background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); border-radius: 4px; padding: 6px 10px; font-family: 'JetBrains Mono', monospace;">
                <span style="color: ${color}; font-weight: 700;">$${parseFloat(order.price).toLocaleString()}</span>
                <span style="color: #EAECEF; font-weight: 600;">${order.valueUsdFormatted} <span style="font-size: 10px; color: #848E9C; font-weight: normal;">(${order.exchange})</span></span>
              </div>
            `;
          };

          const bidsHtml = topBids.map(b => renderWallItem(b, true)).join('');
          const asksHtml = topAsks.map(a => renderWallItem(a, false)).join('');
          
          const whaleBidsHtml = whaleBids.map(b => renderWhaleItem(b, true)).join('');
          const whaleAsksHtml = whaleAsks.map(a => renderWhaleItem(a, false)).join('');

          wallsContainer.innerHTML = `
            <!-- Orderbook Walls section -->
            <div style="font-size: 12px; color: #848E9C; font-weight: 600; text-transform: uppercase; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #F0B90B;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
              3 Permintaan Terbesar di Orderbook (Bids vs Asks)
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
              <div>
                <div style="font-size: 10px; color: #0ECB81; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px;">🟢 DINDING BELI (BID WALLS)</div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  ${bidsHtml || '<div style="color:#848E9C;font-size:11px;">Tidak ada data</div>'}
                </div>
              </div>
              <div>
                <div style="font-size: 10px; color: #F6465D; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px;">🔴 DINDING JUAL (ASK WALLS)</div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  ${asksHtml || '<div style="color:#848E9C;font-size:11px;">Tidak ada data</div>'}
                </div>
              </div>
            </div>

            <!-- Whale Orders section -->
            <div style="font-size: 12px; color: #848E9C; font-weight: 600; text-transform: uppercase; margin-top: 15px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 15px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #F0B90B;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
              3 Whale Orders Terbesar (Beli vs Jual)
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div>
                <div style="font-size: 10px; color: #0ECB81; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px;">🟢 WHALE BUY (BIDS)</div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  ${whaleBidsHtml || '<div style="color:#848E9C;font-size:11px;">Tidak ada data</div>'}
                </div>
              </div>
              <div>
                <div style="font-size: 10px; color: #F6465D; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px;">🔴 WHALE SELL (ASKS)</div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  ${whaleAsksHtml || '<div style="color:#848E9C;font-size:11px;">Tidak ada data</div>'}
                </div>
              </div>
            </div>
          `;
          wallsContainer.style.display = 'block';
        } else {
          wallsContainer.style.display = 'none';
        }
      }
    } catch (err) {
      console.error('Error fetching market summary:', err);
      summaryContent.innerHTML = `<span style="color: #F6465D;">Gagal memuat ringkasan pasar: ${err.message}</span>`;
    }
  }

  // Event listener for Refresh
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.disabled = true;
      const originalText = btnRefresh.innerHTML;
      btnRefresh.innerHTML = 'Scraping & Syncing...';
      try {
        const forceRes = await fetch('/api/coinglass-tv?refresh=true');
        if (!forceRes.ok) throw new Error(`Server Scraper status ${forceRes.status}`);
        await fetchSummary();
      } catch (err) {
        console.error('Refresh failed:', err);
        alert('Gagal sinkronisasi data scraper: ' + err.message);
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.innerHTML = originalText;
      }
    });
  }

  // Initial Fetch
  fetchSummary();
});
