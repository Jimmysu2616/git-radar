# Daily radar run for Windows Task Scheduler.
# All comments are ASCII on purpose: PowerShell 5 reads .ps1 as ANSI unless it has a BOM.
#
# Usage:
#   setx GITHUB_TOKEN "your_github_pat"     # optional but strongly recommended (rate limit)
#   powershell -ExecutionPolicy Bypass -File scripts\daily-local.ps1
#
# Register as a daily 09:00 task (run once in an admin PowerShell):
#   schtasks /create /tn "GitRadarDaily" /sc daily /st 09:00 /f /tr "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"<ABS_PATH>\scripts\daily-local.ps1\""

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GITHUB_TOKEN) {
  Write-Output 'WARN: GITHUB_TOKEN not set. GitHub allows 60 requests/hour anonymously, the scan may be partial.'
}

node scripts/scan.mjs
if ($LASTEXITCODE -ne 0) { Write-Error 'scan.mjs failed'; exit 1 }

git add data/latest.json data/state.json data/archive
$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Output 'No data change, skip commit.'
  exit 0
}

# 提交并推送。凭据交给 git credential manager，令牌不要写进远程地址。
git commit -m "chore(radar): scan $(Get-Date -Format 'yyyy-MM-dd')" | Out-Null
git push
if ($LASTEXITCODE -ne 0) { Write-Error 'git push failed'; exit 1 }
Write-Output 'Pushed data/ to origin.'
