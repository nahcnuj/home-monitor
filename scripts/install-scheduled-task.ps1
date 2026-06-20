#Requires -RunAsAdministrator
#Requires -Version 5.1

$RepoRoot = Split-Path $PSScriptRoot -Parent
$CollectScript = Join-Path $PSScriptRoot "collect-dns.ps1"
$PublishScript = Join-Path $PSScriptRoot "publish-data.ps1"
$PowerShellExe = (Get-Command powershell.exe).Source

# RepetitionDuration の上限は約31日。Daily + 繰り返しで実質無期限に動かす。
$RepDuration = New-TimeSpan -Days 1

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$ScriptPath,
        [TimeSpan]$Interval
    )

    $action = New-ScheduledTaskAction `
        -Execute $PowerShellExe `
        -Argument "-NoProfile -File `"$ScriptPath`"" `
        -WorkingDirectory $RepoRoot

    $trigger = New-ScheduledTaskTrigger -Daily -At "00:00" `
        -RepetitionInterval $Interval `
        -RepetitionDuration $RepDuration

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force -ErrorAction Stop | Out-Null

    Write-Host "Registered: $TaskName"
}

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -ScriptPath $CollectScript -Interval (New-TimeSpan -Minutes 1)
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -ScriptPath $PublishScript -Interval (New-TimeSpan -Hours 6)

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute (daily cycle)"
Write-Host "  Publish: every 6 hours (daily cycle)"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."