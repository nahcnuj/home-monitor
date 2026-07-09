#Requires -Version 5.1
<#
.SYNOPSIS
  Remove dns-latency.tsv rows whose timestamp is in [StartTs, EndTs).

.PARAMETER StartTs
  Inclusive Unix seconds.

.PARAMETER EndTs
  Exclusive Unix seconds.

.PARAMETER PushGhPages
  Also rewrite origin/gh-pages docs/data (TSV + JSON) and force-push.
#>
param(
    [Parameter(Mandatory = $true)][long]$StartTs,
    [Parameter(Mandatory = $true)][long]$EndTs,
    [switch]$PushGhPages
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot "Get-MonitorConfig.ps1")
$LocalFile = Join-Path $RepoRoot "data\local\dns-latency.tsv"
$MirrorFile = Join-Path $RepoRoot "docs\data\dns-latency.tsv"

function Remove-TimeRangeRows {
    param([string]$Path, [long]$StartTs, [long]$EndTs)

    if (-not (Test-Path $Path)) {
        Write-Host "Skip (not found): $Path"
        return 0
    }

    $lines = @(Get-Content $Path -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = 0
    foreach ($line in $lines) {
        $cols = $line -replace "`r", "" -split "`t"
        $ts = 0
        if (-not [long]::TryParse($cols[0], [ref]$ts)) {
            $kept.Add($line)
            continue
        }
        if ($ts -ge $StartTs -and $ts -lt $EndTs) {
            $removed++
            continue
        }
        $kept.Add($line)
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    if ($kept.Count -gt 0) {
        [System.IO.File]::WriteAllText($Path, ($kept -join "`n") + "`n", $utf8NoBom)
    }
    else {
        [System.IO.File]::WriteAllText($Path, "", $utf8NoBom)
    }
    Write-Host "$Path : removed $removed, kept $($kept.Count)"
    return $removed
}

if ($EndTs -le $StartTs) {
    throw "EndTs must be greater than StartTs"
}

Write-Host "Purging ts in [$StartTs, $EndTs)"
$total = 0
$total += Remove-TimeRangeRows -Path $LocalFile -StartTs $StartTs -EndTs $EndTs
$total += Remove-TimeRangeRows -Path $MirrorFile -StartTs $StartTs -EndTs $EndTs
Write-Host "Local/mirror removed: $total"

if (-not $PushGhPages) {
    Write-Host "Done (local only). Re-run with -PushGhPages to update origin/gh-pages."
    exit 0
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("home-monitor-purge-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    Push-Location $RepoRoot
    git fetch origin gh-pages
    git worktree add --detach $work origin/gh-pages
    Pop-Location

    $pagesTsv = Join-Path $work "docs\data\dns-latency.tsv"
    $pagesJson = Join-Path $work "docs\data\dns-latency.json"
    $null = Remove-TimeRangeRows -Path $pagesTsv -StartTs $StartTs -EndTs $EndTs

    Push-Location $RepoRoot
    if (Test-Path $pagesTsv) {
        npx --yes tsx scripts/tsv-to-json.ts $pagesTsv $pagesJson
    }
    else {
        New-Item -ItemType Directory -Path (Split-Path $pagesJson) -Force | Out-Null
        Set-Content -Path $pagesJson -Value "[]`n" -Encoding utf8NoBOM
    }
    Pop-Location

    Push-Location $work
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git config commit.gpgsign false
    git add -f docs/data/dns-latency.tsv docs/data/dns-latency.json
    if (git diff --cached --quiet) {
        Write-Host "gh-pages: no changes after purge"
    }
    else {
        git commit --no-gpg-sign -m "chore: purge dns-latency rows [$StartTs, $EndTs)"
        git push origin HEAD:gh-pages
        Write-Host "gh-pages: pushed purged data"
    }
    Pop-Location
}
finally {
    Push-Location $RepoRoot
    git worktree remove --force $work 2>$null
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    Pop-Location
}
