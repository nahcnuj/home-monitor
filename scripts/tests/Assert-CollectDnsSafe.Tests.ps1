#Requires -Version 7.0
<#
.SYNOPSIS
  Static check: collect-dns.ps1 must not pass -retry=0 to nslookup (known-bad on Windows).
#>
BeforeAll {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
    $Collect = Join-Path $RepoRoot "scripts/collect-dns.ps1"
    if (-not (Test-Path $Collect)) {
        throw "collect-dns.ps1 not found at $Collect"
    }
    $script:src = Get-Content -LiteralPath $Collect -Raw
    $script:invokeBlock = [regex]::Match(
        $script:src,
        '(?s)\$output\s*=\s*&\s*nslookup\.exe\s*(.+?)\s*2>&1'
    )
}

Describe "collect-dns.ps1 nslookup safety" {
    It "has an nslookup.exe invocation" {
        $invokeBlock.Success | Should -BeTrue
    }
    It "does not pass -retry=0 to the nslookup call" {
        $invokeBlock.Success | Should -BeTrue
        if ($invokeBlock.Success) {
            $invokeBlock.Groups[1].Value -notmatch '(?i)-retry\s*=\s*0' | Should -BeTrue
        }
    }
    It "does not contain a quoted -retry=0 argument" {
        $src -notmatch '(?i)["'']-retry=0["'']' | Should -BeTrue
    }
}
