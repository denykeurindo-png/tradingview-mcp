with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

old_nav = "  await cdp('Runtime.enable');\n\n  // Click \"3 day\" period on the CoinGlass heatmap page"

new_nav = """  await cdp('Runtime.enable');
  await cdp('Page.enable');

  // Navigate to LiquidationHeatMap (tab may be on ETF page due to restoration)
  const curUrl = await cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  if (!curUrl?.result?.value?.includes('LiquidationHeatMap')) {
    console.log('[Heatmap3D] Navigating to LiquidationHeatMap for period selection...');
    await cdp('Page.navigate', { url: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap' });
    await new Promise(r => setTimeout(r, 6000)); // wait for React render
  } else {
    await new Promise(r => setTimeout(r, 1000));
  }

  // Click "3 day" period on the CoinGlass heatmap page"""

cnt = src.count(old_nav)
src = src.replace(old_nav, new_nav, 1)
print('nav added:', cnt)

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)
print('done')
