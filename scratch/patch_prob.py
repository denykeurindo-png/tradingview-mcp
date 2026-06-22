files = [
    '/home/binance/tradingview-mcp/src/dashboard/public/index.html',
    '/home/binance/tradingview-mcp/src/dashboard/public/app.js',
    '/home/binance/tradingview-mcp/src/dashboard/public/raw-data.html',
    '/home/binance/tradingview-mcp/src/dashboard/public/raw-data.js',
]

replacements = [
    ('#00E5FF', '#F0B90B'),
    ('#00e5ff', '#F0B90B'),
    ('#13fed9', '#F0B90B'),
    ('#13FED9', '#F0B90B'),
    ('rgba(0, 229, 255, 0.4)', 'rgba(240, 185, 11, 0.4)'),
    ('rgba(0, 229, 255, 0)', 'rgba(240, 185, 11, 0)'),
    ('rgba(0,229,255', 'rgba(240,185,11'),
    ('#32D74B', '#0ECB81'),
    ('#32d74b', '#0ECB81'),
    ('#FF453A', '#F6465D'),
    ('#ff453a', '#F6465D'),
    ('#f23744', '#F6465D'),
    ('#F23744', '#F6465D'),
]

for fpath in files:
    with open(fpath, 'r') as f:
        content = f.read()
    changed = 0
    for old, new in replacements:
        count = content.count(old)
        if count:
            content = content.replace(old, new)
            changed += count
    with open(fpath, 'w') as f:
        f.write(content)
    name = fpath.split('/')[-1]
    print('Updated ' + name + ': ' + str(changed) + ' replacements')

print('ALL DONE')
