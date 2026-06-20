#Requires -RunAsAdministrator
#Requires -Version 5.1

$ScriptDir = $PSScriptRoot
$RunCollectVbs = Join-Path $ScriptDir "run-collect-hidden.vbs"
$RunPublishVbs = Join-Path $ScriptDir "run-publish-hidden.vbs"
$RunAs = "$env:USERDOMAIN\$env:USERNAME"
$RepDuration = New-TimeSpan -Days 31

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$VbsPath,
        [TimeSpan]$Interval
    )

    $action = New-ScheduledTaskAction `
        -Execute "wscript.exe" `
        -Argument "`"$VbsPath`"" `
        -WorkingDirectory $ScriptDir

    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval $Interval `
        -RepetitionDuration $RepDuration

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -Hidden `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    $principal = New-ScheduledTaskPrincipal `
        -UserId $RunAs `
        -LogonType Interactive `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force -ErrorAction Stop | Out-Null

    Write-Host "Registered: $TaskName"
}

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -VbsPath $RunCollectVbs -Interval (New-TimeSpan -Minutes 1)
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -VbsPath $RunPublishVbs -Interval (New-TimeSpan -Hours 6)

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute (hidden)"
Write-Host "  Publish: every 6 hours (hidden)"
Write-Host "  Note: re-run this script monthly (repeats for 31 days per registration)"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."