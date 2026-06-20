#Requires -RunAsAdministrator
#Requires -Version 5.1

$RepoRoot = Split-Path $PSScriptRoot -Parent
$CollectScript = Join-Path $PSScriptRoot "collect-dns.ps1"
$PublishScript = Join-Path $PSScriptRoot "publish-data.ps1"
$PowerShellExe = (Get-Command powershell.exe).Source

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$ScriptPath,
        [object]$Trigger
    )

    $action = New-ScheduledTaskAction `
        -Execute $PowerShellExe `
        -Argument "-NoProfile -File `"$ScriptPath`"" `
        -WorkingDirectory $RepoRoot

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
        -Force | Out-Null

    Write-Host "Registered: $TaskName"
}

$collectTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
$publishTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration ([TimeSpan]::MaxValue)

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -ScriptPath $CollectScript -Trigger $collectTrigger
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -ScriptPath $PublishScript -Trigger $publishTrigger

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute"
Write-Host "  Publish: every 6 hours"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."