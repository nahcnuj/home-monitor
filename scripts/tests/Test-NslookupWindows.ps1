#Requires -Version 5.1
<#
.SYNOPSIS
  Windows live check: collect-dns.ps1-style nslookup args actually resolve.
#>
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
    Write-Host "Skip: not Windows"
    exit 0
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

function Get-NslookupText {
    param([Parameter(Mandatory = $true)][string[]]$ArgumentList)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:SystemRoot\System32\nslookup.exe"
    $psi.Arguments = ($ArgumentList -join " ")
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::GetEncoding(0)
    $psi.StandardErrorEncoding = [System.Text.Encoding]::GetEncoding(0)

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    if (-not $proc.WaitForExit(60000)) {
        try { $proc.Kill() } catch { }
        throw "nslookup timed out: $($ArgumentList -join ' ')"
    }
    return ($stdout + "`n" + $stderr)
}

function Test-NslookupLooksSuccessful {
    param([string]$Text)
    if ($Text -match "(?im)^Addresses?:\s+\S+") { return $true }
    $ipv4 = [regex]::Matches($Text, "(?m)(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
    if ($ipv4.Count -ge 2) { return $true }
    $jaName = -join ([char]0x540D, [char]0x524D)
    if (($Text -match "(?m)^Name:\s" -or $Text -match "(?m)^${jaName}:\s") -and $ipv4.Count -ge 1) {
        return $true
    }
    return $false
}

Write-Host "=== collect-style nslookup must work on Windows ==="

# Same shape as scripts/collect-dns.ps1 (timeout + type + domain + resolver).
$args = @("-timeout=60", "-type=A", "google.com", "8.8.8.8")
$text = Get-NslookupText -ArgumentList $args
$ok = Test-NslookupLooksSuccessful -Text $text
Write-Host ("nslookup {0} -> success={1}" -f ($args -join " "), $ok)
if (-not $ok) {
    Write-Host "--- output (first 25 lines) ---"
    ($text -split "`n" | Select-Object -First 25) -join "`n" | Write-Host
}

Assert-True $ok "collect-style nslookup (-timeout=N -type=A host server) resolves successfully"

& (Join-Path $PSScriptRoot "Assert-CollectDnsSafe.ps1")

if ($failed -gt 0) {
    throw "$failed assertion(s) failed"
}
Write-Host "Test-NslookupWindows: all checks passed"
