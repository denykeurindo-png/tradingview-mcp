# Running the App — Step by Step

## Dashboard Server

Express server on **port 4000** (`src/dashboard/server.js`).

### Step 1 — Start the server

**Recommended (PM2):** Run in the background so you can close the terminal window:
```powershell
pm2 start src/dashboard/server.js --name "trading-dashboard"
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
pm2 stop trading-dashboard
```

If running in the **foreground**, simply press `Ctrl + C` in the active terminal.

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
