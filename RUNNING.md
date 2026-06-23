# Running the App — Step by Step

## Dashboard Server

Express server on **port 4000** (`src/dashboard/server.js`).

**Recommended (PM2):** Run in the background. Using the config file prevents duplicate entries:
```powershell
# Start the service (uses pm2.config.json, prevents duplicates)
pm2 start pm2.config.json
```

To manage the background process under **PM2**:
```powershell
# Check status
pm2 status

# Check logs
pm2 logs tv-monitor

# Restart it (safe, does not create duplicates)
pm2 restart tv-monitor

# Stop it
pm2 stop tv-monitor
```

**Alternative (Foreground):** Run in the active terminal (will close if the terminal is shut down):
```powershell
npm run dashboard
```

### Step 2 — Verify the login page loads

```powershell
Invoke-WebRequest -Uri "http://localhost:4000/login" -UseBasicParsing
# Expected: StatusCode 200
```

Or open in browser: http://localhost:4000

### Step 3 — Log in

Default credentials (configurable in `src/dashboard/settings.json`):

| Field    | Default     |
|----------|-------------|
| Username | `admin`     |
| Password | `admin123`  |

API smoke-test:

```powershell
$body = '{"username":"admin","password":"admin123"}'
Invoke-WebRequest -Uri "http://localhost:4000/auth/login" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
# Expected: {"ok":true}
```

### Stop the server

If using **PM2**:
```powershell
pm2 stop tv-monitor
```

If running in the **foreground**, simply press `Ctrl + C` in the active terminal.

---

## Chrome Browser (CDP Target)

The Dashboard and MCP server connect to Google Chrome via port `9222`. You can choose to run Chrome in either **GUI Mode (Visible)** or **Headless Mode (Hidden / Background)**.

### Option 1 — GUI Mode (Visible)

Use this when you want to see the browser window, monitor the pages in real-time, or perform logins manually.

**Recommended (Shortcut):**
Run this command from your terminal to launch Chrome automatically with all required tabs:
```powershell
npm run chrome
```

**Windows (PowerShell - Manual):**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\ChromeDebugProfile" "https://www.tradingview.com/chart/" "https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&period=24h" "https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&period=3d"
```

**Linux / VPS:**
```bash
chromium-browser --remote-debugging-port=9222 --disable-gpu --user-data-dir=/tmp/chromium-profile "https://www.tradingview.com/chart/" "https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC"
```

### Option 2 — Headless Mode (Hidden / Background)

Use this when running the application in the background (e.g. on a server or VPS) without showing any browser window on the screen.

> [!NOTE]
> Chrome's headless mode does not support launching multiple URLs directly from the command line (it throws a `Multiple targets are not supported` error). 
> Therefore, we launch Chrome with **only the TradingView URL**, and the dashboard server will automatically open and navigate the CoinGlass tabs in the background.

> [!IMPORTANT]
> To use headless mode, first run in GUI mode (Option 1) to log in to TradingView and CoinGlass so your session/cookies are saved in the profile folder (`--user-data-dir`).

**Windows (PowerShell - Runs hidden in background):**
```powershell
Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--headless=new", "--remote-debugging-port=9222", "--user-data-dir=C:\ChromeDebugProfile", "https://www.tradingview.com/chart/" -WindowStyle Hidden
```

**Linux / VPS (CLI / PM2):**
```bash
# Run directly in background
chromium-browser --headless=new --remote-debugging-port=9222 --disable-gpu --user-data-dir=/tmp/chromium-profile --window-size=1280,1024 "https://www.tradingview.com/chart/" &

# Or manage it via PM2
pm2 start "chromium-browser" --name "chrome-headless" -- --headless=new --remote-debugging-port=9222 --disable-gpu --user-data-dir=/tmp/chromium-profile --window-size=1280,1024 "https://www.tradingview.com/chart/"
```

---

## MCP Server

Stdio transport — invoked by Claude Code automatically, not run manually.

```powershell
node src/server.js
```

## CLI (`tv` commands)

```powershell
npm link          # install `tv` globally (one-time)
tv status         # verify CDP connection
tv quote          # current price
tv symbol AAPL    # change symbol
```

## Tests

```powershell
npm test               # e2e + pine_analyze (requires TradingView running)
npm run test:unit      # offline tests only (no TradingView needed)
npm run test:e2e       # full e2e suite
```
