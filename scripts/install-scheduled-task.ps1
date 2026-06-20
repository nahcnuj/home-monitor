#Requires -RunAsAdministrator
#Requires -Version 5.1

$RepoRoot = Split-Path $PSScriptRoot -Parent
$CollectScript = Join-Path $PSScriptRoot "collect-dns.ps1"
$PublishScript = Join-Path $PSScriptRoot "publish-data.ps1"

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$ScriptPath,
        [string]$Schedule,
        [string]$Modifier
    )

    # /TR には -File と絶対パスのみ渡す（-Command 内の -LiteralPath 等は schtasks に誤解釈される）
    $taskRun = "powershell.exe -NoProfile -File ""$ScriptPath"""

    $output = & schtasks.exe /Create /F `
        /TN $TaskName `
        /TR $taskRun `
        /SC $Schedule `
        /MO $Modifier `
        /RU "$env:USERDOMAIN\$env:USERNAME" `
        /RL LIMITED 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "schtasks failed for ${TaskName}: $output"
    }

    Write-Host "Registered: $TaskName"
}

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -ScriptPath $CollectScript -Schedule "MINUTE" -Modifier "1"
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -ScriptPath $PublishScript -Schedule "HOURLY" -Modifier "6"

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute"
Write-Host "  Publish: every 6 hours"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."