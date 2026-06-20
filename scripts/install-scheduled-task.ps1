#Requires -RunAsAdministrator
#Requires -Version 5.1

$RepoRoot = Split-Path $PSScriptRoot -Parent
$CollectScript = Join-Path $PSScriptRoot "collect-dns.ps1"
$PublishScript = Join-Path $PSScriptRoot "publish-data.ps1"

function New-TaskCommand {
    param([string]$ScriptPath)
    $cmd = "Set-Location -LiteralPath '$RepoRoot'; & '$ScriptPath'"
    return "powershell.exe -NoProfile -Command `"$cmd`""
}

function Register-MonitorTask {
    param(
        [string]$TaskName,
        [string]$ScriptPath,
        [string]$Schedule,
        [int]$Modifier
    )

    $tr = New-TaskCommand -ScriptPath $ScriptPath
    $args = @(
        "/Create",
        "/TN", $TaskName,
        "/TR", $tr,
        "/SC", $Schedule,
        "/MO", $Modifier,
        "/RU", $env:USERNAME,
        "/RL", "LIMITED",
        "/F"
    )

    $result = & schtasks.exe @args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "schtasks failed for ${TaskName}: $result"
    }

    Write-Host "Registered: $TaskName"
}

Register-MonitorTask -TaskName "HomeMonitor-DNS-Collect" -ScriptPath $CollectScript -Schedule "MINUTE" -Modifier 1
Register-MonitorTask -TaskName "HomeMonitor-DNS-Publish" -ScriptPath $PublishScript -Schedule "HOURLY" -Modifier 6

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Collect: every 1 minute"
Write-Host "  Publish: every 6 hours"
Write-Host ""
Write-Host "Ensure gh CLI is installed and authenticated (gh auth login) before publishing."