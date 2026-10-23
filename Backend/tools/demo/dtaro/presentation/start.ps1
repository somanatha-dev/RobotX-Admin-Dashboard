# DTARO presentation demo: start the real backend (server.js in V1 mode: engine, simulator,
# in-memory KV, Redis off) and the dashboard against the throwaway stack setup.ps1 made.
# Both run hidden; logs go to %TEMP%\robotx-dtaro-presentation\{server,web}.log.
#
#   powershell -ExecutionPolicy Bypass -File tools\demo\dtaro\presentation\start.ps1
$ErrorActionPreference = "Stop"
$BACKEND = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$FRONTEND = (Resolve-Path (Join-Path $BACKEND "..\Frontend")).Path
$SP = Join-Path $env:TEMP "robotx-dtaro-presentation"
if (-not (Test-Path "$SP\demo.json")) { throw "run setup.ps1 first" }
$cfg = Get-Content "$SP\demo.json" -Raw | ConvertFrom-Json
foreach ($port in @($cfg.apiPort, $cfg.webPort)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "port $port is already in use" }
}

$env:ROBOTX_ENV_FILE = $cfg.envFile
$env:DATABASE_URL = $cfg.databaseUrl
Remove-Item Env:ROBOTX_ENV -ErrorAction SilentlyContinue
$server = Start-Process -FilePath "node" -WorkingDirectory $BACKEND -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput "$SP\server.log" -RedirectStandardError "$SP\server.err.log" `
  -ArgumentList "tools/demo/startV1Server.js", "--database-url", $cfg.databaseUrl, "--port", "$($cfg.apiPort)", "--host", "127.0.0.1"
$server.Id | Set-Content -Encoding ascii "$SP\server.pid"

$api = "http://127.0.0.1:$($cfg.apiPort)"
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$api/health").StatusCode -eq 200) { $ready = $true; break } } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "the backend did not become healthy; see $SP\server.err.log" }
Write-Host "backend ready on $api"

$env:VITE_API_URL = $api
$env:VITE_SOCKET_URL = $api
$web = Start-Process -FilePath "cmd.exe" -WorkingDirectory $FRONTEND -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput "$SP\web.log" -RedirectStandardError "$SP\web.err.log" `
  -ArgumentList "/c", "npm run dev -- --host 127.0.0.1 --port $($cfg.webPort) --strictPort"
$web.Id | Set-Content -Encoding ascii "$SP\web.pid"

$envLines = Get-Content $cfg.envFile
$email = ($envLines | Where-Object { $_ -like "SEED_ADMIN_EMAIL=*" }) -replace "^SEED_ADMIN_EMAIL=", ""
Write-Host "dashboard: http://127.0.0.1:$($cfg.webPort)/map  (sign in as $email; the password is SEED_ADMIN_PASSWORD in $($cfg.envFile))"
Write-Host "Next: node tools\demo\dtaro\presentation\runDemo.js"
