#Requires -Version 5.1
<#
.SYNOPSIS
  Windows live regression tests for nslookup flags used by home-monitor collect.
  Requires network access (public resolver 8.8.8.8).
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
    # Quote nothing; our args have no spaces.
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

function Get-NslookupKind {
    param([string]$Text)

    if ($Text -match "No response from server") { return "NO_RESPONSE" }
    if ($Text -match "timed-out|DNS request timed out|(?i)request timed out") { return "TIMEOUT" }

    # Locale-robust success: answer address list (IPv4/IPv6) after a successful query.
    # Server banner also has "Address:" — require multiple address-like tokens or Addresses:
    if ($Text -match "(?im)^Addresses?:\s+\S+") { return "OK" }
    $ipv4 = [regex]::Matches($Text, "(?m)(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
    # Successful A lookup typically prints resolver Address + at least one answer Address
    if ($ipv4.Count -ge 2 -and $Text -notmatch "No response") { return "OK" }

    $jaName = -join ([char]0x540D, [char]0x524D) # 名前
    if ($Text -match "(?m)^Name:\s" -or $Text -match "(?m)^${jaName}:\s") {
        if ($ipv4.Count -ge 1 -or $Text -match "(?im)^Addresses?:") { return "OK" }
    }
    return "OTHER"
}

Write-Host "=== Live nslookup regressions ==="

$textZero = Get-NslookupText -ArgumentList @("-timeout=5", "-retry=0", "google.com", "8.8.8.8")
$textOk = Get-NslookupText -ArgumentList @("-timeout=5", "google.com", "8.8.8.8")
$textCollect = Get-NslookupText -ArgumentList @("-timeout=60", "-type=A", "google.com", "8.8.8.8")

$kindZero = Get-NslookupKind -Text $textZero
$kindOk = Get-NslookupKind -Text $textOk
$kindCollect = Get-NslookupKind -Text $textCollect

Write-Host "nslookup -timeout=5 -retry=0 google.com 8.8.8.8  -> $kindZero"
Write-Host "nslookup -timeout=5 google.com 8.8.8.8           -> $kindOk"
Write-Host "nslookup -timeout=60 -type=A google.com 8.8.8.8  -> $kindCollect"

if ($kindZero -ne "NO_RESPONSE") {
    Write-Host "--- -retry=0 output (first 20 lines) ---"
    ($textZero -split "`n" | Select-Object -First 20) -join "`n" | Write-Host
}
if ($kindOk -ne "OK") {
    Write-Host "--- baseline output (first 20 lines) ---"
    ($textOk -split "`n" | Select-Object -First 20) -join "`n" | Write-Host
}

Assert-True ($kindZero -eq "NO_RESPONSE") `
    "Windows nslookup -retry=0 must yield NO_RESPONSE (documents platform bug that flooded production)"

Assert-True ($kindOk -eq "OK") `
    "Windows nslookup without -retry=0 must succeed against 8.8.8.8"

Assert-True ($kindCollect -eq "OK") `
    "collect-style args (-timeout=N -type=A host server) must succeed"

Assert-True ($textCollect -notmatch "No response from server") `
    "collect-style invocation must not contain No response from server"

# Same static guards on Windows runner
& (Join-Path $PSScriptRoot "Assert-CollectDnsSafe.ps1")

if ($failed -gt 0) {
    throw "$failed assertion(s) failed"
}
Write-Host "Test-NslookupWindows: all checks passed"
