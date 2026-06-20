#Requires -Version 5.1

$DataDir = Join-Path (Split-Path $PSScriptRoot -Parent) "data\local"
$LastSyncFile = Join-Path $DataDir ".last-sync"

if (Test-Path $LastSyncFile) {
    Remove-Item $LastSyncFile -Force
}

& (Join-Path $PSScriptRoot "publish-data.ps1") -All