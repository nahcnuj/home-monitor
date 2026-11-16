#Requires -Version 5.1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DocsDataDir = Join-Path $RepoRoot "docs\data"
$LocalDataFile = Join-Path $RepoRoot "data\local\dns-latency.tsv"

Push-Location $RepoRoot
try {
    if (-not (Test-Path $LocalDataFile)) {
        throw "Local data not found: $LocalDataFile"
    }

    New-Item -ItemType Directory -Path $DocsDataDir -Force | Out-Null
    Copy-Item -LiteralPath $LocalDataFile -Destination (Join-Path $DocsDataDir "dns-latency.tsv") -Force

    Write-Host "Copied local TSV into docs/data for local preview."
}
finally {
    Pop-Location
}