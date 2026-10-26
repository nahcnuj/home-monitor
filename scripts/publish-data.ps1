#Requires -Version 5.1
param([switch]$All)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot
. (Join-Path $PSScriptRoot "Get-MonitorConfig.ps1")
. (Join-Path $PSScriptRoot "TaskLog.ps1")
$DataDir = Join-Path $RepoRoot "data\local"
$DataFile = Join-Path $DataDir "dns-latency.tsv"
$LastSyncFile = Join-Path $DataDir ".last-sync"

# Job names as reported by `gh run view`; the second entry keeps older runs
# (before the sync/report split in issue #44) working.
$script:SyncJobNames = @("Sync DNS data", "sync")
$script:ReportJobNames = @("Report to Downdetector", "report")

# sync-dns-data.yml drops rows older than 7 days (rolling retention). Sending
# older rows is pointless, and a stale/missing .last-sync must not make the
# task push months of history that the workflow discards anyway.
$script:GithubRetentionSeconds = 7 * 86400

function Get-DataCutoffTs {
    return [long](Get-MonitorConfig).data_cutoff_ts
}

function Get-EffectiveCutoffTs {
    param(
        [Parameter(Mandatory)][long]$DataCutoffTs,
        [Parameter(Mandatory)][long]$NowTs
    )

    $retentionCutoff = $NowTs - $script:GithubRetentionSeconds
    if ($retentionCutoff -gt $DataCutoffTs) { return $retentionCutoff }
    return $DataCutoffTs
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
    $cutoffTs = Get-EffectiveCutoffTs -DataCutoffTs (Get-DataCutoffTs) `
        -NowTs ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
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

function Set-ConahcnujGhToken {
    # User gh auth is not used. Mint a short-lived installation token for the
    # conahcnuj GitHub App (private key stays in ~/.config/opencode/gh-app).
    $bash = "C:\Program Files\Git\bin\bash.exe"
    if (-not (Test-Path -LiteralPath $bash)) {
        throw "Git bash not found at $bash (needed to mint the conahcnuj token)"
    }
    $tokenScript = Join-Path $env:USERPROFILE ".config\opencode\gh-app\get-token.sh"
    if (-not (Test-Path -LiteralPath $tokenScript)) {
        throw "conahcnuj token script not found: $tokenScript"
    }

    $errFile = New-TemporaryFile
    try {
        $token = (& $bash --noprofile --norc $tokenScript 2>$errFile | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            $rawErr = Get-Content -Raw -LiteralPath $errFile -ErrorAction SilentlyContinue
            $err = if ($rawErr) { $rawErr.Trim() } else { "exit $LASTEXITCODE" }
            throw "conahcnuj token mint failed: $err"
        }
    }
    finally {
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }

    if ($token -notmatch '^ghs_[A-Za-z0-9._-]+$') {
        throw "conahcnuj token mint returned an unexpected value"
    }

    # gh prefers GH_TOKEN over the logged-in user in hosts.yml.
    $env:GH_TOKEN = $token
}

function Enter-PublishLock {
    # A backlog can keep one publish running for over an hour, while the task
    # fires every publish_interval_min. Without a lock the runs overlap, all
    # read the same .last-sync and dispatch duplicate workflows.
    if (-not (Test-Path -LiteralPath $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }
    $lockFile = Join-Path $DataDir ".publish.lock"
    try {
        return [System.IO.File]::Open(
            $lockFile,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch [System.IO.IOException] {
        return $null
    }
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

function Invoke-Gh {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [object]$Stdin
    )

    # gh reports progress and warnings on stderr. Windows PowerShell 5.1 turns a
    # redirected native stderr line into a terminating NativeCommandError while
    # $ErrorActionPreference is Stop, so relax it for the duration of the call.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($null -ne $Stdin) {
            $stdout = $Stdin | & $GhExe @Arguments 2>$null
        } else {
            $stdout = & $GhExe @Arguments 2>$null
        }
    }
    finally {
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $savedPreference
    }

    return @{
        ExitCode = $exitCode
        Output = @($stdout)
    }
}

function ConvertFrom-JobListJson {
    param([string]$Json)

    # A job that has not finished yet has a null conclusion; map it to "" so
    # Wait-WorkflowJobState treats it as still running.
    $jobs = @{}
    if ([string]::IsNullOrWhiteSpace($Json)) { return $jobs }
    try {
        $run = $Json | ConvertFrom-Json
    }
    catch {
        return $jobs
    }
    foreach ($job in @($run.jobs)) {
        if (-not $job -or [string]::IsNullOrWhiteSpace($job.name)) { continue }
        $conclusion = if ($job.conclusion) { [string]$job.conclusion } else { "" }
        $jobs[[string]$job.name] = @{
            Status = [string]$job.status
            Conclusion = $conclusion
        }
    }
    return $jobs
}

function Get-WorkflowJobStates {
    param(
        [string]$RepoSlug,
        [string]$RunId
    )

    # Parse JSON in PowerShell instead of passing a jq expression. Windows
    # PowerShell 5.1 collapses the embedded `""` in jq's
    # `(.conclusion // "")` idiom (it reaches gh as a single `"`), so the old
    # `--jq` expression made gh fail with "accepts at most 1 arg(s)". That
    # turned every successful sync into a 30-minute timeout and left
    # .last-sync stale.
    $result = Invoke-Gh -Arguments @(
        "run", "view", $RunId, "--repo", $RepoSlug, "--json", "jobs"
    )
    if ($result.ExitCode -ne 0) { return @{} }
    return ConvertFrom-JobListJson -Json ((@($result.Output) -join "`n").Trim())
}

function Find-WorkflowJobState {
    param(
        [hashtable]$Jobs,
        [string[]]$Names
    )

    foreach ($name in $Names) {
        if ($Jobs.ContainsKey($name)) { return $Jobs[$name] }
    }
    return $null
}

function Wait-WorkflowJobState {
    param(
        [string]$RepoSlug,
        [string]$RunId,
        [string[]]$Names,
        [int]$TimeoutMinutes,
        [int]$PollSeconds = 5
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $state = Find-WorkflowJobState -Jobs (Get-WorkflowJobStates -RepoSlug $RepoSlug -RunId $RunId) -Names $Names
        if ($state -and $state.Conclusion) { return $state }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Seconds $PollSeconds
    }
}

function Wait-WorkflowRunCompleted {
    param(
        [string]$RepoSlug,
        [string]$RunId,
        [int]$TimeoutMinutes,
        [int]$PollSeconds = 5
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $result = Invoke-Gh -Arguments @(
            "run", "view", $RunId, "--repo", $RepoSlug, "--json", "status", "--jq", ".status"
        )
        $status = (@($result.Output) -join "").Trim()
        if ($result.ExitCode -eq 0 -and $status -eq "completed") { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds $PollSeconds
    }
}

function Invoke-SyncDnsWorkflow {
    param(
        [string]$RepoSlug,
        [string]$DataB64
    )

    $payload = @{ data_b64 = $DataB64 } | ConvertTo-Json -Compress
    $dispatch = Invoke-Gh -Arguments @(
        "workflow", "run", "sync-dns-data.yml", "--repo", $RepoSlug, "--json"
    ) -Stdin $payload
    if ($dispatch.ExitCode -ne 0) {
        throw "gh workflow run failed"
    }

    Start-Sleep -Seconds 3
    $listed = Invoke-Gh -Arguments @(
        "run", "list", "--repo", $RepoSlug, "--workflow", "sync-dns-data.yml",
        "-L", "1", "--json", "databaseId", "--jq", ".[0].databaseId"
    )
    $runId = (@($listed.Output) -join "").Trim()
    if (-not $runId) {
        throw "Could not find workflow run id"
    }

    # Data sync and Downdetector reporting are separate jobs (issue #44). Only
    # the sync job's conclusion decides whether the publish is retried; a report
    # failure happens after the data is pushed and must not look like a sync
    # failure.
    $syncJob = Wait-WorkflowJobState -RepoSlug $RepoSlug -RunId $runId `
        -Names $SyncJobNames -TimeoutMinutes 30
    if (-not $syncJob) {
        throw "Timed out waiting for the sync job (run_id=$runId)"
    }
    if ($syncJob.Conclusion -ne "success") {
        throw "sync job failed (conclusion=$($syncJob.Conclusion), run_id=$runId)"
    }

    # Wait for the report job so its outcome is recorded locally too, but it can
    # never fail the publish: the data was already committed by the sync job.
    if (-not (Wait-WorkflowRunCompleted -RepoSlug $RepoSlug -RunId $runId -TimeoutMinutes 15)) {
        Write-TaskLog -TaskName "publish" -Message "report still running after 15m - data sync already succeeded (run_id=$runId)"
        return
    }
    $reportJob = Find-WorkflowJobState `
        -Jobs (Get-WorkflowJobStates -RepoSlug $RepoSlug -RunId $runId) -Names $ReportJobNames
    if ($reportJob -and $reportJob.Conclusion -and $reportJob.Conclusion -ne "skipped") {
        $message = if ($reportJob.Conclusion -eq "success") {
            "report job succeeded"
        } else {
            "report job failed (conclusion=$($reportJob.Conclusion)) - data sync already succeeded"
        }
        Write-TaskLog -TaskName "publish" -Message "$message (run_id=$runId)"
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
            # Installation tokens expire after an hour. A large backlog spans
            # many chunks (one workflow run each), so mint a fresh token per
            # attempt instead of letting later chunks fail with HTTP 401.
            Set-ConahcnujGhToken
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

# Dot-sourcing loads functions for tests without running a publish cycle.
if ($MyInvocation.InvocationName -eq '.') {
    return
}

Push-Location $RepoRoot
try {
    Write-TaskLog -TaskName "publish" -Message "started"

    $publishLock = Enter-PublishLock
    if (-not $publishLock) {
        Write-TaskLog -TaskName "publish" -Message "skipped (another publish is already running)"
        return
    }
    try {
        $GhExe = Get-GhExe

        Set-ConahcnujGhToken

        $unsentLines = Get-UnsentLines @PSBoundParameters
        if ($unsentLines.Count -eq 0) {
            Write-TaskLog -TaskName "publish" -Message "skipped (no unsent lines)"
            return
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
    finally {
        $publishLock.Dispose()
    }
}
catch {
    Write-TaskLog -TaskName "publish" -Message "failed: $_"
    throw
}
finally {
    Pop-Location
}