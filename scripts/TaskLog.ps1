#Requires -Version 5.1

function Write-TaskLog {
    param(
        [string]$TaskName,
        [string]$Message
    )

    $repoRoot = Split-Path $PSScriptRoot -Parent
    $logDir = Join-Path $repoRoot "data\local"
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $logFile = Join-Path $logDir "$TaskName.log"
    $line = "{0} {1}" -f (Get-Date -Format "o"), $Message
    [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
}