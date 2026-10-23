# DTARO obstacle-alert presentation demo: one-time setup of a THROWAWAY stack.
#
# Creates a new PostgreSQL cluster under %TEMP% (never 5432, never the Docker LOCAL 5433, never
# Neon), applies the migrations, writes a disposable env file with fresh secrets, seeds the V1
# world (six simulated robots, no physical robot) and publishes + pins G4 (four RNSIT zones)
# through the guarded rehearsal tool. Refuses if the port or the directory is already taken.
#
#   powershell -ExecutionPolicy Bypass -File tools\demo\dtaro\presentation\setup.ps1
#
# Then start.ps1, then `node tools\demo\dtaro\presentation\runDemo.js`. Remove with teardown.ps1.
param(
  [int]$DbPort = 55480,
  [int]$ApiPort = 3140,
  [int]$WebPort = 5190
)
$ErrorActionPreference = "Stop"
$BACKEND = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$SP = Join-Path $env:TEMP "robotx-dtaro-presentation"
$PG = "C:\Program Files\PostgreSQL\18\bin"
$DB = "robotx_dtaro_presentation"
$USER_NAME = "dtarodemo"
$URL = "postgresql://${USER_NAME}@127.0.0.1:${DbPort}/${DB}"

if (Get-NetTCPConnection -LocalPort $DbPort -State Listen -ErrorAction SilentlyContinue) { throw "port $DbPort is already in use" }
if (Test-Path $SP) { throw "$SP already exists: run teardown.ps1 first" }
New-Item -ItemType Directory -Force $SP | Out-Null

Write-Host "1/5 cluster on 127.0.0.1:$DbPort in $SP"
& "$PG\initdb.exe" -D "$SP\pgdata" -U $USER_NAME -A trust -E UTF8 --locale=C | Out-Null
Start-Process "$PG\postgres.exe" -ArgumentList "-D", "$SP\pgdata", "-p", "$DbPort", "-c", "listen_addresses=127.0.0.1" -WindowStyle Hidden
for ($i = 0; $i -lt 40; $i++) { & "$PG\pg_isready.exe" -h 127.0.0.1 -p $DbPort | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Milliseconds 500 }
& "$PG\createdb.exe" -h 127.0.0.1 -p $DbPort -U $USER_NAME $DB

Write-Host "2/5 migrations"
$env:PGOPTIONS = "-c client_min_messages=warning"
$n = 0
Get-ChildItem "$BACKEND\prisma\migrations" -Directory | Sort-Object Name | ForEach-Object {
  & "$PG\psql.exe" -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $DbPort -U $USER_NAME -d $DB -f "$($_.FullName)\migration.sql" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "migration $($_.Name) failed" }
  $n++
}
Remove-Item Env:PGOPTIONS
Write-Host "   $n migrations applied"

Write-Host "3/5 disposable configuration (fresh secrets; nothing from your LOCAL env file)"
$hex = { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }) }
@"
NODE_ENV=development
HOST=127.0.0.1
PORT=$ApiPort
FRONTEND_URL=http://127.0.0.1:$WebPort
DATABASE_URL=$URL
JWT_SECRET=$(& $hex)
PRIVACY_IDENTITY_KEY=$(& $hex)
PRIVACY_SURROGATE_SECRET=$(& $hex)
SEED_ADMIN_EMAIL=dtaro-presenter@local.test
SEED_ADMIN_PASSWORD=$(& $hex)
PHYSICAL_FLEET_ENABLED=false
AGENT_MTLS_REQUIRED=false
DTARO_ZONE_ALERTS_ENABLED=true
VERIFY_CORRIDOR_HALF_WIDTH_M=30
SIM_DTARO_SCENARIO=$BACKEND\tools\demo\dtaro\rnsit-dtaro-g4-scenario.json
"@ | Set-Content -Encoding ascii "$SP\demo.env"
@{ dbPort = $DbPort; apiPort = $ApiPort; webPort = $WebPort; databaseUrl = $URL; dataDirectory = "$SP\pgdata"; envFile = "$SP\demo.env" } |
  ConvertTo-Json | Set-Content -Encoding ascii "$SP\demo.json"
$env:ROBOTX_ENV_FILE = "$SP\demo.env"
$env:DATABASE_URL = $URL
Remove-Item Env:ROBOTX_ENV -ErrorAction SilentlyContinue

Push-Location $BACKEND
try {
  # Refuses non-loopback AND the canonical LOCAL database (the seed's own check refuses only 5432).
  node -e "process.exit(require('./src/config/environmentGuard').requireDisposableTarget() ? 0 : 78)"
  if ($LASTEXITCODE -ne 0) { throw "not a disposable target: refusing" }

  Write-Host "4/5 seed: region, 64-cell cover, depot, six simulated robots (publishes + pins v1)"
  node tools/demo/seedV1Demonstration.js --database-url $URL --fleet baseline | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "seed failed" }

  Write-Host "5/5 G4: Zone rows, publish, pin, rollback, recover (ends pinned on G4)"
  node tools/demo/dtaro/rehearseG4Publication.js --rehearse --database-url $URL --expect-data-directory "$SP\pgdata" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "G4 rehearsal failed" }
}
finally { Pop-Location }

Write-Host "Ready (G4 published and pinned in the throwaway database). Next: tools\demo\dtaro\presentation\start.ps1"
