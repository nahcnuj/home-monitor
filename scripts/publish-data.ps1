#Requires -Version 5.1
param([switch]$All)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$ConfigPath = Join-Path $RepoRoot "config\monitor.json"
$DataDir = Join-Path $RepoRoot "data\local"
$DataFile = Join-Path $DataDir "dns-latency.tsv"
$LastSyncFile = Join-Path $DataDir ".last-sync"

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

function Test-SendableLine {
    param([string]$Line, [long]$CutoffTs)
    $cols = $Line -split "`t"
    if ($cols.Length -lt 2) { return $false }
    return ([int]$cols[0] -ge $CutoffTs) -and (Test-DnsServerKey -Key $cols[1])
}

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
    $cutoffTs = Get-DataCutoffTs
    $allLines = @(Get-Content $DataFile -Encoding UTF8 | Where-Object {
        $_.Trim() -ne "" -and (Test-SendableLine -Line $_ -CutoffTs $cutoffTs)
    })
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

    gh workflow run sync-dns-data.yml --repo $repoSlug -f "data_b64=$dataB64"
    if ($LASTEXITCODE -ne 0) {
        throw "gh workflow run failed"
    }

    Start-Sleep -Seconds 3
    $runId = gh run list --repo $repoSlug --workflow sync-dns-data.yml -L 1 --json databaseId -q ".[0].databaseId"
    if (-not $runId) {
        throw "Could not find workflow run id"
    }
    gh run watch $runId --repo $repoSlug --exit-status
    if ($LASTEXITCODE -ne 0) {
        throw "gh run watch failed"
    }

    $maxTs = ($unsentLines | ForEach-Object { [int]($_ -split "`t")[0] } | Measure-Object -Maximum).Maximum
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($LastSyncFile, "$maxTs", $utf8NoBom)
}
finally {
    Pop-Location
}