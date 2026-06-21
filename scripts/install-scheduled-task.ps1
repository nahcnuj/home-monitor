#Requires -RunAsAdministrator
#Requires -Version 5.1

$ScriptDir = $PSScriptRoot
$RunCollectVbs = Join-Path $ScriptDir "run-collect-hidden.vbs"
$RunPublishVbs = Join-Path $ScriptDir "run-publish-hidden.vbs"
$RunAs = "$env:USERDOMAIN\$env:USERNAME"
. (Join-Path $ScriptDir "Get-MonitorConfig.ps1")

$config = Get-MonitorConfig
$publishIntervalMin = if ($null -ne $config.publish_interval_min -and $config.publish_interval_min -gt 0) {
    [int]$config.publish_interval_min
} else {
    10
}

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$VbsPath,
        [string]$Schedule,
        [string]$Modifier
    )

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null

    $tr = "wscript.exe `"$VbsPath`""
    $output = schtasks.exe /Create /F /TN $TaskName /TR "$tr" /SC $Schedule /MO $Modifier /RU $RunAs /RL LIMITED 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "schtasks failed for ${TaskName}: $output"
    }

    Write-Host "Registered: $TaskName"
}

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -VbsPath $RunCollectVbs -Schedule "MINUTE" -Modifier "1"
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -VbsPath $RunPublishVbs -Schedule "MINUTE" -Modifier "$publishIntervalMin"

# First scheduled slot may be up to one interval away; publish pending data now.
schtasks.exe /Run /TN "HomeMonitor-DNS-Publish" | Out-Null
Write-Host "Triggered initial publish run."

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute (hidden)"
Write-Host "  Publish: every $publishIntervalMin minutes (hidden)"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."