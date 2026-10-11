#Requires -Version 5.1
<#
.SYNOPSIS
    Report an ISP problem to Downdetector (issue #30).

.DESCRIPTION
    Invoked by publish-data.ps1 when newly recorded TSV lines from the last hour
    contain a high-latency record (>= downdetector.latency_threshold_ms) or a
    timeout (dns_timeout / job_timeout), for a resolver that is mapped to a known
    service in downdetector.service_by_resolver.

    Downdetector has no public write API, so this drives the public status page
    via Playwright (RPA): it opens the page in a real browser, clicks the
    "Report a problem" button, selects the appropriate issue indicator, and
    confirms the submission. This uses only the publicly available web UI.

    Reports are rate limited to once per 30 minutes via a state file.

    Delivery is best-effort: a failed report is logged, the rate-limit state is
    not updated, and the next cycle retries. Reporting never blocks data sync.

.PARAMETER Service
    Downdetector service name (e.g. "J:COM"), used for logging.

.PARAMETER BadLines
    Newly recorded TSV lines: ts<TAB>resolver<TAB>domain<TAB>latency[<TAB>error].

.PARAMETER PageUrl
    Downdetector status page URL (e.g. https://downdetector.jp/shougai/jcom/).

.PARAMETER IndicatorLabel
    Label of the issue indicator to select in the report dialog
    (e.g. "Broadband Internet" for J:COM fixed-line internet).

.PARAMETER StateDir
    Directory for the rate-limit state file (default <repo>/data/local).

.PARAMETER DryRun
    Build and log the report without launching a browser. Used by tests.
#>
param(
    [string]$Service = "J:COM",
    [string[]]$BadLines = @(),
    [string]$PageUrl = "",
    [string]$IndicatorLabel = "Broadband Internet",
    [string]$StateDir = "",
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot "Get-MonitorConfig.ps1")

$ErrorActionPreference = "Stop"
$RateLimitSec = 1800

function Get-DowndetectorPayload {
    param(
        [string]$Service,
        [string[]]$BadLines = @()
    )
    $timeoutCount = @($BadLines | Where-Object { $_ -match "(dns_timeout|job_timeout)" }).Count
    $problemType = if ($timeoutCount -gt 0) { "timeout" } else { "high_latency" }
    return @{
        service       = $Service
        problem_type  = $problemType
        reported_at   = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        source        = "home-monitor"
        count         = @($BadLines).Count
        timeout_count = $timeoutCount
    }
}

function Invoke-DowndetectorRpaReport {
    param(
        [string]$PageUrl,
        [string]$IndicatorLabel,
        [string]$ProblemType,
        [int]$Count,
        [switch]$DryRun
    )
    if ($DryRun) {
        return $true
    }

    $nodeExe = Get-NodeExe
    $scriptPath = Join-Path $PSScriptRoot "report-downdetector.mjs"
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Playwright report script not found: $scriptPath"
    }

    $arguments = @(
        $scriptPath,
        "--page-url", $PageUrl,
        "--indicator", $IndicatorLabel,
        "--problem-type", $ProblemType,
        "--count", "$Count"
    )
    # Start-Process joins array elements with spaces without quoting, so any
    # argument containing whitespace (e.g. the indicator label) needs its own
    # quotes to survive as a single argv entry for node.
    $argumentLine = ($arguments | ForEach-Object {
            $text = [string]$_
            if ($text -match '\s') { '"' + ($text -replace '"', '\"') + '"' } else { $text }
        }) -join " "

    Write-Host "Running: $nodeExe $argumentLine"
    $process = Start-Process -FilePath $nodeExe -ArgumentList $argumentLine -NoNewWindow -Wait -PassThru
    return ($process.ExitCode -eq 0)
}

function Test-DowndetectorRateLimit {
    param(
        [string]$StateFile,
        [int]$MinIntervalSec = 1800
    )
    if (-not (Test-Path -LiteralPath $StateFile)) { return $true }
    $raw = (Get-Content -LiteralPath $StateFile -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $raw) { return $true }
    $raw = $raw.Trim()
    if ($raw -notmatch '^\d+$') { return $true }
    $now = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    return (($now - [long]$raw) -ge $MinIntervalSec)
}

function Set-DowndetectorReportState {
    param([string]$StateFile)
    $dir = Split-Path -Path $StateFile -Parent
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $now = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    [System.IO.File]::WriteAllText($StateFile, "$now", (New-Object System.Text.UTF8Encoding $false))
}

# Dot-sourcing loads functions for tests without running a report cycle.
if ($MyInvocation.InvocationName -eq '.') {
    return
}

. (Join-Path $PSScriptRoot "TaskLog.ps1")
$RepoRoot = Split-Path $PSScriptRoot -Parent
if (-not $StateDir) { $StateDir = Join-Path $RepoRoot "data\local" }
$StateFile = Join-Path $StateDir ".last-downdetector-report"

if (-not (Test-DowndetectorRateLimit -StateFile $StateFile -MinIntervalSec $RateLimitSec)) {
    Write-TaskLog -TaskName "downdetector" -Message "skipped (reported <30m ago)"
    exit 0
}

$payload = Get-DowndetectorPayload -Service $Service -BadLines $BadLines
$json = $payload | ConvertTo-Json -Compress
Write-TaskLog -TaskName "downdetector" -Message "reporting to '$Service' (problem=$($payload.problem_type), bad_lines=$($payload.count)): $json"

if ($DryRun) {
    Write-TaskLog -TaskName "downdetector" -Message "dry-run: would report '$IndicatorLabel' on $PageUrl"
    exit 0
}

if (-not $PageUrl) {
    Write-TaskLog -TaskName "downdetector" -Message "no page URL configured for '$Service'; recorded only"
    exit 0
}

$success = Invoke-DowndetectorRpaReport -PageUrl $PageUrl -IndicatorLabel $IndicatorLabel `
    -ProblemType $payload.problem_type -Count $payload.count

if ($success) {
    Set-DowndetectorReportState -StateFile $StateFile
    Write-TaskLog -TaskName "downdetector" -Message "report ok: $Service indicator=$IndicatorLabel problem=$($payload.problem_type)"
    exit 0
}

Write-TaskLog -TaskName "downdetector" -Message "report submission failed; state not updated"
exit 1
