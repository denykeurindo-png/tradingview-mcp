# Launch Google Chrome for Cockpit Dashboard and Heatmap in a separate normal window (isolated profile)
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chromePath)) {
    # Fallback to start if Chrome is in PATH
    Start-Process "chrome.exe" -ArgumentList "--user-data-dir=C:\ChromeDebugProfileNormal", "http://localhost:4000/cockpit", "http://localhost:4000/heatmap.html"
} else {
    Start-Process $chromePath -ArgumentList "--user-data-dir=C:\ChromeDebugProfileNormal", "--no-first-run", "--no-default-browser-check", "http://localhost:4000/cockpit", "http://localhost:4000/heatmap.html"
}
Write-Host "Launched clean Chrome debug session for Cockpit Dashboard at http://localhost:4000/cockpit!" -ForegroundColor Green
