#Requires -Version 5.1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$ConfigPath = Join-Path $RepoRoot "config\monitor.json"
$DataDir = Join-Path $RepoRoot "data\local"
$DataFile = Join-Path $DataDir "dns-latency.tsv"
$QueryTypeStateFile = Join-Path $DataDir ".query-type-state"
$TimeoutSec = 60

$ErrorPatterns = @(
    @{ code = "no_nameserver";  pattern = "Default servers are not available" },
    @{ code = "no_response";    pattern = "No response from server" },
    @{ code = "server_fail";    pattern = "Server failed" },
    @{ code = "refused";        pattern = "Query refused" },
    @{ code = "nxdomain";       pattern = "Non-existent domain" },
    @{ code = "no_record";      pattern = "No (internal type|address)" },
    @{ code = "resolver_error"; pattern = "Can't find server name for address" },
    @{ code = "timeout";        pattern = "(timed-out|DNS request timed out)" }
)

function Get-QueryType {
    $types = @("A", "AAAA")
    if (Test-Path $QueryTypeStateFile) {
        $last = Get-Content $QueryTypeStateFile -Raw
        $idx = [array]::IndexOf($types, $last.Trim())
        if ($idx -ge 0) { return $types[($idx + 1) % $types.Length] }
    }
    return $types[0]
}

function Invoke-DnsLookup {
    param([string]$Domain, [string]$QueryType)

    $job = Start-Job -ScriptBlock {
        param($Domain, $QueryType)
        & nslookup.exe "-type=$QueryType" $Domain 2>&1 | Out-String
    } -ArgumentList $Domain, $QueryType

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $completed = Wait-Job -Job $job -Timeout $TimeoutSec
    $sw.Stop()

    if (-not $completed) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        return @{ LatencyMs = $null; Error = "timeout"; Output = "" }
    }

    $output = Receive-Job -Job $job -ErrorAction SilentlyContinue | Out-String
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    return @{ LatencyMs = [int]$sw.ElapsedMilliseconds; Error = $null; Output = $output }
}

function Get-DnsError {
    param([string]$Output)
    foreach ($entry in $ErrorPatterns) {
        if ($Output -match $entry.pattern) { return $entry.code }
    }
    if ($Output -match '\*\*\*') { return "unknown" }
    return $null
}

function Test-DnsSuccess {
    param([string]$Output)
    return ($Output -match '(?m)^Name:\s') -and ($Output -match '(?m)^(Address|Addresses):')
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

$queryType = Get-QueryType
Set-Content -Path $QueryTypeStateFile -Value $queryType -NoNewline -Encoding UTF8
Clear-DnsClientCache -ErrorAction SilentlyContinue

$ts = [int][double]::Parse(
    (Get-Date -AsUTC).Subtract((Get-Date "1970-01-01Z")).TotalSeconds,
    [System.Globalization.CultureInfo]::InvariantCulture
)

$lines = New-Object System.Collections.Generic.List[string]
foreach ($domain in $config.domains) {
    $result = Invoke-DnsLookup -Domain $domain -QueryType $queryType

    if ($result.Error -eq "timeout") {
        $lines.Add("$ts`t$domain`t`t$($result.Error)")
        continue
    }

    $dnsError = Get-DnsError -Output $result.Output
    if ($dnsError) {
        $lines.Add("$ts`t$domain`t`t$dnsError")
        continue
    }

    if (Test-DnsSuccess -Output $result.Output) {
        $lines.Add("$ts`t$domain`t$($result.LatencyMs)")
    }
    else {
        $lines.Add("$ts`t$domain`t`tunknown")
    }
}

if ($lines.Count -gt 0) {
    Add-Content -Path $DataFile -Value ($lines -join "`n") -Encoding UTF8
}