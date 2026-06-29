# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# TradingView MCP — Claude Instructions

MCP server + CLI bridge between Claude Code and TradingView Desktop via Chrome DevTools Protocol (CDP on port 9222). Also includes a standalone web dashboard (`src/dashboard/`) for trade monitoring, signal automation, and CoinGlass data scraping.

## Commands

```bash
# Run the MCP server (stdio transport — invoked by Claude Code, not manually)
node src/server.js

# Dashboard server — Express on port 4000
npm run dashboard           # foreground
pm2 start pm2.config.json   # background (recommended); process name: tv-monitor
pm2 restart tv-monitor      # restart without creating duplicates

# Chrome browser with CDP (port 9222) — required for both MCP and dashboard
npm run chrome              # Windows GUI mode: launches Chrome with TradingView + CoinGlass tabs
# Headless mode (VPS/server):
# chromium-browser --headless=new --remote-debugging-port=9222 --disable-gpu --user-data-dir=/tmp/chromium-profile "https://www.tradingview.com/chart/"

# Signal bridge — reads Pine signals from local TradingView, POSTs to VPS dashboard
npm run bridge              # scripts/tv_signal_bridge.js

# Deploy dashboard to VPS via SSH
npm run deploy              # scripts/deploy_ssh.js

# CLI — every MCP tool is also a `tv` command
npm link          # install `tv` globally (one-time)
tv status         # verify CDP connection
tv quote          # current price
tv symbol AAPL    # change symbol

# Tests
npm test                    # e2e + pine_analyze (e2e requires TradingView running)
npm run test:unit           # offline tests only (no TradingView needed — 29 tests)
npm run test:e2e            # full e2e suite (TradingView must be running)
node --test tests/cli.test.js  # single file

# Pine Script file-based workflow
node scripts/pine_pull.js   # pull current TV script → scripts/current.pine
node scripts/pine_push.js   # push scripts/current.pine → TV editor + compile
```

## Code Architecture

### MCP / CLI Layer (Three-layer stack)

```
MCP Client / CLI
      ↓
src/tools/*.js          ← MCP tool registration (thin wrappers)
src/cli/commands/*.js   ← CLI command handlers
      ↓
src/core/*.js           ← Business logic (CDP JS string injection)
      ↓
src/connection.js       ← CDP singleton: evaluate(), evaluateAsync(), safeString()
      ↓
CDP localhost:9222       ← TradingView Desktop (Electron) or Chrome
```

**`src/connection.js`** — shared CDP connection singleton. Key exports:
- `evaluate(expr)` / `evaluateAsync(expr)` — run JS in TradingView's renderer
- `safeString(str)` — JSON.stringify-based escaping; always use for user-supplied strings in CDP expressions to prevent injection
- `requireFinite(value, name)` — validates numeric inputs before they reach TV APIs
- `KNOWN_PATHS` — hardcoded JS paths to internal TradingView API objects

**`src/tools/_format.js`** — `jsonResult(obj, isError)` — all tool files use this to build MCP responses.

**`src/wait.js`** — `waitForChartReady()` — polls DOM for loading spinner + bar count stability after chart changes.

### Dashboard Layer (`src/dashboard/`)

```
Browser / TradingView Alerts
      ↓
src/dashboard/server.js  ← Express on port 4000, all API routes + business logic
      ↓
CDP localhost:9222        ← Chrome tabs (TradingView chart, CoinGlass pages)
Binance public REST API   ← OI, klines, funding rate, long/short ratio
Telegram Bot API          ← alerts for all trade events
      ↓
src/dashboard/trades.json    ← trade log (flat JSON array, file-persisted)
src/dashboard/settings.json  ← runtime settings (capital, risk%, Telegram creds)
src/dashboard/public/        ← static frontend (index.html, heatmap.html, etc.)
```

**Authentication**: Session cookies (`jda_session`, 24h TTL) + HTTP Basic Auth fallback for API clients. Credentials stored in `settings.json` (`authUsername`/`authPassword`). Public paths: `/login`, `/auth/*`, `/api/tradingview/webhook`.

**CDP mutex** (`runWithCdpLock`): All Chrome interactions are serialized through a promise-chain mutex with a 2s post-release delay to prevent tab race conditions.

**CoinGlass scrapers** (in `server.js`): Three scrapers that navigate/reload Chrome tabs via CDP and poll the DOM until React-rendered data decrypts (up to 45s timeout each):
- `scrapeCoinGlass('/etf/bitcoin')` → BTC ETF flows (serves `/api/etf-data`, cached 1h)
- `scrapeHeatMap()` → Liquidation Heatmap 24h (serves `/api/heatmap-data`, cached 3min)
- `scrapeHeatMap3D()` → Liquidation Heatmap 3 day (serves `/api/heatmap-3d-data`); validates by time span ≥48h not bar count, falls back to click dropdown if needed

**Binance data** (polled periodically, stored in `botMetrics`):
- `fetchBinanceOI()` — open interest + 1h OI change (5m history, 13 candles)
- `fetchBinanceSpotCVD()` — cumulative delta of spot taker buy vs total (12 × 5m candles)
- `fetchBinanceHTFTrend()` — EMA50 trend on 1h and 4h charts (200+ candles)
- `fetchFundingRate()` / `fetchLongShortRatio()` — from Binance futures endpoints

**Trade engine**: All trades in `trades.json`. Key REST endpoints:
- `POST /api/tradingview/webhook` — public; accepts `action: buy|sell|cut` from Pine alerts; enforces `maxActive`, `minRR`, `minDist/maxDist` from settings
- `POST /api/trades/add` — manual trade entry
- `POST /api/trades/cut` — close active trade with PnL calculation
- `GET /api/settings` / `POST /api/settings` — update risk parameters live

**Signal bridge** (`scripts/tv_signal_bridge.js`): Runs locally, reads Pine Script signal values from TradingView via CDP every 5s, POSTs to the VPS dashboard at `http://103.55.37.239:4000`.

### Adding a New MCP Tool

1. Add business logic to `src/core/<module>.js`
2. Register the MCP tool in `src/tools/<module>.js` using `server.tool(name, desc, schema, handler)` — wrap in try/catch returning `jsonResult(..., true)` on error
3. Add a CLI command in `src/cli/commands/<module>.js`
4. Register the CLI command import in `src/cli/index.js`

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"

**Via MCP tools (in-session):**
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_save` → save to TradingView cloud

**Via file-based workflow (for longer scripts):**
1. `node scripts/pine_pull.js` → pull current script to `scripts/current.pine`
2. Edit `scripts/current.pine` locally
3. `node scripts/pine_push.js` → inject + compile

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)
- CDP JS expressions: always wrap user-supplied strings with `safeString()` from `connection.js`; validate numeric inputs with `requireFinite()`

## Skills (invoke with `/skill-name`)

Reusable workflows in `skills/`:
- `chart-analysis` — full chart read and report
- `pine-develop` — write → push → compile → fix loop
- `replay-practice` — step-through historical bar practice
- `strategy-report` — strategy tester results summary
- `multi-symbol-scan` — batch screenshot/data across symbols

## Web Dashboard Layout & Custom Features

### Spacing & Menu Layout
- Maintain a `24px` spacing/gap between the sidebar menu and content cards in `style.css`.
- Ensure no duplicate items exist in the sidebar navigation menu.

### cockpit.html — LSR Strategy Flow Cockpit (redesigned)
Full-page visual representation of the LSR strategy pipeline. Layout top → bottom:

1. **Hero Row** — BTC price (large) · Phase badge (color-coded) · Reversal Prob · Nearest Pool · Distance · System lights (CDP/WS/Fut/TG)
2. **5-Stage Pipeline** — visual flow with arrows, active stage glows:
   - Stage 1: Pool Detection (nearest pool price, distance, volume)
   - Stage 2: Price Alert (< 0.5% threshold)
   - Stage 3: Sweep Detection (wick candle + close reversal, 3-candle window)
   - Stage 4: Filter Gates (R:R ≥ 1.2 · Prob ≥ 65% · CB Premium · HTF Trend) — live ✅/❌
   - Stage 5: Trade Active (entry/TP/SL/RR, cooldown, max active)
3. **Bot Message Bar** — current bot message + auto-trade toggle
4. **Heatmap Row** — 24H Liquidity Sweep Map | 3D Liquidity Sweep Map (side by side, 1fr/1fr)
5. **Sweep Event Log** — full-width collapsible table (9 columns: Time · Symbol · Side · Volume · **Pool Price** · Dist · Prob% · Phase · Decision)

Pipeline stage CSS classes: `active` (gold glow + pulse) · `pass` (green) · `reject` (red) · `cooldown` (purple) · default (dimmed).

Pipeline is updated every 15s by inline `pollPipeline()` function fetching `/api/bot-status`.

### LSR Strategy Parameters (current)
Stored in `src/dashboard/settings.json` (gitignored — deploy via `node scripts/deploy_settings.js`):
- `minReversalProbability`: **65%** (was 70%)
- `sweepConfirmCandles`: **3** (was 5 — now 45-min lookback window)
- `minCoinbasePremiumForLongs`: **-0.15%** (was -0.05%)
- `maxCoinbasePremiumForShorts`: 0.05%
- CB Premium scoring penalty: capped at **-10** (was -20) to prevent single factor dominating

### LSR Probability Scoring (100-point system)
11 factors in `calculateReversalProbability()` in `server.js`:
1. Base: 40 pts
2. Pool Volume (0–15): `vol / 1e6 * 0.75`
3. Rejection Strength (0–15): wick close-back ratio
4. OI Change 15m (±10): OI drop during LONG sweep = squeeze = +10
5. Spot CVD 15m (±10): spot buying during LONG = +10
6. HTF Trend 1h/4h (0–10): EMA50 alignment, 5pts each
7. CB Premium / Funding Rate (±5 or +15): capped at -10 max penalty
8. Coinbase Premium Index (±10 or +15): direction confirmation
9. Depth Delta 1% (±15): orderbook bid/ask imbalance
10. Whale Wall (0–5): nearby large order
11. Liquidations (0–10): recent forced liq volume

### Sweep History Logging (`sweep_history.json`)
- Stored at `src/dashboard/sweep_history.json`, max 200 entries, newest first
- **Fix (2026-06-29)**: `setBotPhaseState(botPhaseState, oldPhase)` now called after `autoTradeStrategyBackend()` to ensure all phase transitions are logged
- Synced to VPS via `sweepHistory` field in `/api/bot-phase/update` push payload
- Phase types logged: `STANDBY · ALERT · SWEEP_DETECTED · SWEEP_REJECTED · TRADE_EXECUTED · COOLDOWN · MAX_ACTIVE · CONFLICTING_SWEEP · POOL_CHANGED · DISABLED`

### POOL_CHANGED Event (new)
Logged when `closestPool` changes by >0.2% between bot cycles. Four reason categories:
- **CONSUMED — price passed pool**: price crossed pool level, no sweep candle in window
- **CONSUMED — touched, no sweep**: pool within candle range but wick+close condition not met
- **RECALCULATED — heatmap refresh**: same cluster, level shifted <0.5% due to CoinGlass data update
- **REPLACED — new pool**: clearly different pool, old one left distance range (>0.2% shift)

Tracked via module-level `lastTrackedPoolPrice` / `lastTrackedPoolSide` in `server.js`.

### trades.html — Live Trade Journal (updated)
Now has 3 tabs:
- **Trade Journal** — live trade table with manual add + cut
- **Sweep History** — strategy review cards + rejection breakdown bars + event log table
- **Backtest Simulator** — fetch Binance 15m candles, simulate LSR on swing levels, import results to journal

### Deploy Settings to VPS
`settings.json` is gitignored (contains credentials). Use:
```bash
node scripts/deploy_settings.js   # SFTP upload + pm2 restart
```
Script reads SSH credentials from `scripts/deploy_ssh.js` automatically.

### Git Repositories Synchronization
- Running workspace: `C:\Gemini\TvMonitor`
- Git backup repository: `C:\Gemini\TVMONITOR_GIT`
- When modifying dashboard assets (`src/dashboard/public/*.html|js|css`), ensure changes are mirrored to both paths to prevent repository divergence.
- `settings.json` and `sweep_history.json` are gitignored — deploy separately via `deploy_settings.js`.
