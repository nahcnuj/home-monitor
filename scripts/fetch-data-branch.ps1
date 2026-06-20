#Requires -Version 5.1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DocsDataDir = Join-Path $RepoRoot "docs\data"
$PagesBranch = "gh-pages"

Push-Location $RepoRoot
try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is not installed"
    }

    git fetch origin $PagesBranch 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch origin $PagesBranch failed"
    }

    New-Item -ItemType Directory -Path $DocsDataDir -Force | Out-Null
    git show "origin/${PagesBranch}:docs/data/dns-latency.tsv" | Set-Content -Path (Join-Path $DocsDataDir "dns-latency.tsv") -Encoding UTF8

    Write-Host "Fetched gh-pages TSV into docs/data for local preview."
}
finally {
    Pop-Location
}