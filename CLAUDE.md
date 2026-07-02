# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
# Dashboard (primary use)
npm run dashboard                  # start Express server on port 4000 (foreground)
pm2 start pm2.config.json          # start as pm2 process (name: tv-monitor)
pm2 restart tv-monitor             # restart (use this, not start again)

# Remote access: dashboard is reached from the phone over Tailscale (device joins
# the tailnet and hits this local instance at http://<tailscale-ip>:4000). There is
# no VPS anymore -- everything runs on the local scraping machine.

# Tests (Node built-in runner, no Jest)
npm run test:unit                  # offline only — pine_analyze + cli tests (29 tests)
npm run test:e2e                   # requires TradingView running + CDP on 9222
node --test tests/cli.test.js      # single file

# Chrome with CDP (required for heatmap scraping + MCP)
npm run chrome                     # Windows: PowerShell script opens Chrome + TradingView/CoinGlass tabs

# MCP server (stdio, invoked by Claude Code — not run manually)
node src/server.js

# Pine Script workflow
node scripts/pine_pull.js          # TradingView → scripts/current.pine
node scripts/pine_push.js          # scripts/current.pine → TradingView editor + compile

# CLI (after npm link)
tv status | tv quote | tv symbol BTCUSD
```

**No build step** — pure ES modules (`"type": "module"`), Node runs files directly.  
**No linter configured** — no eslint/prettier in devDependencies.

---

## Architecture

This repo has **three independent subsystems** sharing a codebase:

### 1. MCP Server (`src/server.js` + `src/tools/` + `src/core/`)

Bridges Claude Code ↔ TradingView Desktop via CDP:

```
Claude Code (MCP client)
    ↓ stdio transport
src/server.js               ← MCP server entry point
src/tools/*.js              ← thin wrappers: register tool, call core, return jsonResult()
src/core/*.js               ← business logic (chart.js, pine.js, data.js, replay.js, etc.)
src/connection.js           ← CDP singleton (evaluate, evaluateAsync, safeString, requireFinite)
src/wait.js                 ← waitForChartReady(): polls DOM for spinner + bar-count stability
    ↓
Chrome DevTools Protocol → TradingView Electron renderer
```

Key invariants:
- All tool handlers must wrap in try/catch and return `jsonResult(obj, isError)` from `src/tools/_format.js`
- All user strings injected into CDP expressions **must** go through `safeString()` to prevent JS injection
- Numeric inputs to TV APIs **must** pass `requireFinite(value, name)` before use
- `src/core/index.js` re-exports all core modules

**`_deps` injection pattern** — every `src/core/*.js` function accepts an optional `{ _deps }` parameter that overrides `evaluate`, `evaluateAsync`, `waitForChartReady`, etc. This is the sole mechanism for unit testing core functions without a live CDP connection. See `tests/sanitization.test.js` for the `mockDeps()` pattern.

### 2. CLI (`src/cli/`)

All 78 MCP tools are also accessible as a pipe-friendly `tv` CLI (after `npm link`):

```
src/cli/index.js            ← registers all command modules, calls router.run()
src/cli/router.js           ← parseArgs dispatcher, printHelp, exit codes
src/cli/commands/*.js       ← mirror of src/tools/*.js — same core functions, CLI interface
```

Exit codes: `0` success · `1` error · `2` CDP connection failure (tested by `tests/cli.test.js`).

### 2. Dashboard (`src/dashboard/server.js` + `src/dashboard/public/`)

Standalone Express app on port 4000 — no relationship to MCP server at runtime.

```
Browser clients
    ↓ HTTP + WebSocket
src/dashboard/server.js     ← all API routes + bot logic + scrapers (~7000 lines)
    ├── CDP (port 9222)      ← CoinGlass heatmap scraping (Chrome must be open)
    ├── Binance REST/WS      ← OI, klines, CVD, funding, LSR, liquidations
    └── Telegram Bot API     ← trade alerts

src/dashboard/public/       ← static frontend (vanilla JS, no framework)
    cockpit.html/js         ← LSR strategy pipeline cockpit (primary monitoring page)
    cockpit2.html/js        ← alternative reversal cockpit
    trades.html/js          ← trade journal + sweep history + backtest simulator
    heatmap.html/js         ← full liquidation heatmap
    [others]                ← orderbook, ETF, CoinGlass reports, settings, status
```

**Data files** (gitignored):
- `src/dashboard/settings.json` — all runtime config (capital, risk%, API keys, thresholds)
- `src/dashboard/trades.json` — flat trade log array
- `src/dashboard/sweep_history.json` — bot event log, max 200 entries

---

## Dashboard Server Deep Dive (`server.js`)

### CDP Mutex
All Chrome interactions (heatmap scraping) go through `runWithCdpLock()` — a promise-chain mutex with 2s post-release delay. Never call CDP outside this lock.

### VPS sync (removed)
The setup used to push scrape/bot results to a public VPS receiver so the dashboard
could be viewed remotely. That's gone — remote viewing is now done over Tailscale
against this local instance. `pushToVps()` is a no-op stub; the `/api/*/update` and
`/api/*/sync` receiver endpoints remain defined but are never called (inert). If a
remote mirror is ever reintroduced, re-wire the stub rather than each call site.

### LSR Bot Logic
`autoTradeStrategyBackend(heatmapData)` runs on every heatmap refresh (~3 min):

1. Extract top pools from 24H + 3D heatmap caches via `extractTopPoolsForServer()`
2. Detect nearest pool within `minDist`–`maxDist` range
3. **POOL_CHANGED detection**: compare with `lastTrackedPoolPrice`; if >0.2% shift, log reason (CONSUMED / RECALCULATED / REPLACED)
4. Detect sweep candles in last `sweepConfirmCandles` (3) candles: `cLow <= pool && cClose > pool` (LONG) or `cHigh >= pool && cClose < pool` (SHORT)
5. Skip if pool was already swept by older candles (15-candle historical window)
6. Score sweep via `calculateReversalProbability()` — 11 factors, 100-point scale
7. Apply hard filters: R:R ≥ `minRR`, prob ≥ `minReversalProbability`, CB Premium, HTF trend, anti-spoofing
8. Execute trade or log `SWEEP_REJECTED` with reason

After the function returns, `setBotPhaseState(botPhaseState, oldPhase)` is called explicitly to log to `sweep_history.json`.

### Probability Scoring (100-point)
`calculateReversalProbability(sweepDetail, oiChange15m, spotCvd15m, trend1h, trend4h, premiumRate, longShortRatio)`:

| Factor | Max pts | Logic |
|--------|---------|-------|
| Base | 40 | always |
| Pool volume | +15 | `vol/1e6 * 0.75` |
| Rejection strength | +15 | wick close-back ratio |
| OI change 15m | ±10 | OI drop = squeeze = bullish for LONG |
| Spot CVD 15m | +10 | spot buying during LONG |
| HTF trend 1h/4h | +10 | EMA50 alignment, 5pts each |
| CB Premium/funding | ±5 | premiumRate micro-sentiment |
| Coinbase Premium | +15/−10 | directional confirmation, penalty capped at −10 |
| Depth Delta 1% | ±15 | bid/ask orderbook imbalance |
| Whale wall | +5 | large order near sweep price |
| Liquidations | +10 | recent forced liq volume |

### Current Strategy Settings
```json
{
  "minReversalProbability": 65,
  "sweepConfirmCandles": 3,
  "minRR": 1.2,
  "minCoinbasePremiumForLongs": -0.15,
  "maxCoinbasePremiumForShorts": 0.05,
  "atrMultiplier": 3,
  "minSLPercent": 1.2,
  "maxTPPercent": 1.5,
  "cooldownMinutes": 30,
  "maxActive": 1
}
```

### Key API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/bot-status` | full bot phase, metrics, breakdown — primary polling endpoint |
| `GET /api/sweep-history` | last 200 bot events (STANDBY/ALERT/SWEEP_REJECTED/TRADE_EXECUTED/POOL_CHANGED/…) |
| `POST /api/sweep-history/clear` | clear event log |
| `GET /api/heatmap-data` | 24H liquidation heatmap (cached 3min) |
| `GET /api/heatmap-data-3d` | 3D liquidation heatmap |
| `GET /api/settings` / `POST /api/settings` | read/write runtime config |
| `POST /api/tradingview/webhook` | **public** — Pine Script alerts (buy/sell/cut) |

---

## cockpit.html Layout (LSR Strategy Pipeline)

Top → bottom:

1. **Hero Row** — BTC price · Phase badge (color-coded by state) · Reversal Prob · Nearest Pool price · Distance · System lights
2. **5-Stage Pipeline** — active stage glows gold, passed = green, rejected = red:
   - Stage 1: Pool Detection
   - Stage 2: Price Alert (< 0.5% from pool)
   - Stage 3: Sweep Detection (wick candle in 3-candle window)
   - Stage 4: Filter Gates (R:R / Prob / CB Premium / HTF Trend — live ✅/❌)
   - Stage 5: Trade Active
3. **Bot Message Bar** — current message + auto-trade toggle
4. **Heatmap Row** — 24H | 3D side by side (1fr / 1fr)
5. **Sweep Event Log** — collapsible, 9 cols: Time · Symbol · Side · Volume · **Pool Price** · Dist · Prob% · Phase · Decision

Pipeline updates every 15s from inline `pollPipeline()` → `GET /api/bot-status`.  
All removed widgets have hidden stubs in the DOM so cockpit.js getElementById calls don't throw.

---

## trades.html Tabs

- **Trade Journal** — live table, manual add/cut, auto-refresh 30s
- **Sweep History** — strategy review cards + rejection breakdown bars + event table (reads `/api/sweep-history`)
- **Backtest Simulator** — fetches Binance 15m klines directly from browser, simulates LSR on swing pivot levels, shows all events including SKIPPED with reason, "Import" button sends to `/api/trades/add`

---

## POOL_CHANGED Event

Logged to sweep history when `closestPool` changes by >0.2% between bot cycles. Four reasons:
- `CONSUMED — price passed pool` — price closed beyond old pool without valid sweep candle
- `CONSUMED — touched, no sweep` — old pool was inside a candle's wick range but wick+close condition not met
- `RECALCULATED — heatmap refresh` — same cluster, <0.5% shift from CoinGlass data update
- `REPLACED — new pool` — clearly different pool, old one left distance range

---

## Git & Deploy Workflow

Everything runs on the local machine now (no VPS). "Deploy" is just committing and
restarting the local pm2 process.

```bash
git add <files>
git commit -m "message"
git push origin main
pm2 restart tv-monitor      # apply changes to the running local dashboard

# Always mirror frontend changes to backup repo
cp src/dashboard/public/FILE C:/Gemini/TVMONITOR_GIT/src/dashboard/public/FILE
```

- Running workspace: `C:\Gemini\TvMonitor`
- Git backup repo: `C:\Gemini\TVMONITOR_GIT`
- `settings.json` and `sweep_history.json` are gitignored — never commit them
- Local pm2 process name: `tv-monitor`
