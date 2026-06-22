with open('/home/binance/tradingview-mcp/src/dashboard/public/style.css', 'r') as f:
    css = f.read()

# Replace CSS variables with Binance theme
old_vars = """:root {
  /* Colors */
  --bg-primary: #121212;
  --bg-surface: #1E1E1E;
  --bg-card-hover: #252525;
  --border-color: #2C2C2E;
  --accent-primary: #00E5FF; /* Cyan */
  --accent-success: #32D74B; /* Lime Green */
  --accent-alert: #FF453A; /* Red */
  --accent-alert-bg: #3A1C1C; /* Dark Red */
  --text-main: #FFFFFF;
  --text-muted: #98989D;"""

new_vars = """:root {
  /* Binance Dark Theme */
  --bg-primary: #0B0E11;
  --bg-surface: #1E2026;
  --bg-card-hover: #252930;
  --border-color: #2B3139;
  --accent-primary: #F0B90B;    /* Binance Yellow */
  --accent-success: #0ECB81;    /* Binance Green */
  --accent-alert: #F6465D;      /* Binance Red */
  --accent-alert-bg: #2D1A1E;
  --text-main: #EAECEF;
  --text-muted: #848E9C;"""

cnt = css.count(old_vars)
css = css.replace(old_vars, new_vars, 1)
print('vars replaced:', cnt)

# Update border-radius to match Binance (more angular)
css = css.replace('  --border-radius: 16px;', '  --border-radius: 8px;')

# Update nav active tab color (yellow instead of cyan)
css = css.replace(
    '.nav-item.active {\n  color: var(--bg-primary);\n  background-color: var(--accent-primary);\n  font-weight: 600;\n  box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);\n}',
    '.nav-item.active {\n  color: #0B0E11;\n  background-color: var(--accent-primary);\n  font-weight: 600;\n  box-shadow: 0 0 8px rgba(240, 185, 11, 0.4);\n}'
)

# Update btn-primary hover glow
css = css.replace(
    'box-shadow: 0 0 10px rgba(0, 229, 255, 0.3);',
    'box-shadow: 0 0 10px rgba(240, 185, 11, 0.35);'
)

# Update status dot glow colors
css = css.replace(
    'box-shadow: 0 0 6px var(--accent-primary);',
    'box-shadow: 0 0 6px rgba(240, 185, 11, 0.7);'
)

# Update card hover border
css = css.replace(
    'border-color: rgba(0, 229, 255, 0.3);',
    'border-color: rgba(240, 185, 11, 0.3);'
)

# Update kpi icon cyan wrapper
css = css.replace(
    '.kpi-icon-wrapper.cyan {\n  background: rgba(0, 229, 255, 0.1);\n  color: var(--accent-primary);\n}',
    '.kpi-icon-wrapper.cyan {\n  background: rgba(240, 185, 11, 0.1);\n  color: var(--accent-primary);\n}'
)

# Update icon bolt color
css = css.replace(
    'color: var(--accent-primary);\n  filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.4));',
    'color: var(--accent-primary);\n  filter: drop-shadow(0 0 4px rgba(240, 185, 11, 0.4));'
)

# Update logo-subtitle color reference (stays var so it updates automatically)
# Update scrollbar thumb hover
css = css.replace(
    '.auto-toggle-btn.on {\n  background: rgba(50, 215, 75, 0.2);\n  color: #32D74B;\n  border: 1px solid rgba(50, 215, 75, 0.4);\n  box-shadow: 0 0 12px rgba(50, 215, 75, 0.2);\n}',
    '.auto-toggle-btn.on {\n  background: rgba(14, 203, 129, 0.2);\n  color: #0ECB81;\n  border: 1px solid rgba(14, 203, 129, 0.4);\n  box-shadow: 0 0 12px rgba(14, 203, 129, 0.2);\n}'
)

# Update planner header color
css = css.replace(
    '.planner-header h4 {\n  color: var(--accent-primary);\n  font-size: 14px;\n  font-weight: 600;\n}',
    '.planner-header h4 {\n  color: var(--accent-primary);\n  font-size: 14px;\n  font-weight: 600;\n}'
)

# Update backtest header color
css = css.replace(
    '.backtest-header h3 {\n  color: var(--accent-primary);\n  font-size: 14px;\n  font-weight: 600;\n}',
    '.backtest-header h3 {\n  color: var(--accent-primary);\n  font-size: 14px;\n  font-weight: 600;\n}'
)

with open('/home/binance/tradingview-mcp/src/dashboard/public/style.css', 'w') as f:
    f.write(css)
print('style.css updated with Binance theme')

# Also update heatmap.html overridden colors
with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.html', 'r') as f:
    html = f.read()

html = html.replace(
    """  <style>
    :root {
      --bg-primary: #060112;
      --bg-surface: #0d0221;
      --bg-card-hover: #160834;
      --border-color: #211448;
    }
  </style>""",
    """  <style>
    :root {
      --bg-primary: #0B0E11;
      --bg-surface: #161A1E;
      --bg-card-hover: #1E2329;
      --border-color: #2B3139;
    }
  </style>"""
)

with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.html', 'w') as f:
    f.write(html)
print('heatmap.html colors updated')
print('ALL DONE')
