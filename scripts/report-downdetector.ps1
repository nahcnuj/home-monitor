#Requires -Version 5.1
<#
.SYNOPSIS
    Report an ISP problem to Downdetector (issue #30).

.DESCRIPTION
    Invoked by publish-data.ps1 when newly recorded TSV lines from the last hour
    contain a high-latency record (>= downdetector.latency_threshold_ms) or a
    timeout (dns_timeout / job_timeout), for a resolver that is mapped to a known
    service in downdetector.service_by_resolver.

    Reports are rate limited to once per 30 minutes via a state file. When
    downdetector.report_url is configured the payload is POSTed as JSON, otherwise
    the report is recorded in the task log only (Downdetector exposes no public
    write API, so the URL is left for the operator to set).

.PARAMETER Service
    Downdetector service name. The caller derives it from the record's resolver IP
    via downdetector.service_by_resolver (e.g. "J:COM").

.PARAMETER BadLines
    Newly recorded TSV lines: ts<TAB>resolver<TAB>domain<TAB>latency[<TAB>error].

.PARAMETER ReportUrl
    Downdetector report endpoint. Empty = record-only (no HTTP request).

.PARAMETER StateDir
    Directory for the rate-limit state file (default <repo>/data/local).

.PARAMETER DryRun
    Build and log the report without POSTing. Used by tests.
#>
param(
    [string]$Service = "J:COM",
    [string[]]$BadLines = @(),
    [string]$ReportUrl = "",
    [string]$StateDir = "",
    [switch]$DryRun
)

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

function Send-DowndetectorReport {
    param(
        [hashtable]$Payload,
        [string]$ReportUrl,
        [switch]$DryRun
    )
    if ($DryRun -or -not $ReportUrl) {
        return $true
    }
    $json = $Payload | ConvertTo-Json -Compress
    $response = Invoke-WebRequest -Uri $ReportUrl -Method Post -Body $json `
        -ContentType "application/json; charset=utf-8" `
        -Headers @{ "User-Agent" = "home-monitor-downdetector-reporter/1.0" } `
        -UseBasicParsing -TimeoutSec 30
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
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

if (Send-DowndetectorReport -Payload $payload -ReportUrl $ReportUrl -DryRun:$DryRun) {
    Set-DowndetectorReportState -StateFile $StateFile
    $dest = if ($ReportUrl -and -not $DryRun) { "POST $ReportUrl" } else { "recorded (no report URL configured)" }
    Write-TaskLog -TaskName "downdetector" -Message "report ok: $dest"
    exit 0
}

Write-TaskLog -TaskName "downdetector" -Message "report submission failed; state not updated"
exit 1
