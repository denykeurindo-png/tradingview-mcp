# Launch Google Chrome with remote debugging on port 9222 and open TradingView + CoinGlass in GUI mode

# Kill any existing Chrome processes bound to port 9222
$connections = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
if ($connections) {
    Write-Host "Found active connections on port 9222. Stopping related Chrome processes..." -ForegroundColor Yellow
    foreach ($conn in $connections) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -eq "chrome") {
            Write-Host "Stopping process $($proc.Id)..." -ForegroundColor Cyan
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 2
}

# Launch Google Chrome
Write-Host "Launching Google Chrome in GUI mode..." -ForegroundColor Green
Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\ChromeDebugProfile", "https://www.tradingview.com/chart/", "https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC"

Write-Host "Chrome launched successfully on port 9222 with C:\ChromeDebugProfile profile!" -ForegroundColor Green
