#Requires -Version 5.1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DocsDataDir = Join-Path $RepoRoot "docs\data"
$DocsConfigDir = Join-Path $RepoRoot "docs\config"
$DataBranch = "data"

Push-Location $RepoRoot
try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is not installed"
    }

    git fetch origin $DataBranch 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch origin $DataBranch failed"
    }

    New-Item -ItemType Directory -Path $DocsDataDir -Force | Out-Null
    New-Item -ItemType Directory -Path $DocsConfigDir -Force | Out-Null

    git show "origin/${DataBranch}:data/dns-latency.tsv" | Set-Content -Path (Join-Path $DocsDataDir "dns-latency.tsv") -Encoding UTF8
    git show "origin/${DataBranch}:config/monitor.json" | Set-Content -Path (Join-Path $DocsConfigDir "monitor.json") -Encoding UTF8

    Write-Host "Fetched data branch into docs/ for local preview."
}
finally {
    Pop-Location
}