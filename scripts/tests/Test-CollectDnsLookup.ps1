#Requires -Version 5.1
<#
.SYNOPSIS
  Run the real Start-DnsLookupJob from collect-dns.ps1 on Windows and expect success.

  Regression intent (same test code against historical collect-dns.ps1):
  - pre-bug / fixed: Start-DnsLookupJob resolves → pass
  - broken (-retry=0 on nslookup): job output is not success → fail

  Does not hardcode nslookup flags; only calls production functions.
#>
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
    Write-Host "Skip: not Windows"
    exit 0
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$Collect = Join-Path $RepoRoot "scripts/collect-dns.ps1"
if (-not (Test-Path $Collect)) {
    throw "collect-dns.ps1 not found: $Collect"
}

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

# Load production functions only (main collection is skipped when dotted).
. $Collect

Assert-True ($null -ne (Get-Command Start-DnsLookupJob -ErrorAction SilentlyContinue)) `
    "Start-DnsLookupJob is available after dot-sourcing collect-dns.ps1"
Assert-True ($null -ne (Get-Command Test-DnsSuccess -ErrorAction SilentlyContinue)) `
    "Test-DnsSuccess is available after dot-sourcing collect-dns.ps1"
Assert-True ($null -ne (Get-Command Get-DnsError -ErrorAction SilentlyContinue)) `
    "Get-DnsError is available after dot-sourcing collect-dns.ps1"

# Public resolver: real network (no mock). Flags come only from Start-DnsLookupJob.
$domain = "google.com"
$resolver = "8.8.8.8"
$timeoutSec = 15

Write-Host "=== Invoke production Start-DnsLookupJob ==="
Write-Host "Domain=$domain Resolver=$resolver LookupTimeoutSec=$timeoutSec"

$job = Start-DnsLookupJob -Domain $domain -QueryType "A" -Resolver $resolver -LookupTimeoutSec $timeoutSec
$completed = Wait-Job -Job $job -Timeout ($timeoutSec + 30)
if (-not $completed) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    throw "Start-DnsLookupJob did not finish within timeout"
}

$payload = Receive-Job -Job $job -ErrorAction SilentlyContinue
Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

Assert-True ($null -ne $payload) "job returned a payload"
$output = if ($null -ne $payload) { [string]$payload.Output } else { "" }
$latencyMs = 0
if ($null -ne $payload) {
    if ($payload -is [hashtable] -or $payload -is [System.Collections.IDictionary]) {
        $latencyMs = [int]$payload["LatencyMs"]
    }
    else {
        $latencyMs = [int]$payload.LatencyMs
    }
}

$success = Test-DnsSuccess -Output $output
$dnsError = Get-DnsError -Output $output

Write-Host "LatencyMs=$latencyMs success=$success dnsError=$dnsError"
if (-not $success) {
    Write-Host "--- nslookup output (first 30 lines) ---"
    ($output -split "`n" | Select-Object -First 30) -join "`n" | Write-Host
}

Assert-True $success "production Start-DnsLookupJob result is classified as DNS success"
Assert-True (-not $dnsError) "production Start-DnsLookupJob result has no DNS error code (got: $dnsError)"
Assert-True ($latencyMs -gt 0) "production Start-DnsLookupJob recorded LatencyMs > 0"

if ($failed -gt 0) {
    throw "$failed assertion(s) failed"
}
Write-Host "Test-CollectDnsLookup: all checks passed"
