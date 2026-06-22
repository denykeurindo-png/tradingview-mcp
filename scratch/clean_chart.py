import re

with open('/home/binance/tradingview-mcp/src/dashboard/public/raw-data.js', 'r') as f:
    js = f.read()

js = js.replace('let jdaChart = null;\n\n', '')
js = re.sub(r'function renderVZOChart\(data1h\) \{.*?\n\}\n', '', js, flags=re.DOTALL)
js = js.replace("\n    // Render VZO chart (1H)\n    renderVZOChart(tfs['1h']);\n", '')
js = js.replace("  window.addEventListener('resize', () => jdaChart && jdaChart.resize());\n", '')

with open('/home/binance/tradingview-mcp/src/dashboard/public/raw-data.js', 'w') as f:
    f.write(js)
print('js cleaned ok')
