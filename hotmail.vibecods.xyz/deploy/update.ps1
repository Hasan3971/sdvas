# Server update (Windows): git pull -> copy into the project folder -> docker compose up -d --build.
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\update.ps1 [-Branch main]
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
param(
    [string]$Branch = "main",
    [string]$Repo = "https://github.com/Hasan3971/sdvas.git",
    [string]$Project = "D:\server-projects\hotmail.vibecods.xyz",
    [string]$Clone = "D:\server-projects\_hoplite_scratch\sdvas-clone"
)
# git and docker print progress to stderr, so check exit codes instead of using "Stop"
$ErrorActionPreference = "Continue"
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "${what} failed with exit code $LASTEXITCODE" } }

if (-not (Test-Path "$Clone\.git")) {
    git clone --depth 1 --branch $Branch $Repo $Clone; Check "git clone"
} else {
    git -C $Clone fetch --depth 1 origin $Branch; Check "git fetch"
    git -C $Clone reset --hard FETCH_HEAD; Check "git reset"
}
# data\ (database key, backups) and .env are never touched
robocopy "$Clone\hotmail.vibecods.xyz" $Project /MIR /XD data .git __pycache__ /XF .env | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
Push-Location $Project
docker compose up -d --build; Check "docker compose"
Pop-Location
Start-Sleep -Seconds 5
curl.exe -s http://127.0.0.1:14010/api/v1/health
