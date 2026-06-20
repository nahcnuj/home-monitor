#Requires -Version 5.1
param([switch]$All)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DataDir = Join-Path $RepoRoot "data\local"
$DataFile = Join-Path $DataDir "dns-latency.tsv"
$LastSyncFile = Join-Path $DataDir ".last-sync"

function Compress-GzipBytes {
    param([byte[]]$Data)
    $ms = New-Object System.IO.MemoryStream
    $gzip = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress)
    $gzip.Write($Data, 0, $Data.Length)
    $gzip.Close()
    return $ms.ToArray()
}

function Get-UnsentLines {
    param([switch]$All)

    if (-not (Test-Path $DataFile)) { return @() }
    $allLines = Get-Content $DataFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" }
    if ($allLines.Count -eq 0) { return @() }
    if ($All -or -not (Test-Path $LastSyncFile)) { return $allLines }

    $lastSyncTs = [int](Get-Content $LastSyncFile -Raw).Trim()
    return $allLines | Where-Object { [int]($_ -split "`t")[0] -gt $lastSyncTs }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "gh CLI is not installed. See https://cli.github.com/"
}

Push-Location $RepoRoot
try {
    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "gh is not authenticated. Run: gh auth login"
    }

    $unsentLines = Get-UnsentLines @PSBoundParameters
    if ($unsentLines.Count -eq 0) { exit 0 }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($unsentLines -join "`n") + "`n")
    $dataB64 = [Convert]::ToBase64String((Compress-GzipBytes -Data $bytes))

    $repoSlug = $null
    if ($RepoRoot -match 'github\.com[/\\]([^/\\]+)[/\\]([^/\\]+)$') {
        $repoSlug = "$($Matches[1])/$($Matches[2])"
    }
    if (-not $repoSlug) {
        $repoSlug = gh repo view --json nameWithOwner -q .nameWithOwner 2>$null
    }
    if (-not $repoSlug) {
        throw "Cannot determine GitHub repo. Add git remote or use ghq path."
    }

    gh workflow run sync-dns-data.yml --repo $repoSlug -f "data_b64=$dataB64" --wait
    if ($LASTEXITCODE -ne 0) {
        throw "gh workflow run failed"
    }

    $maxTs = ($unsentLines | ForEach-Object { [int]($_ -split "`t")[0] } | Measure-Object -Maximum).Maximum
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    Set-Content -Path $LastSyncFile -Value $maxTs -NoNewline -Encoding UTF8
}
finally {
    Pop-Location
}