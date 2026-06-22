import re

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

# 1. Remove calculateRSI function
src = re.sub(
    r'\nfunction calculateRSI\(prices, period\) \{.*?\n\}\n',
    '\n',
    src, flags=re.DOTALL, count=1
)

# 2. Remove rsi usage inside analyzeTrend (keep the function, just remove rsi)
src = src.replace(
    '  const rsi = calculateRSI(prices, 14);\n\n',
    ''
)
src = src.replace(
    '  strength = rsi > 55 ? \'STRONG\' : \'MODERATE\';\n',
    '  strength = \'STRONG\';\n'
)
src = src.replace(
    '  strength = rsi < 45 ? \'STRONG\' : \'MODERATE\';\n',
    '  strength = \'STRONG\';\n'
)
# Remove rsi from analyzeTrend return
src = src.replace(
    '  return { trend, strength, ema20: Math.round(ema20), ema50: Math.round(ema50), rsi: Math.round(rsi), score };',
    '  return { trend, strength, ema20: Math.round(ema20), ema50: Math.round(ema50), score };'
)

# 3. Remove rsi from fetchBinanceHTFTrend return
src = src.replace(
    '      rsi1h: bias1h.rsi,\n      rsi4h: bias4h.rsi,\n',
    ''
)
src = src.replace(
    '    rsi1h: 50, rsi4h: 50, score1h: 0, score4h: 0',
    '    score1h: 0, score4h: 0'
)

# 4. Remove RSI from fetchJDASignal per-TF
src = src.replace(
    '    const closes_for_rsi = klines.map(k => parseFloat(k[4]));\n    const rsiVal = calculateRSI(closes_for_rsi, 14);\n    ',
    '    '
)
src = src.replace(
    '      rsi:          Math.round(rsiVal),\n',
    ''
)

# 5. Remove rsi from botMetrics initial state
src = src.replace(
    '  rsi1h: 50,\n  rsi4h: 50,\n',
    ''
)

# 6. Remove rsi from botMetrics update in runBotCycle
src = src.replace(
    '      rsi1h: jdaSig.timeframes[\'1h\']?.rsi || 50,\n      rsi4h: jdaSig.timeframes[\'4h\']?.rsi || 50,\n',
    ''
)

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)

print('server.js RSI removed')

# 7. Update raw-data.js footer — remove RSI from display
with open('/home/binance/tradingview-mcp/src/dashboard/public/raw-data.js', 'r') as f:
    js = f.read()

js = re.sub(
    r"      const rsi1h = .*?;\n      const rsi4h = .*?;\n      footHtfTrend\.innerText = .*?;",
    "      footHtfTrend.innerText = 'VZO+ZLEMA (JDA Engine)';",
    js, flags=re.DOTALL, count=1
)

with open('/home/binance/tradingview-mcp/src/dashboard/public/raw-data.js', 'w') as f:
    f.write(js)

print('raw-data.js RSI removed')
print('ALL DONE')
