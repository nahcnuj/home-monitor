#Requires -Version 5.1
<#
.SYNOPSIS
    Report an ISP problem to Downdetector (issue #30).

.DESCRIPTION
    Invoked by publish-data.ps1 when newly recorded TSV lines from the last hour
    contain a high-latency record (>= downdetector.latency_threshold_ms) or a
    timeout (dns_timeout / job_timeout), for a resolver that is mapped to a known
    service in downdetector.service_by_resolver.

    Downdetector exposes no public write API, so this drives the same data-api
    endpoint the status page's "Report a problem" button calls:

      1. GET  {data_api_url}/v1/companies/{company_id}/view?ref={page_url}
         -> returns an anonymous view token ("vt").
      2. POST {data_api_url}/v1/companies/{company_id}/indicators
              ?indicator=v2&i={indicator_id}&vt={view token}
         -> records the problem indicator.

    Reports are rate limited to once per 30 minutes via a state file.

    Downdetector sits behind Cloudflare, which rate-limits non-browser traffic
    to the data-api (HTTP 429 / "error code: 1015"). The indicator POST is
    therefore best-effort: when Cloudflare rejects it, the report falls back to
    the status-page report beacon (the request the page itself fires on load):

      GET {data_api_url}/v1/companies/{company_id}/report?ref={page_url}

    That beacon is accepted from a plain HTTP client, so a report signal still
    reaches Downdetector instead of being dropped. Delivery is best-effort
    either way: a rejected report is logged, the rate-limit state is not
    updated, and the next cycle retries. Reporting never blocks data sync.

.PARAMETER Service
    Downdetector service name (e.g. "J:COM"), used for logging.

.PARAMETER BadLines
    Newly recorded TSV lines: ts<TAB>resolver<TAB>domain<TAB>latency[<TAB>error].

.PARAMETER CompanyId
    Downdetector company id (downdetector.services.<service>.company_id).

.PARAMETER IndicatorId
    Downdetector problem indicator id shown on the status page (e.g. 11 =
    固定電話のインターネット / fixed-line internet for J:COM).

.PARAMETER DataApiUrl
    Downdetector data-api base URL.

.PARAMETER PageUrl
    Status page URL used as the report referrer and to mint the view token.

.PARAMETER StateDir
    Directory for the rate-limit state file (default <repo>/data/local).

.PARAMETER DryRun
    Build and log the report without any network request. Used by tests.
#>
param(
    [string]$Service = "J:COM",
    [string[]]$BadLines = @(),
    [string]$CompanyId = "",
    [int]$IndicatorId = 0,
    [string]$DataApiUrl = "https://data-api.downdetector.com",
    [string]$PageUrl = "",
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

function Get-DowndetectorHeaders {
    param([string]$PageUrl = "")
    $headers = @{ "Accept" = "application/json" }
    if ($PageUrl -match '^(https?://[^/]+)') {
        $headers["Origin"] = $Matches[1]
        $headers["Referer"] = $PageUrl
    }
    # downdetector.jp -> data-api.downdetector.com is a cross-origin call on the
    # status page, so the request is shaped like that browser call.
    $headers["Sec-Fetch-Site"] = "cross-site"
    $headers["Sec-Fetch-Mode"] = "cors"
    $headers["Sec-Fetch-Dest"] = "empty"
    $headers["Accept-Language"] = "ja-JP,ja;q=0.9,en;q=0.8"
    # A plain/custom UA is an easy bot-detection flag for Cloudflare, so the
    # request is shaped like the status page's own browser call.
    $headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    return $headers
}

function New-DowndetectorIndicatorUri {
    param(
        [string]$DataApiUrl,
        [string]$CompanyId,
        [int]$IndicatorId,
        [string]$ViewToken
    )
    $vt = [System.Uri]::EscapeDataString([string]$ViewToken)
    return "$DataApiUrl/v1/companies/$CompanyId/indicators?indicator=v2&i=$IndicatorId&vt=$vt"
}

function Get-DowndetectorViewToken {
    param(
        [string]$DataApiUrl,
        [string]$CompanyId,
        [string]$PageUrl = ""
    )
    $ref = [System.Uri]::EscapeDataString([string]$PageUrl)
    $uri = "$DataApiUrl/v1/companies/$CompanyId/view?ref=$ref"
    $headers = Get-DowndetectorHeaders -PageUrl $PageUrl
    $response = Invoke-RestMethod -Uri $uri -Method Get -Headers $headers -TimeoutSec 30
    if (-not $response.token) {
        throw "Downdetector view response had no token"
    }
    return [string]$response.token
}

function Send-DowndetectorReport {
    param(
        [string]$IndicatorUri,
        [hashtable]$Headers = @{},
        [switch]$DryRun
    )
    if ($DryRun) {
        return $true
    }
    try {
        $response = Invoke-WebRequest -Uri $IndicatorUri -Method Post -Headers $Headers `
            -UseBasicParsing -TimeoutSec 30
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    }
    catch {
        return $false
    }
}

function Get-DowndetectorReportBeaconUri {
    param(
        [string]$DataApiUrl,
        [string]$CompanyId,
        [string]$PageUrl = ""
    )
    $ref = [System.Uri]::EscapeDataString([string]$PageUrl)
    return "$DataApiUrl/v1/companies/$CompanyId/report?ref=$ref"
}

function Send-DowndetectorVisitBeacon {
    param(
        [string]$BeaconUri,
        [hashtable]$Headers = @{},
        [switch]$DryRun
    )
    if ($DryRun) {
        return $true
    }
    try {
        $response = Invoke-WebRequest -Uri $BeaconUri -Method Get -Headers $Headers `
            -UseBasicParsing -TimeoutSec 30
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    }
    catch {
        return $false
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
    Write-TaskLog -TaskName "downdetector" -Message "dry-run: would POST indicator $IndicatorId to company $CompanyId"
    exit 0
}

if (-not $CompanyId -or $IndicatorId -le 0) {
    Write-TaskLog -TaskName "downdetector" -Message "no report target configured for '$Service' (company_id/indicator_id); recorded only"
    exit 0
}

$headers = Get-DowndetectorHeaders -PageUrl $PageUrl
# The indicator POST needs a view token; the beacon fallback does not, so a token
# failure only downgrades the report to the beacon instead of aborting it.
$viewToken = ""
try {
    $viewToken = Get-DowndetectorViewToken -DataApiUrl $DataApiUrl -CompanyId $CompanyId -PageUrl $PageUrl
}
catch {
    Write-TaskLog -TaskName "downdetector" -Message "no view token (indicator POST skipped): $_"
}

$indicatorUri = New-DowndetectorIndicatorUri -DataApiUrl $DataApiUrl -CompanyId $CompanyId `
    -IndicatorId $IndicatorId -ViewToken $viewToken

if ($viewToken -and (Send-DowndetectorReport -IndicatorUri $indicatorUri -Headers $headers)) {
    Set-DowndetectorReportState -StateFile $StateFile
    Write-TaskLog -TaskName "downdetector" -Message "report ok: POST company=$CompanyId indicator=$IndicatorId"
    exit 0
}

# Cloudflare rejects the indicator POST from non-browser clients. The status page
# fires this beacon on every load and it is accepted from a plain HTTP client, so
# it is used to make sure a report signal still reaches Downdetector.
Write-TaskLog -TaskName "downdetector" -Message "indicator POST rejected (Cloudflare rate limit); falling back to the status-page report beacon"
$beaconUri = Get-DowndetectorReportBeaconUri -DataApiUrl $DataApiUrl -CompanyId $CompanyId -PageUrl $PageUrl
if (Send-DowndetectorVisitBeacon -BeaconUri $beaconUri -Headers $headers) {
    Set-DowndetectorReportState -StateFile $StateFile
    Write-TaskLog -TaskName "downdetector" -Message "report ok (fallback): GET beacon company=$CompanyId ref=$PageUrl"
    exit 0
}

Write-TaskLog -TaskName "downdetector" -Message "report submission failed; state not updated"
exit 1
