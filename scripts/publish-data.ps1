#Requires -Version 5.1

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
    if (-not (Test-Path $DataFile)) { return @() }
    $allLines = Get-Content $DataFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" }
    if ($allLines.Count -eq 0) { return @() }
    if (-not (Test-Path $LastSyncFile)) { return $allLines }

    $lastSyncTs = [int](Get-Content $LastSyncFile -Raw).Trim()
    return $allLines | Where-Object { [int]($_ -split "`t")[0] -gt $lastSyncTs }
}

$token = $env:GITHUB_TOKEN
if (-not $token) { throw "GITHUB_TOKEN is not set" }

$remoteUrl = git -C $RepoRoot remote get-url origin 2>$null
if ($remoteUrl -match 'github\.com[:/](.+?)/(.+?)(?:\.git)?$') {
    $owner = $Matches[1]
    $repo = $Matches[2]
}
else {
    throw "Cannot parse owner/repo from git remote"
}

$unsentLines = Get-UnsentLines
if ($unsentLines.Count -eq 0) { exit 0 }

$bytes = [System.Text.Encoding]::UTF8.GetBytes(($unsentLines -join "`n") + "`n")
$dataB64 = [Convert]::ToBase64String((Compress-GzipBytes -Data $bytes))

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}
$body = @{
    event_type     = "dns-data-update"
    client_payload = @{ data_b64 = $dataB64 }
} | ConvertTo-Json -Depth 3 -Compress

Invoke-RestMethod `
    -Uri "https://api.github.com/repos/$owner/$repo/dispatches" `
    -Method POST -Headers $headers -Body $body -TimeoutSec 60 -ContentType "application/json"

$maxTs = ($unsentLines | ForEach-Object { [int]($_ -split "`t")[0] } | Measure-Object -Maximum).Maximum
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
Set-Content -Path $LastSyncFile -Value $maxTs -NoNewline -Encoding UTF8