#Requires -Version 5.1
<#
.SYNOPSIS
  Static check: collect-dns.ps1 must not pass -retry=0 to nslookup (known-bad on Windows).
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

$invokeBlock = [regex]::Match(
    $src,
    '(?s)\$output\s*=\s*&\s*nslookup\.exe\s*(.+?)\s*2>&1'
)
Assert-True $invokeBlock.Success "collect-dns.ps1 has nslookup.exe invocation"
if ($invokeBlock.Success) {
    $invoke = $invokeBlock.Groups[1].Value
    Assert-True ($invoke -notmatch '(?i)-retry\s*=\s*0') `
        "Start-DnsLookupJob nslookup call must not pass -retry=0"
}

Assert-True ($src -notmatch '(?i)["'']-retry=0["'']') `
    "collect-dns.ps1 must not contain quoted -retry=0 argument"

if ($failed -gt 0) {
    throw "$failed assertion(s) failed"
}
Write-Host "Assert-CollectDnsSafe: all checks passed"
