#Requires -Version 7.0
<#
.SYNOPSIS
  Pester tests for Downdetector reporting (issue #30).

.DESCRIPTION
  Covers the detection helpers in publish-data.ps1 and the payload/URL/rate-limit
  helpers in report-downdetector.ps1. No network access is required: the senders are
  exercised with a mocked Invoke-WebRequest (and a dry-run path), and the
  rate-limit state lives in a temp dir.

  The indicator POST and the report-beacon GET fallback are both covered, since
  Cloudflare rejects the POST from non-browser clients but accepts the beacon.

  Regression intent: a high-latency *success* line (4 columns) must be detected.
  The previous code required 5 columns and silently ignored success lines.
#>
BeforeAll {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

    # Dot-sourcing loads functions only; the scripts guard their main flow.
    . (Join-Path $RepoRoot "scripts/publish-data.ps1")
    . (Join-Path $RepoRoot "scripts/report-downdetector.ps1")

    $script:now = [long][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $script:recent = $script:now - 60
    $script:old = $script:now - 7200
    $script:serviceByResolver = @{ "8.8.8.8" = "J:COM" }

    $script:successHigh = "{0}`t8.8.8.8`tgoogle.com`t1500" -f $script:recent
    $script:successEdge = "{0}`t8.8.8.8`tgoogle.com`t1000" -f $script:recent
    $script:successLow = "{0}`t8.8.8.8`tgoogle.com`t42" -f $script:recent
    $script:successEmpty = "{0}`t8.8.8.8`tgoogle.com`t" -f $script:recent
    $script:unknownResolverHigh = "{0}`t9.9.9.9`tgoogle.com`t1500" -f $script:recent
    $script:dnsTimeout = "{0}`t8.8.8.8`tgoogle.com`t60000`tdns_timeout" -f $script:recent
    $script:jobTimeout = "{0}`t8.8.8.8`tgoogle.com`t70000`tjob_timeout" -f $script:recent
    $script:noResponse = "{0}`t8.8.8.8`tgoogle.com`t50`tno_response" -f $script:recent
    $script:noResponseSlow = "{0}`t8.8.8.8`tgoogle.com`t60000`tno_response" -f $script:recent
    $script:oldHigh = "{0}`t8.8.8.8`tgoogle.com`t3000" -f $script:old
    $script:malformed = "{0}`t8.8.8.8`tgoogle.com" -f $script:recent
}

Describe "Test-BadForDowndetector" {
    It "reports a success line with latency >= threshold" {
        Test-BadForDowndetector -Line $successHigh | Should -BeTrue
    }
    It "reports a success line at exactly the threshold" {
        Test-BadForDowndetector -Line $successEdge | Should -BeTrue
    }
    It "ignores a success line below the threshold" {
        Test-BadForDowndetector -Line $successLow | Should -BeFalse
    }
    It "ignores a success line with empty latency" {
        Test-BadForDowndetector -Line $successEmpty | Should -BeFalse
    }
    It "reports dns_timeout" {
        Test-BadForDowndetector -Line $dnsTimeout | Should -BeTrue
    }
    It "reports job_timeout" {
        Test-BadForDowndetector -Line $jobTimeout | Should -BeTrue
    }
    It "reports a non-timeout error with high latency" {
        Test-BadForDowndetector -Line $noResponseSlow | Should -BeTrue
    }
    It "ignores a non-timeout error with low latency" {
        Test-BadForDowndetector -Line $noResponse | Should -BeFalse
    }
    It "ignores a malformed line" {
        Test-BadForDowndetector -Line $malformed | Should -BeFalse
    }
    It "honours a custom threshold (2000ms)" {
        Test-BadForDowndetector -Line $successHigh -LatencyThreshold 2000 | Should -BeFalse
    }
}

Describe "Get-LineDowndetectorService" {
    It "maps a known resolver to its service" {
        Get-LineDowndetectorService -Line $successHigh -ServiceByResolver $serviceByResolver | Should -Be "J:COM"
    }
    It "returns nothing for an unknown resolver" {
        Get-LineDowndetectorService -Line $unknownResolverHigh -ServiceByResolver $serviceByResolver | Should -BeNullOrEmpty
    }
}

Describe "Get-BadLinesLastHour" {
    BeforeAll {
        $script:bad = @(Get-BadLinesLastHour -Lines @(
                $successHigh, $successLow, $jobTimeout, $noResponse, $oldHigh, $unknownResolverHigh
            ) -ServiceByResolver $serviceByResolver -LatencyThreshold 1000)
    }
    It "keeps only recent bad records for known resolvers" {
        $bad.Count | Should -Be 2
    }
    It "keeps a recent high-latency success line" {
        $bad | Should -Contain $successHigh
    }
    It "keeps a recent timeout" {
        $bad | Should -Contain $jobTimeout
    }
    It "drops an old high-latency line (>1h)" {
        $bad | Should -Not -Contain $oldHigh
    }
    It "drops a recent healthy line" {
        $bad | Should -Not -Contain $successLow
    }
    It "drops a bad line from an unmapped resolver" {
        $bad | Should -Not -Contain $unknownResolverHigh
    }
}

Describe "Get-DowndetectorPayload" {
    It "keeps the service name and counts bad/timeout lines" {
        $mixed = Get-DowndetectorPayload -Service "J:COM" -BadLines @($successHigh, $jobTimeout)
        $mixed.service | Should -Be "J:COM"
        $mixed.problem_type | Should -Be "timeout"
        $mixed.count | Should -Be 2
        $mixed.timeout_count | Should -Be 1
    }
    It "uses high_latency when there is no timeout" {
        $latencyOnly = Get-DowndetectorPayload -Service "J:COM" -BadLines @($successHigh, $successEdge)
        $latencyOnly.problem_type | Should -Be "high_latency"
        $latencyOnly.timeout_count | Should -Be 0
    }
    It "counts zero for empty input" {
        (Get-DowndetectorPayload -Service "J:COM" -BadLines @()).count | Should -Be 0
    }
}

Describe "Test-DowndetectorRateLimit" {
    BeforeAll {
        $script:stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ddtest-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:stateDir -Force | Out-Null
        $script:stateFile = Join-Path $script:stateDir ".last-downdetector-report"
    }
    AfterAll {
        Remove-Item -LiteralPath $script:stateDir -Force -Recurse -ErrorAction SilentlyContinue
    }
    It "allows when there is no state file" {
        Test-DowndetectorRateLimit -StateFile $stateFile | Should -BeTrue
    }
    It "blocks right after a report is recorded" {
        Set-DowndetectorReportState -StateFile $stateFile
        Test-DowndetectorRateLimit -StateFile $stateFile | Should -BeFalse
    }
    It "allows when the min interval is 0" {
        Test-DowndetectorRateLimit -StateFile $stateFile -MinIntervalSec 0 | Should -BeTrue
    }
    It "allows a stale state (>30m)" {
        [System.IO.File]::WriteAllText($stateFile, "$($script:now - 1900)")
        Test-DowndetectorRateLimit -StateFile $stateFile | Should -BeTrue
    }
    It "allows a corrupt state" {
        [System.IO.File]::WriteAllText($stateFile, "not-a-number")
        Test-DowndetectorRateLimit -StateFile $stateFile | Should -BeTrue
    }
}

Describe "Get-DowndetectorHeaders" {
    It "derives Origin and Referer from the status page URL" {
        $h = Get-DowndetectorHeaders -PageUrl "https://downdetector.jp/shougai/jcom/"
        $h["Origin"] | Should -Be "https://downdetector.jp"
        $h["Referer"] | Should -Be "https://downdetector.jp/shougai/jcom/"
    }
    It "omits Origin/Referer when there is no page URL" {
        $h = Get-DowndetectorHeaders -PageUrl ""
        $h.ContainsKey("Origin") | Should -BeFalse
        $h.ContainsKey("Accept") | Should -BeTrue
    }
}

Describe "New-DowndetectorIndicatorUri" {
    It "builds the data-api indicator URL used by the report button" {
        $uri = New-DowndetectorIndicatorUri -DataApiUrl "https://data-api.downdetector.com" `
            -CompanyId "33478" -IndicatorId 11 -ViewToken "abc.def"
        $uri | Should -Be "https://data-api.downdetector.com/v1/companies/33478/indicators?indicator=v2&i=11&vt=abc.def"
    }
    It "escapes the view token" {
        $uri = New-DowndetectorIndicatorUri -DataApiUrl "https://x" -CompanyId "1" `
            -IndicatorId 11 -ViewToken "a b"
        $uri | Should -Be "https://x/v1/companies/1/indicators?indicator=v2&i=11&vt=a%20b"
    }
}

Describe "Send-DowndetectorReport" {
    It "does not POST in dry-run but reports success" {
        Send-DowndetectorReport -IndicatorUri "https://example.invalid/x" -DryRun | Should -BeTrue
    }
    It "POSTs to the indicator URI without a body" {
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
        Send-DowndetectorReport -IndicatorUri "https://example.invalid/x" -Headers @{ Accept = "application/json" } | Should -BeTrue
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'Post' -and $Uri -eq "https://example.invalid/x"
        }
    }
    It "returns false when the endpoint is rate limited (Cloudflare)" {
        Mock Invoke-WebRequest { throw "error code: 1015" }
        Send-DowndetectorReport -IndicatorUri "https://example.invalid/x" | Should -BeFalse
    }
}

Describe "Get-DowndetectorReportBeaconUri" {
    It "builds the status-page report beacon URL" {
        $uri = Get-DowndetectorReportBeaconUri -DataApiUrl "https://data-api.downdetector.com" `
            -CompanyId "33478" -PageUrl "https://downdetector.jp/shougai/jcom/"
        $uri | Should -Be "https://data-api.downdetector.com/v1/companies/33478/report?ref=https%3A%2F%2Fdowndetector.jp%2Fshougai%2Fjcom%2F"
    }
    It "leaves an empty ref when there is no page URL" {
        $uri = Get-DowndetectorReportBeaconUri -DataApiUrl "https://x" -CompanyId "1" -PageUrl ""
        $uri | Should -Be "https://x/v1/companies/1/report?ref="
    }
}

Describe "Send-DowndetectorVisitBeacon" {
    It "does not send in dry-run but reports success" {
        Send-DowndetectorVisitBeacon -BeaconUri "https://example.invalid/report" -DryRun | Should -BeTrue
    }
    It "GETs the beacon URI" {
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
        Send-DowndetectorVisitBeacon -BeaconUri "https://example.invalid/report" | Should -BeTrue
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'Get' -and $Uri -eq "https://example.invalid/report"
        }
    }
    It "returns false when the beacon is rejected" {
        Mock Invoke-WebRequest { throw "error code: 1015" }
        Send-DowndetectorVisitBeacon -BeaconUri "https://example.invalid/report" | Should -BeFalse
    }
}
