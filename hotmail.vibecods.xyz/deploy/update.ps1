# Оновлення на сервері Windows: git pull -> копіювання в папку проекту -> docker compose up -d --build.
# Запуск:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\update.ps1 [-Branch main]
param(
    [string]$Branch = "main",
    [string]$Repo = "https://github.com/Hasan3971/sdvas.git",
    [string]$Project = "D:\server-projects\hotmail.vibecods.xyz",
    [string]$Clone = "D:\server-projects\_hoplite_scratch\sdvas-clone"
)
# git/docker пишуть прогрес у stderr, тому помилки перевіряємо за кодом виходу, а не через "Stop"
$ErrorActionPreference = "Continue"
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what: код виходу $LASTEXITCODE" } }

if (-not (Test-Path "$Clone\.git")) {
    git clone --depth 1 --branch $Branch $Repo $Clone; Check "git clone"
} else {
    git -C $Clone fetch --depth 1 origin $Branch; Check "git fetch"
    git -C $Clone reset --hard FETCH_HEAD; Check "git reset"
}
# data\ (база, ключі, бекапи) і .env не чіпаємо
robocopy "$Clone\hotmail.vibecods.xyz" $Project /MIR /XD data .git __pycache__ /XF .env | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy: код виходу $LASTEXITCODE" }
Push-Location $Project
docker compose up -d --build; Check "docker compose"
Pop-Location
Start-Sleep -Seconds 5
curl.exe -s http://127.0.0.1:14010/api/v1/health
