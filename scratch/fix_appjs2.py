with open('/home/binance/tradingview-mcp/src/dashboard/public/app.js', 'rb') as f:
    raw = f.read()

print('Before, occurrences of backslash-quote:', raw.count(b"\\'"))

# Replace \' with ' (remove backslashes before single quotes)
fixed = raw.replace(b"\\'", b"'")

print('After fix:', fixed.count(b"\\'"))

with open('/home/binance/tradingview-mcp/src/dashboard/public/app.js', 'wb') as f:
    f.write(fixed)

print('Done')
