with open('/home/binance/tradingview-mcp/src/dashboard/public/app.js', 'r') as f:
    js = f.read()

before = js.count("|| '')")
# The regex fix produced \' \' (escaped single quotes) inside template literals
# Replace: || \').includes  ->  || '').includes
js = js.replace("|| \\').includes", "|| '').includes")
after = js.count("|| '').includes")

with open('/home/binance/tradingview-mcp/src/dashboard/public/app.js', 'w') as f:
    f.write(js)
print('replacements made, after count:', after)
