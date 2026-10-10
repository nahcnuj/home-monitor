#Requires -Version 5.1
<#
.SYNOPSIS
  Tests for Downdetector reporting (issue #30).

.DESCRIPTION
  Covers the detection helpers in publish-data.ps1 and the payload/rate-limit
  helpers in report-downdetector.ps1. No network access is required: the sender
  is exercised in -DryRun mode and the rate-limit state lives in a temp dir.

  Regression intent: a high-latency *success* line (4 columns) must be detected.
  The previous code required 5 columns and silently ignored success lines.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

$failed = 0
function Assert-True {
    param([bool]$Cond, [string]$Msg)
    if ($Cond) {
        Write-Host "OK  $Msg"
    }
    else {
        Write-Host "FAIL $Msg"
        $script:failed++
    }
}

# Dot-sourcing loads functions only; the scripts guard their main flow.
. (Join-Path $RepoRoot "scripts/publish-data.ps1")
. (Join-Path $RepoRoot "scripts/report-downdetector.ps1")

Assert-True ($null -ne (Get-Command Test-BadForDowndetector -ErrorAction SilentlyContinue)) `
    "Test-BadForDowndetector is available after dot-sourcing publish-data.ps1"
Assert-True ($null -ne (Get-Command Get-BadLinesLastHour -ErrorAction SilentlyContinue)) `
    "Get-BadLinesLastHour is available after dot-sourcing publish-data.ps1"
Assert-True ($null -ne (Get-Command Get-DowndetectorPayload -ErrorAction SilentlyContinue)) `
    "Get-DowndetectorPayload is available after dot-sourcing report-downdetector.ps1"

$now = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$recent = $now - 60
$old = $now - 7200

$successHigh = "{0}`t8.8.8.8`tgoogle.com`t1500" -f $recent
$successEdge = "{0}`t8.8.8.8`tgoogle.com`t1000" -f $recent
$successLow = "{0}`t8.8.8.8`tgoogle.com`t42" -f $recent
$successEmpty = "{0}`t8.8.8.8`tgoogle.com`t" -f $recent
$dnsTimeout = "{0}`t8.8.8.8`tgoogle.com`t60000`tdns_timeout" -f $recent
$jobTimeout = "{0}`t8.8.8.8`tgoogle.com`t70000`tjob_timeout" -f $recent
$noResponse = "{0}`t8.8.8.8`tgoogle.com`t50`tno_response" -f $recent
$noResponseSlow = "{0}`t8.8.8.8`tgoogle.com`t60000`tno_response" -f $recent
$oldHigh = "{0}`t8.8.8.8`tgoogle.com`t3000" -f $old
$malformed = "{0}`t8.8.8.8`tgoogle.com" -f $recent

Write-Host "=== Test-BadForDowndetector ==="
Assert-True (Test-BadForDowndetector -Line $successHigh) "success line with latency>=threshold is reportable"
Assert-True (Test-BadForDowndetector -Line $successEdge) "success line at exactly the threshold is reportable"
Assert-True (-not (Test-BadForDowndetector -Line $successLow)) "success line below threshold is not reportable"
Assert-True (-not (Test-BadForDowndetector -Line $successEmpty)) "success line with empty latency is not reportable"
Assert-True (Test-BadForDowndetector -Line $dnsTimeout) "dns_timeout is reportable"
Assert-True (Test-BadForDowndetector -Line $jobTimeout) "job_timeout is reportable"
Assert-True (Test-BadForDowndetector -Line $noResponseSlow) "non-timeout error with high latency is reportable"
Assert-True (-not (Test-BadForDowndetector -Line $noResponse)) "non-timeout error with low latency is not reportable"
Assert-True (-not (Test-BadForDowndetector -Line $malformed)) "malformed line is not reportable"
Assert-True (-not (Test-BadForDowndetector -Line $successHigh -LatencyThreshold 2000)) "threshold is honoured (2000ms)"

Write-Host "=== Get-BadLinesLastHour ==="
$bad = @(Get-BadLinesLastHour -Lines @($successHigh, $successLow, $jobTimeout, $noResponse, $oldHigh) -LatencyThreshold 1000)
Assert-True ($bad.Count -eq 2) "only recent bad records are kept (got $($bad.Count))"
Assert-True ($bad -contains $successHigh) "recent high-latency success line is kept"
Assert-True ($bad -contains $jobTimeout) "recent timeout is kept"
Assert-True ($bad -notcontains $oldHigh) "old high-latency line (>1h) is dropped"
Assert-True ($bad -notcontains $successLow) "recent healthy line is dropped"

Write-Host "=== Get-DowndetectorPayload ==="
$mixed = Get-DowndetectorPayload -Service "J:COM" -BadLines @($successHigh, $jobTimeout)
Assert-True ($mixed.service -eq "J:COM") "payload keeps the service name"
Assert-True ($mixed.problem_type -eq "timeout") "any timeout makes problem_type=timeout"
Assert-True ($mixed.count -eq 2) "payload counts all bad lines"
Assert-True ($mixed.timeout_count -eq 1) "payload counts timeout lines"

$latencyOnly = Get-DowndetectorPayload -Service "J:COM" -BadLines @($successHigh, $successEdge)
Assert-True ($latencyOnly.problem_type -eq "high_latency") "no timeout -> problem_type=high_latency"
Assert-True ($latencyOnly.timeout_count -eq 0) "no timeout -> timeout_count=0"

$emptyPayload = Get-DowndetectorPayload -Service "J:COM" -BadLines @()
Assert-True ($emptyPayload.count -eq 0) "empty input yields count=0"

Write-Host "=== rate limit ==="
$stateDir = Join-Path $env:TEMP ("ddtest-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$stateFile = Join-Path $stateDir ".last-downdetector-report"
try {
    Assert-True (Test-DowndetectorRateLimit -StateFile $stateFile) "no state file -> allowed"
    Set-DowndetectorReportState -StateFile $stateFile
    Assert-True (-not (Test-DowndetectorRateLimit -StateFile $stateFile)) "just recorded -> rate limited"
    Assert-True (Test-DowndetectorRateLimit -StateFile $stateFile -MinIntervalSec 0) "min interval 0 -> allowed"

    $stale = $now - 1900
    [System.IO.File]::WriteAllText($stateFile, "$stale")
    Assert-True (Test-DowndetectorRateLimit -StateFile $stateFile) "stale state (>30m) -> allowed"

    [System.IO.File]::WriteAllText($stateFile, "not-a-number")
    Assert-True (Test-DowndetectorRateLimit -StateFile $stateFile) "corrupt state -> allowed"
}
finally {
    Remove-Item -LiteralPath $stateDir -Force -Recurse -ErrorAction SilentlyContinue
}

Write-Host "=== Send-DowndetectorReport (dry run) ==="
$sent = Send-DowndetectorReport -Payload $mixed -ReportUrl "https://example.invalid/report" -DryRun
Assert-True ($sent) "dry run does not POST but reports success"
$noUrl = Send-DowndetectorReport -Payload $mixed -ReportUrl ""
Assert-True ($noUrl) "no report URL -> record-only success"

if ($failed -gt 0) {
    throw "$failed assertion(s) failed"
}
Write-Host "Test-DowndetectorReporting: all checks passed"
