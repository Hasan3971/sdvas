# Оновлення на сервері Windows: git pull -> копіювання в папку проекту -> docker compose up -d --build.
# Запуск:  powershell -File deploy\update.ps1 [-Branch main]
param(
    [string]$Branch = "main",
    [string]$Repo = "https://github.com/Hasan3971/sdvas.git",
    [string]$Project = "D:\server-projects\hotmail.vibecods.xyz",
    [string]$Clone = "D:\server-projects\_hoplite_scratch\sdvas-clone"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$Clone\.git")) { git clone --depth 1 --branch $Branch $Repo $Clone } else { git -C $Clone fetch --depth 1 origin $Branch; git -C $Clone reset --hard FETCH_HEAD }
# data\ (база, ключі, бекапи) і .env не чіпаємо
robocopy "$Clone\hotmail.vibecods.xyz" $Project /MIR /XD data .git __pycache__ /XF .env | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }
Push-Location $Project
docker compose up -d --build
Pop-Location
Start-Sleep -Seconds 4
curl.exe -s http://127.0.0.1:14010/api/v1/health
