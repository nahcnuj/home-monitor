#Requires -Version 5.1
<#
.SYNOPSIS
  Remove dns-latency.tsv rows whose timestamp is in [StartTs, EndTs).

.PARAMETER StartTs
  Inclusive Unix seconds.

.PARAMETER EndTs
  Exclusive Unix seconds.

.PARAMETER PushGhPages
#>
param(
    [Parameter(Mandatory = $true)][long]$StartTs,
    [Parameter(Mandatory = $true)][long]$EndTs
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
