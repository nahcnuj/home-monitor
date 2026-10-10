#Requires -Version 5.1
<#
.SYNOPSIS
  Run every test script under scripts/tests and fail if any of them fails.

.DESCRIPTION
  Single CI entry point so new test scripts are picked up automatically. Each
  test runs in its own script scope via the call operator; a test that calls
  exit / throws (e.g. Test-CollectDnsLookup.ps1 self-skips on non-Windows)
  only affects its own scope, not the runner.
#>
$ErrorActionPreference = "Stop"
$testsDir = $PSScriptRoot
$testFiles = @(Get-ChildItem -Path $testsDir -Filter "*.ps1" | Sort-Object Name)
$failed = New-Object System.Collections.Generic.List[string]

foreach ($file in $testFiles) {
    if ($file.Name -eq "Invoke-AllTests.ps1") { continue }
    Write-Host ""
    Write-Host "=== $($file.Name) ==="
    $global:LASTEXITCODE = 0
    try {
        & $file.FullName
        if ($LASTEXITCODE -ne 0) {
            $failed.Add($file.Name)
        }
    }
    catch {
        Write-Host "FAIL $($_.Exception.Message)"
        $failed.Add($file.Name)
    }
}

Write-Host ""
if ($failed.Count -gt 0) {
    throw "failed tests: $($failed -join ', ')"
}
Write-Host "Invoke-AllTests: all tests passed"