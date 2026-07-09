#Requires -Version 5.1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot
. (Join-Path $PSScriptRoot "Get-MonitorConfig.ps1")
. (Join-Path $PSScriptRoot "TaskLog.ps1")
$DataDir = Join-Path $RepoRoot "data\local"
$DataFile = Join-Path $DataDir "dns-latency.tsv"
$QueryTypeStateFile = Join-Path $DataDir ".query-type-state"
$DefaultTimeoutSec = 15

$ErrorPatterns = @(
    @{ code = "no_nameserver";  pattern = "Default servers are not available" },
    @{ code = "no_response";    pattern = "No response from server" },
    @{ code = "server_fail";    pattern = "Server failed" },
    @{ code = "refused";        pattern = "Query refused" },
    @{ code = "nxdomain";       pattern = "Non-existent domain" },
    @{ code = "no_record";      pattern = "No (internal type|address)" },
    @{ code = "resolver_error"; pattern = "Can't find server name for address" },
    @{ code = "dns_timeout";    pattern = "(timed-out|DNS request timed out)" }
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

function Get-DnsResolverAddresses {
    $skipPattern = "^(Loopback|vEthernet|isatap|Teredo|6to4|Bluetooth)"
    $addresses = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    foreach ($entry in Get-DnsClientServerAddress -AddressFamily IPv4) {
        if ($entry.InterfaceAlias -match $skipPattern) { continue }
        foreach ($addr in $entry.ServerAddresses) {
            if ($addr -and $addr -notmatch ":") {
                [void]$addresses.Add($addr)
            }
        }
    }

    return @($addresses | Sort-Object)
}

function Start-DnsLookupJob {
    param(
        [string]$Domain,
        [string]$QueryType,
        [string]$Resolver
    )

    return Start-Job -ScriptBlock {
        param($Domain, $QueryType, $Resolver)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $output = & nslookup.exe "-type=$QueryType" $Domain $Resolver 2>&1 | Out-String
        $sw.Stop()
        return @{
            LatencyMs = [int]$sw.ElapsedMilliseconds
            Output    = $output
        }
    } -ArgumentList $Domain, $QueryType, $Resolver
}

function Get-JobLatencyMs {
    param(
        $Payload,
        [System.Diagnostics.Stopwatch]$WallClock
    )

    if ($null -ne $Payload) {
        $raw = $null
        if ($Payload -is [hashtable] -or $Payload -is [System.Collections.IDictionary]) {
            if ($Payload.ContainsKey("LatencyMs")) { $raw = $Payload["LatencyMs"] }
            elseif ($Payload.ContainsKey("latencyMs")) { $raw = $Payload["latencyMs"] }
        }
        else {
            $raw = $Payload.LatencyMs
            if ($null -eq $raw) { $raw = $Payload.latencyMs }
        }
        if ($null -ne $raw) {
            $parsed = 0
            if ([int]::TryParse([string]$raw, [ref]$parsed) -and $parsed -gt 0) {
                return $parsed
            }
        }
    }

    if ($null -ne $WallClock -and $WallClock.ElapsedMilliseconds -gt 0) {
        return [int]$WallClock.ElapsedMilliseconds
    }
    return 0
}

function Wait-DnsLookupJobs {
    param(
        [array]$JobEntries,
        [int]$TimeoutSec
    )

    $results = New-Object System.Collections.Generic.List[object]
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)

    foreach ($entry in ($JobEntries | Sort-Object Key)) {
        $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
        if ($remaining -le 0) {
            $remaining = 0.01
        }

        $waitSw = [System.Diagnostics.Stopwatch]::StartNew()
        $completed = Wait-Job -Job $entry.Job -Timeout $remaining
        $waitSw.Stop()
        if (-not $completed) {
            Stop-Job -Job $entry.Job -ErrorAction SilentlyContinue
            $payload = Receive-Job -Job $entry.Job -ErrorAction SilentlyContinue
            Remove-Job -Job $entry.Job -Force -ErrorAction SilentlyContinue
            # Prefer measured wall-clock until the job was cut off; fall back to configured timeout.
            $latencyMs = Get-JobLatencyMs -Payload $payload -WallClock $waitSw
            if ($latencyMs -le 0) { $latencyMs = $TimeoutSec * 1000 }
            $results.Add([PSCustomObject]@{
                Key       = $entry.Key
                Ts        = [long]$entry.BatchTs
                Resolver  = $entry.Resolver
                Domain    = $entry.Domain
                LatencyMs = $latencyMs
                Error     = "job_timeout"
                Output    = ""
            })
            continue
        }

        $payload = Receive-Job -Job $entry.Job -ErrorAction SilentlyContinue
        Remove-Job -Job $entry.Job -Force -ErrorAction SilentlyContinue
        $latencyMs = Get-JobLatencyMs -Payload $payload -WallClock $waitSw
        $results.Add([PSCustomObject]@{
            Key       = $entry.Key
            Ts        = [long]$entry.BatchTs
            Resolver  = $entry.Resolver
            Domain    = $entry.Domain
            LatencyMs = $latencyMs
            Error     = $null
            Output    = if ($null -ne $payload) { [string]$payload.Output } else { "" }
        })
    }

    return $results
}

function Get-DnsError {
    param([string]$Output)
    foreach ($entry in $ErrorPatterns) {
        if ($Output -match $entry.pattern) { return $entry.code }
    }
    if ($Output -match '\*\*\*') { return "unknown" }
    return $null
}

function Add-FailureLine {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [long]$Ts,
        [string]$Resolver,
        [string]$Domain,
        [int]$LatencyMs,
        [string]$ErrorCode
    )

    if ($LatencyMs -gt 0) {
        $Lines.Add(("{0}`t{1}`t{2}`t{3}`t{4}" -f $Ts, $Resolver, $Domain, $LatencyMs, $ErrorCode))
    }
    else {
        $Lines.Add(("{0}`t{1}`t{2}`t`t{3}" -f $Ts, $Resolver, $Domain, $ErrorCode))
    }
}

function Test-DnsSuccess {
    param([string]$Output)
    $jaName = -join ([char]0x540D, [char]0x524D)
    $jaAddr = -join ([char]0x30A2, [char]0x30C9, [char]0x30EC, [char]0x30B9)
    $hasName = ($Output -match '(?m)^Name:\s') -or ($Output -match "(?m)^${jaName}:\s")
    $hasAddress = ($Output -match '(?m)^(Address|Addresses):\s') -or ($Output -match "(?m)^${jaAddr}:\s")
    return $hasName -and $hasAddress
}

try {
    $config = Get-MonitorConfig
}
catch {
    Write-TaskLog -TaskName "collect" -Message "failed: $_"
    throw
}
$timeoutSec = if ($null -ne $config.lookup_timeout_sec -and $config.lookup_timeout_sec -gt 0) {
    [int]$config.lookup_timeout_sec
} else {
    $DefaultTimeoutSec
}

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

$queryType = Get-QueryType
Set-Content -Path $QueryTypeStateFile -Value $queryType -NoNewline -Encoding UTF8
Clear-DnsClientCache -ErrorAction SilentlyContinue

# One resolver list for the whole batch; re-read only on the next scheduled run.
$resolvers = @(Get-DnsResolverAddresses)
if ($resolvers.Count -eq 0) {
    throw "No IPv4 DNS resolvers configured on active interfaces"
}

# Batch timestamp: when this measurement cycle starts (before parallel lookups).
$batchTs = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if ($batchTs -le 0) { throw "Invalid timestamp: $batchTs" }

$domains = @($config.domains | Sort-Object)
$jobEntries = New-Object System.Collections.Generic.List[object]
foreach ($resolver in $resolvers) {
    foreach ($domain in $domains) {
        $jobEntries.Add([PSCustomObject]@{
            Key      = ("{0}`0{1}" -f $resolver, $domain)
            Job      = (Start-DnsLookupJob -Domain $domain -QueryType $queryType -Resolver $resolver)
            BatchTs  = $batchTs
            Resolver = $resolver
            Domain   = $domain
        })
    }
}

$lookupResults = Wait-DnsLookupJobs -JobEntries $jobEntries -TimeoutSec $timeoutSec

$lines = New-Object System.Collections.Generic.List[string]
foreach ($result in ($lookupResults | Sort-Object Ts, Resolver, Domain)) {
    if ($result.Ts -le 0) { throw "Invalid timestamp: $($result.Ts)" }

    if ($result.Error -eq "job_timeout") {
        Add-FailureLine -Lines $lines -Ts $result.Ts -Resolver $result.Resolver -Domain $result.Domain `
            -LatencyMs $result.LatencyMs -ErrorCode $result.Error
        continue
    }

    $dnsError = Get-DnsError -Output $result.Output
    if ($dnsError) {
        Add-FailureLine -Lines $lines -Ts $result.Ts -Resolver $result.Resolver -Domain $result.Domain `
            -LatencyMs $result.LatencyMs -ErrorCode $dnsError
        continue
    }

    if (Test-DnsSuccess -Output $result.Output) {
        $lines.Add(("{0}`t{1}`t{2}`t{3}" -f $result.Ts, $result.Resolver, $result.Domain, $result.LatencyMs))
    }
    else {
        Add-FailureLine -Lines $lines -Ts $result.Ts -Resolver $result.Resolver -Domain $result.Domain `
            -LatencyMs $result.LatencyMs -ErrorCode "unknown"
    }
}

if ($lines.Count -gt 0) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $content = ($lines -join "`n") + "`n"
    if (Test-Path $DataFile) {
        [System.IO.File]::AppendAllText($DataFile, $content, $utf8NoBom)
    }
    else {
        [System.IO.File]::WriteAllText($DataFile, $content, $utf8NoBom)
    }
}