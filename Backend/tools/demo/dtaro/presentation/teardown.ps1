# DTARO presentation demo: stop the backend, the dashboard and the throwaway cluster, and delete
# %TEMP%\robotx-dtaro-presentation. Touches nothing else.
#
#   powershell -ExecutionPolicy Bypass -File tools\demo\dtaro\presentation\teardown.ps1
param([string]$Instance = "")
$ErrorActionPreference = "Stop"
$SP = Join-Path $env:TEMP "robotx-dtaro-presentation$Instance"
$PG = "C:\Program Files\PostgreSQL\18\bin"
if (-not (Test-Path $SP)) { Write-Host "nothing to remove"; return }

foreach ($name in @("web", "server")) {
  $file = Join-Path $SP "$name.pid"
  if (Test-Path $file) {
    $id = [int](Get-Content $file)
    # taskkill /T also stops the children (cmd.exe → npm → vite).
    & taskkill.exe /PID $id /T /F 2>$null | Out-Null
  }
}
if (Test-Path "$SP\pgdata") { & "$PG\pg_ctl.exe" -D "$SP\pgdata" -m fast stop | Out-Null }
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force $SP
Write-Host "removed $SP"
