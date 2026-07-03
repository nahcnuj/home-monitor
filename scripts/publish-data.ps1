#Requires -Version 5.1
param([switch]$All)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot
. (Join-Path $PSScriptRoot "Get-MonitorConfig.ps1")
. (Join-Path $PSScriptRoot "TaskLog.ps1")
$DataDir = Join-Path $RepoRoot "data\local"
$GhExe = Get-GhExe
$DataFile = Join-Path $DataDir "dns-latency.tsv"
$LastSyncFile = Join-Path $DataDir ".last-sync"

function Get-DataCutoffTs {
    return [long](Get-MonitorConfig).data_cutoff_ts
}

function Get-PublishSettings {
    $config = Get-MonitorConfig
    $maxAttempts = if ($null -ne $config.publish_max_attempts -and $config.publish_max_attempts -gt 0) {
        [int]$config.publish_max_attempts
    } else {
        3
    }
    $delays = @($config.publish_retry_delays_sec | Where-Object { $_ -gt 0 })
    if ($delays.Count -eq 0) {
        $delays = @(30, 60, 120)
    }
    return @{
        MaxAttempts = $maxAttempts
        RetryDelaysSec = $delays
    }
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

function Convert-LinesToB64 {
    param([string[]]$Lines)
    if (-not $Lines -or $Lines.Count -eq 0) { return "" }
    $content = ($Lines -join "`n") + "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
    return [Convert]::ToBase64String((Compress-GzipBytes -Data $bytes))
}

function Split-LinesToB64Chunks {
    param(
        [string[]]$Lines,
        [int]$MaxB64Length = 60000
    )
    if (-not $Lines -or $Lines.Count -eq 0) { return @() }
    $chunks = New-Object System.Collections.Generic.List[object]
    $target = 9000
    $i = 0
    $n = $Lines.Count
    while ($i -lt $n) {
        $end = [Math]::Min($i + $target - 1, $n - 1)
        $cand = $Lines[$i..$end]
        $b64 = Convert-LinesToB64 -Lines $cand
        while ($b64.Length -gt $MaxB64Length -and $cand.Count -gt 1) {
            $end--
            $cand = $Lines[$i..$end]
            $b64 = Convert-LinesToB64 -Lines $cand
        }
        $chunks.Add($cand)
        $i = $end + 1
    }
    return ,($chunks.ToArray())
}

function Get-RepoSlug {
    $repoSlug = $null
    if ($RepoRoot -match 'github\.com[/\\]([^/\\]+)[/\\]([^/\\]+)$') {
        $repoSlug = "$($Matches[1])/$($Matches[2])"
    }
    if (-not $repoSlug) {
        $repoSlug = & $GhExe repo view --json nameWithOwner -q .nameWithOwner 2>$null
    }
    if (-not $repoSlug) {
        throw "Cannot determine GitHub repo. Add git remote or use ghq path."
    }
    return $repoSlug
}

function Invoke-SyncDnsWorkflow {
    param(
        [string]$RepoSlug,
        [string]$DataB64
    )

    $payload = @{ data_b64 = $DataB64 } | ConvertTo-Json -Compress
    $payload | & $GhExe workflow run sync-dns-data.yml --repo $RepoSlug --json 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "gh workflow run failed"
    }

    Start-Sleep -Seconds 3
    $runId = & $GhExe run list --repo $RepoSlug --workflow sync-dns-data.yml -L 1 --json databaseId -q ".[0].databaseId"
    if (-not $runId) {
        throw "Could not find workflow run id"
    }

    $null = & $GhExe run watch $runId --repo $RepoSlug --exit-status 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh run watch failed (run_id=$runId)"
    }
}

function Invoke-PublishWithRetry {
    param(
        [string]$RepoSlug,
        [string]$DataB64,
        [int]$MaxAttempts,
        [int[]]$RetryDelaysSec
    )

    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Invoke-SyncDnsWorkflow -RepoSlug $RepoSlug -DataB64 $DataB64 | Out-Null
            return $attempt
        }
        catch {
            if ($attempt -ge $MaxAttempts) {
                throw
            }
            $delayIndex = [Math]::Min($attempt - 1, $RetryDelaysSec.Length - 1)
            $delaySec = $RetryDelaysSec[$delayIndex]
            Write-TaskLog -TaskName "publish" -Message "retry ${attempt}/${MaxAttempts} in ${delaySec}s: $_"
            Start-Sleep -Seconds $delaySec
        }
    }
}

Push-Location $RepoRoot
try {
    Write-TaskLog -TaskName "publish" -Message "started"

    & $GhExe auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "gh is not authenticated. Run: gh auth login"
    }

    $unsentLines = Get-UnsentLines @PSBoundParameters
    if ($unsentLines.Count -eq 0) {
        Write-TaskLog -TaskName "publish" -Message "skipped (no unsent lines)"
        exit 0
    }

    $settings = Get-PublishSettings
    $repoSlug = Get-RepoSlug
    $chunks = Split-LinesToB64Chunks -Lines $unsentLines
    $totalLines = 0
    $finalMaxTs = 0
    $lastAttemptsUsed = 0
    for ($c = 0; $c -lt $chunks.Count; $c++) {
        $chunk = $chunks[$c]
        $dataB64 = Convert-LinesToB64 -Lines $chunk
        $chunkMax = ($chunk | ForEach-Object { [int]($_ -split "`t")[0] } | Measure-Object -Maximum).Maximum
        $chunkNum = $c + 1
        if ($chunks.Count -gt 1) {
            Write-TaskLog -TaskName "publish" -Message "sending chunk ${chunkNum}/$($chunks.Count) (lines=$($chunk.Count), max_ts=$chunkMax)"
        }
        $attemptsUsed = Invoke-PublishWithRetry -RepoSlug $repoSlug -DataB64 $dataB64 `
            -MaxAttempts $settings.MaxAttempts -RetryDelaysSec $settings.RetryDelaysSec
        $lastAttemptsUsed = $attemptsUsed

        if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($LastSyncFile, "$chunkMax", $utf8NoBom)

        $totalLines += $chunk.Count
        $finalMaxTs = $chunkMax
        $retryNote = if ($attemptsUsed -gt 1) { ", attempts=$attemptsUsed" } else { "" }
        if ($chunks.Count -gt 1) {
            Write-TaskLog -TaskName "publish" -Message "chunk ${chunkNum} ok (lines=$($chunk.Count)$retryNote)"
        }
    }

    $chunkNote = if ($chunks.Count -gt 1) { ", chunks=$($chunks.Count)" } else { "" }
    $retryNote = if ($chunks.Count -eq 1 -and $lastAttemptsUsed -gt 1) { ", attempts=$lastAttemptsUsed" } else { "" }
    Write-TaskLog -TaskName "publish" -Message "ok (lines=$totalLines, max_ts=$finalMaxTs$chunkNote$retryNote)"
}
catch {
    Write-TaskLog -TaskName "publish" -Message "failed: $_"
    throw
}
finally {
    Pop-Location
}