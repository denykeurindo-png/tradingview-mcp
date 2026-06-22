with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.js', 'r') as f:
    js = f.read()

# Handle 409 silently - retry without showing Connection Error
old = "    if (!response.ok) {\n      const errData = await response.json();\n      throw new Error(errData.error || `HTTP error ${response.status}`);\n    }\n\n    const resObj = await response.json();\n    const result = resObj.data.data;"

new = """    if (!response.ok) {
      if (response.status === 409) {
        // Scrape in progress — silent retry, keep showing last data
        updateStatus('loading', 'Scraping...');
        scheduleRetry();
        btnRefresh.disabled = false;
        return;
      }
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'HTTP error ' + response.status);
    }

    const resObj = await response.json();
    const result = resObj.data.data;"""

cnt = js.count(old)
js = js.replace(old, new, 1)
print('409 fix:', cnt)

# Also fix load3DData to not throw on 503
old3d = "    if (heatRes.ok) {\n      const heatJson = await heatRes.json();\n      const data3d = heatJson.data?.data || heatJson.data;\n      if (data3d && data3d.series) {\n        renderLiquidationTables3D(data3d);\n        renderHeatmap3D(data3d);\n      }\n    }"

new3d = """    if (heatRes.ok) {
      const heatJson = await heatRes.json();
      const data3d = heatJson.data?.data || heatJson.data;
      if (data3d && data3d.series) {
        renderLiquidationTables3D(data3d);
        renderHeatmap3D(data3d);
      }
    } else if (heatRes.status === 503) {
      // 3D data not ready yet — silently wait
      console.log('[3D] Data not ready yet (503), will retry in 3 min');
    }"""

cnt2 = js.count(old3d)
js = js.replace(old3d, new3d, 1)
print('3D 503 fix:', cnt2)

with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.js', 'w') as f:
    f.write(js)
print('done')
