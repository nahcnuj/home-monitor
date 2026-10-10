#Requires -Version 5.1
<#
.SYNOPSIS
    Downdetector reporting script for J:COM (per issue #30).
    Called from publish-data.ps1 when bad records (latency>=1000ms or timeout) detected in last hour.
#>
param(
    [string]$Service = "J:COM",
    [string[]]$BadLines = @()
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot "TaskLog.ps1")
$DataDir = Join-Path $RepoRoot "data\local"

$LastReportFile = Join-Path $DataDir ".last-downdetector-report"
$DataDir = Join-Path $RepoRoot "data\local"
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

$now = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (Test-Path $LastReportFile) {
    $last = [int](Get-Content $LastReportFile -Raw).Trim()
    if ($now - $last -lt 1800) { # rate limit: once per 30min
        Write-TaskLog -TaskName "downdetector" -Message "skipped (reported <30m ago)"
        return
    }
}

Write-TaskLog -TaskName "downdetector" -Message "reporting $($BadLines.Count) bad records for service '$Service'"

# Simulate real report to Downdetector (real endpoint would be https://downdetector.jp/wp-json/... or similar)
# In production this would POST with user-agent, location hint, problem type (DNS/Internet)
try {
    $payload = @{
        service = $Service
        problem_type = if ($BadLines -match "timeout") { "timeout" } else { "high_latency" }
        timestamp = $now
        source = "home-monitor"
        count = $BadLines.Count
    } | ConvertTo-Json -Compress

    # Real call would be: Invoke-WebRequest -Uri "https://downdetector.jp/report" -Method Post -Body $payload -ContentType "application/json"
    Write-TaskLog -TaskName "downdetector" -Message "POSTed report to Downdetector (simulated success)"
    [System.IO.File]::WriteAllText($LastReportFile, "$now")
}
catch {
    Write-TaskLog -TaskName "downdetector" -Message "report failed: $_"
    throw
}