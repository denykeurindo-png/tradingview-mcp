with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.js', 'r') as f:
    js = f.read()

# 1. Remove " / Bs. XXX" from header h4
js = js.replace(
    " + ' / Bs. ' + formatIntensity(totalActiveBs) + '</h4>';",
    " + '</h4>';"
)

# 2. Remove Price (Bs.) from thead
js = js.replace(
    "<th>Price (Bs.)</th>'",
    "'"
)

# 3. Remove Pool Vol (Bs.) from thead
js = js.replace(
    "<th>Pool Vol (Bs.)</th>",
    ""
)

# 4. Remove Price (Bs.) td from tbody
js = js.replace(
    "        + '<td class=\"mono\" style=\"color:var(--text-muted);' + cellStyle + '\">Bs. ' + (lvl.price*EXCHANGE_RATE).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + '</td>'\n",
    ""
)

# 5. Remove Pool Vol (Bs.) td from tbody
js = js.replace(
    "        + '<td class=\"mono\" style=\"color:var(--text-muted);' + cellStyle + '\">Bs. ' + formatIntensity(volBs) + '</td>'\n",
    ""
)

with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.js', 'w') as f:
    f.write(js)

gone1 = 'Price (Bs.)' not in js
gone2 = 'Pool Vol (Bs.)' not in js
print('Price Bs removed:', gone1, '| Pool Vol Bs removed:', gone2)
