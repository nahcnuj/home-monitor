#Requires -Version 5.1
param([switch]$Republish)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$ConfigPath = Join-Path $RepoRoot "config\monitor.json"
$LocalFile = Join-Path $RepoRoot "data\local\dns-latency.tsv"
$MirrorFile = Join-Path $RepoRoot "docs\data\dns-latency.tsv"

function Get-DataCutoffTs {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    return [long]$cfg.data_cutoff_ts
}

function Test-DnsServerKey {
    param([string]$Key)
    if ($Key -eq "unknown") { return $true }
    if ($Key -match '^(?:\d{1,3}\.){3}\d{1,3}$') { return $true }
    if ($Key -match '^[0-9a-fA-F:]+$') { return $true }
    return $false
}

function Test-KeepLine {
    param([string]$Line, [long]$CutoffTs)
    $cols = $Line -split "`t"
    if ($cols.Length -lt 2) { return $false }
    return ([int]$cols[0] -ge $CutoffTs) -and (Test-DnsServerKey -Key $cols[1])
}

function Remove-StaleRows {
    param([string]$Path, [long]$CutoffTs)

    if (-not (Test-Path $Path)) {
        Write-Host "Skip (not found): $Path"
        return 0
    }

    $lines = Get-Content $Path -Encoding UTF8 | Where-Object { $_.Trim() -ne "" }
    $kept = $lines | Where-Object { Test-KeepLine -Line $_ -CutoffTs $CutoffTs }
    $removed = $lines.Count - $kept.Count

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

$cutoffTs = Get-DataCutoffTs
Write-Host "data_cutoff_ts: $cutoffTs"
Write-Host "Published data lives on gh-pages docs/; this script cleans local files only."

$total = 0
$total += Remove-StaleRows -Path $LocalFile -CutoffTs $cutoffTs
$total += Remove-StaleRows -Path $MirrorFile -CutoffTs $cutoffTs
Write-Host "Total removed: $total"

if ($Republish) {
    & (Join-Path $PSScriptRoot "republish-all.ps1")
}