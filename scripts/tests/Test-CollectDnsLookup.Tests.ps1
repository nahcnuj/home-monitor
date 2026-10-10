#Requires -Version 7.0
<#
.SYNOPSIS
  Run the real Start-DnsLookupJob from collect-dns.ps1 on Windows and expect success.

  Regression intent (same test code against historical collect-dns.ps1):
  - pre-bug / fixed: Start-DnsLookupJob resolves → pass
  - broken (-retry=0 on nslookup): job output is not success → fail

  Does not hardcode nslookup flags; only calls production functions.
#>
if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
    Write-Host "Skip: not Windows"
    return
}

BeforeAll {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
    $Collect = Join-Path $RepoRoot "scripts/collect-dns.ps1"
    if (-not (Test-Path $Collect)) {
        throw "collect-dns.ps1 not found: $Collect"
    }

    # Load production functions only (main collection is skipped when dotted).
    . $Collect

    # Public resolver: real network (no mock). Flags come only from Start-DnsLookupJob.
    $script:domain = "google.com"
    $script:resolver = "8.8.8.8"
    $script:timeoutSec = 15

    $script:job = Start-DnsLookupJob -Domain $script:domain -QueryType "A" `
        -Resolver $script:resolver -LookupTimeoutSec $script:timeoutSec
    $script:completed = Wait-Job -Job $script:job -Timeout ($script:timeoutSec + 30)
    if ($script:completed) {
        $script:payload = Receive-Job -Job $script:job -ErrorAction SilentlyContinue
    }
    else {
        Stop-Job -Job $script:job -ErrorAction SilentlyContinue
    }
    Remove-Job -Job $script:job -Force -ErrorAction SilentlyContinue

    $script:output = if ($null -ne $script:payload) { [string]$script:payload.Output } else { "" }
    $script:latencyMs = 0
    if ($null -ne $script:payload) {
        if ($script:payload -is [hashtable] -or $script:payload -is [System.Collections.IDictionary]) {
            $script:latencyMs = [int]$script:payload["LatencyMs"]
        }
        else {
            $script:latencyMs = [int]$script:payload.LatencyMs
        }
    }
}

Describe "Start-DnsLookupJob (real nslookup)" {
    It "resolves within the timeout" {
        $completed | Should -BeTrue
    }
    It "returns a payload" {
        $null -ne $payload | Should -BeTrue
    }
    It "is classified as DNS success" {
        Test-DnsSuccess -Output $output | Should -BeTrue
    }
    It "has no DNS error code" {
        Get-DnsError -Output $output | Should -BeNullOrEmpty
    }
    It "records LatencyMs > 0" {
        $latencyMs | Should -BeGreaterThan 0
    }
}
