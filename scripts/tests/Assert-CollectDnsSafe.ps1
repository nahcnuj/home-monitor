#Requires -Version 5.1
<#
.SYNOPSIS
  Static checks: collect-dns.ps1 nslookup invocation matches the supported contract.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$Collect = Join-Path $RepoRoot "scripts/collect-dns.ps1"

if (-not (Test-Path $Collect)) {
    throw "collect-dns.ps1 not found at $Collect"
}

$src = Get-Content $Collect -Raw
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

Assert-True ($src -match 'nslookup\.exe') `
    "collect-dns.ps1 invokes nslookup.exe"

Assert-True ($src -match 'LookupTimeoutSec|lookup_timeout_sec') `
    "collect-dns.ps1 uses configured lookup timeout"

$invokeBlock = [regex]::Match(
    $src,
    '(?s)\$output\s*=\s*&\s*nslookup\.exe\s*(.+?)\s*2>&1'
)
Assert-True $invokeBlock.Success "collect-dns.ps1 has nslookup.exe invocation assigning `$output"
if ($invokeBlock.Success) {
    $invoke = $invokeBlock.Groups[1].Value
    Assert-True ($invoke -match '-timeout=') "nslookup invocation includes -timeout="
    Assert-True ($invoke -match '-type=') "nslookup invocation includes -type="
    Assert-True ($invoke -notmatch '(?i)retry') "nslookup invocation does not set -retry"
}

if ($failed -gt 0) {
    throw "$failed assertion(s) failed"
}
Write-Host "Assert-CollectDnsSafe: all checks passed"
