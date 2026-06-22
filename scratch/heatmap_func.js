// ─── Liquidation Pool Tables ────────────────────────────────
function renderLiquidationTables(data) {
  const aboveContainer = document.getElementById('above-chart-container');
  const belowContainer = document.getElementById('below-chart-container');
  if (!aboveContainer || !belowContainer) return;

  if (!data || !data.series) { aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return; }

  const heatmapSeries = data.series.find(s => s.type === 'heatmap');
  const candlestickSeries = data.series.find(s => s.type === 'candlestick');

  if (!heatmapSeries || !heatmapSeries.data || heatmapSeries.data.length === 0) {
    aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return;
  }

  let currentPrice = null;
  if (candlestickSeries && candlestickSeries.data && candlestickSeries.data.length > 0) {
    const lastCandle = candlestickSeries.data[candlestickSeries.data.length - 1];
    currentPrice = parseFloat(lastCandle[1]);
  }
  if (!currentPrice) { aboveContainer.innerHTML = ''; belowContainer.innerHTML = ''; return; }

  let maxHigh = currentPrice, minLow = currentPrice;
  if (candlestickSeries && candlestickSeries.data) {
    candlestickSeries.data.forEach(c => {
      const low = parseFloat(c[2]), high = parseFloat(c[3]);
      if (!isNaN(high) && high > maxHigh) maxHigh = high;
      if (!isNaN(low) && low < minLow) minLow = low;
    });
  }

  const yAxisData = data.yAxis || [];
  const leveragePerY = {};
  heatmapSeries.data.forEach(item => {
    const yIdx = item[1];
    const val = parseFloat(item[2] || 0);
    leveragePerY[yIdx] = (leveragePerY[yIdx] || 0) + val;
  });

  const levels = [];
  Object.keys(leveragePerY).forEach(yIdxStr => {
    const yIdx = parseInt(yIdxStr, 10);
    const priceStr = yAxisData[yIdx];
    if (!priceStr) return;
    const price = parseFloat(priceStr);
    const leverage = leveragePerY[yIdx];
    const distancePercent = ((price - currentPrice) / currentPrice) * 100;
    const isAbove = price > currentPrice;
    const isLiquidated = isAbove ? (price <= maxHigh) : (price >= minLow);
    levels.push({ price, leverage, distance: distancePercent, isAbove, isLiquidated });
  });

  const aboveLevels = levels.filter(l => l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5).sort((a, b) => a.price - b.price);
  const belowLevels = levels.filter(l => !l.isAbove).sort((a, b) => b.leverage - a.leverage).slice(0, 5).sort((a, b) => b.price - a.price);
  const maxLeverage = Math.max(...levels.map(l => l.leverage), 1);

  const renderTableHtml = (pools, isAbove) => {
    const totalActive = pools.reduce((sum, lvl) => sum + (lvl.isLiquidated ? 0 : lvl.leverage), 0);
    const totalActiveBs = totalActive * EXCHANGE_RATE;

    if (pools.length === 0) return '<div class="liq-table-container ' + (isAbove ? 'above' : 'below') + '">'
      + '<h4>' + (isAbove ? '▲ Resistance Liquidation Pools (Above Price)' : '▼ Support Liquidation Pools (Below Price)') + '</h4>'
      + '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">No significant liquidation pools detected.</div></div>';

    let html = '<div class="liq-table-container ' + (isAbove ? 'above' : 'below') + '">';
    html += '<h4>' + (isAbove ? '▲ Top Resistance Liquidation Pools' : '▼ Top Support Liquidation Pools')
      + ' — Current: ' + formatUSD(currentPrice) + ' | Active: $' + formatIntensity(totalActive) + ' / Bs. ' + formatIntensity(totalActiveBs) + '</h4>';
    html += '<table class="liq-data-table"><thead><tr>'
      + '<th>Rank</th><th>Price (USD)</th><th>Price (Bs.)</th>'
      + '<th>Pool Vol (USD)</th><th>Pool Vol (Bs.)</th><th>Distance</th><th>Intensity</th>'
      + '</tr></thead><tbody>';

    pools.forEach((lvl, idx) => {
      const ratio = lvl.leverage / maxLeverage;
      let badgeClass = 'low', badgeLabel = 'Low';
      if (lvl.isLiquidated) { badgeClass = 'liquidated'; badgeLabel = 'Liquidated'; }
      else if (ratio >= 0.7) { badgeClass = 'high'; badgeLabel = 'High'; }
      else if (ratio >= 0.3) { badgeClass = 'medium'; badgeLabel = 'Medium'; }

      let cellStyle = 'font-size:13px;font-weight:500;';
      if (lvl.isLiquidated) cellStyle = 'font-size:11px;font-weight:400;';
      else if (badgeClass === 'high') cellStyle = 'font-size:15.5px;font-weight:700;';
      else if (badgeClass === 'medium') cellStyle = 'font-size:13.5px;font-weight:600;';

      const distSign = lvl.distance > 0 ? '+' : '';
      const volBs = lvl.leverage * EXCHANGE_RATE;
      const isLiq = lvl.isLiquidated;
      const rowOpacity = isLiq ? ' style="opacity:0.45;"' : '';
      const priceColor = isLiq ? 'var(--text-muted)' : '#FFFFFF';
      const volColor = isLiq ? 'var(--text-muted)' : (isAbove ? '#bfdc21' : '#3ab56e');
      const distColor = isLiq ? 'var(--text-muted)' : (isAbove ? '#FF453A' : '#32D74B');
      const quickBtns = isLiq ? '' : '<span class="quick-set-btn entry-set" onclick="setPlannerPrice(\'entry\',' + lvl.price + ')">E</span>'
        + '<span class="quick-set-btn tp-set" onclick="setPlannerPrice(\'tp\',' + lvl.price + ')">TP</span>';

      html += '<tr' + rowOpacity + '>'
        + '<td style="color:var(--text-muted);' + cellStyle + '">#' + (idx+1) + '</td>'
        + '<td class="mono" style="font-weight:600;color:' + priceColor + ';' + cellStyle + '">$' + lvl.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + quickBtns + '</td>'
        + '<td class="mono" style="color:var(--text-muted);' + cellStyle + '">Bs. ' + (lvl.price*EXCHANGE_RATE).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + '</td>'
        + '<td class="mono intensity-cell" style="color:' + volColor + ';' + cellStyle + '">$' + formatIntensity(lvl.leverage) + '</td>'
        + '<td class="mono" style="color:var(--text-muted);' + cellStyle + '">Bs. ' + formatIntensity(volBs) + '</td>'
        + '<td class="mono" style="color:' + distColor + ';' + cellStyle + '">' + distSign + lvl.distance.toFixed(2) + '%</td>'
        + '<td style="' + cellStyle + '"><span class="intensity-badge ' + badgeClass + '">' + badgeLabel + '</span></td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  };

  aboveContainer.innerHTML = renderTableHtml(aboveLevels, true);
  belowContainer.innerHTML = renderTableHtml(belowLevels, false);
}

