#Requires -RunAsAdministrator
#Requires -Version 5.1

$ScriptDir = $PSScriptRoot
$RunCollectVbs = Join-Path $ScriptDir "run-collect-hidden.vbs"
$RunPublishVbs = Join-Path $ScriptDir "run-publish-hidden.vbs"
$Wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$RunAs = "$env:USERDOMAIN\$env:USERNAME"

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$VbsPath,
        [string]$Schedule,
        [string]$Modifier
    )

    # VBS 経由で PowerShell を起動するとウィンドウが出ない
    $tr = "$Wscript //B //Nologo `"$VbsPath`""
    $output = schtasks.exe /Create /F /TN $TaskName /TR "$tr" /SC $Schedule /MO $Modifier /RU $RunAs /RL LIMITED 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "schtasks failed for ${TaskName}: $output"
    }

    Write-Host "Registered: $TaskName"
}

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -VbsPath $RunCollectVbs -Schedule "MINUTE" -Modifier "1"
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -VbsPath $RunPublishVbs -Schedule "HOURLY" -Modifier "6"

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute (hidden)"
Write-Host "  Publish: every 6 hours (hidden)"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."