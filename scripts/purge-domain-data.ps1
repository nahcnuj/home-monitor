#Requires -Version 5.1
param([switch]$Republish)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$LocalFile = Join-Path $RepoRoot "data\local\dns-latency.tsv"
$PublicFile = Join-Path $RepoRoot "docs\data\dns-latency.tsv"

function Test-DnsServerKey {
    param([string]$Key)
    if ($Key -eq "unknown") { return $true }
    if ($Key -match '^(?:\d{1,3}\.){3}\d{1,3}$') { return $true }
    if ($Key -match '^[0-9a-fA-F:]+$') { return $true }
    return $false
}

function Remove-DomainRows {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Host "Skip (not found): $Path"
        return 0
    }

    $lines = Get-Content $Path -Encoding UTF8 | Where-Object { $_.Trim() -ne "" }
    $kept = $lines | Where-Object {
        $key = ($_ -split "`t")[1]
        Test-DnsServerKey -Key $key
    }
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

$total = 0
$total += Remove-DomainRows -Path $LocalFile
$total += Remove-DomainRows -Path $PublicFile
Write-Host "Total removed: $total"

if ($Republish) {
    & (Join-Path $PSScriptRoot "republish-all.ps1")
}