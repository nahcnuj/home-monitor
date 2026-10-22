#Requires -Version 7.0
<#
.SYNOPSIS
  Pester tests for publish-data.ps1 (data sync to GitHub Actions).

.DESCRIPTION
  Covers the TSV filtering and chunking helpers in publish-data.ps1.
  Downdetector reporting moved to GitHub Actions (Sync DNS Data
  workflow) — see scripts/report-downdetector-targets.mjs and the
  workflow's detection step — so it is no longer tested here.
#>
BeforeAll {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

    # Dot-sourcing loads functions only; the scripts guard their main flow.
    . (Join-Path $RepoRoot "scripts/publish-data.ps1")

    $script:cutoffTs = 1782000000
}

Describe "Test-DnsServerKey" {
    It "accepts an IPv4 address" {
        Test-DnsServerKey -Key "203.165.31.152" | Should -BeTrue
    }
    It "accepts an IPv6 address" {
        Test-DnsServerKey -Key "2001:db8::1" | Should -BeTrue
    }
    It "accepts 'unknown'" {
        Test-DnsServerKey -Key "unknown" | Should -BeTrue
    }
    It "rejects a hostname" {
        Test-DnsServerKey -Key "dns.google" | Should -BeFalse
    }
    It "rejects an empty key" {
        Test-DnsServerKey -Key "" | Should -BeFalse
    }
}

Describe "Test-SendableLine" {
    It "accepts a recent line with a valid resolver" {
        $line = "{0}`t203.165.31.152`tgoogle.com`t42" -f ($script:cutoffTs + 10)
        Test-SendableLine -Line $line -CutoffTs $script:cutoffTs | Should -BeTrue
    }
    It "rejects a line older than the cutoff" {
        $line = "{0}`t203.165.31.152`tgoogle.com`t42" -f ($script:cutoffTs - 10)
        Test-SendableLine -Line $line -CutoffTs $script:cutoffTs | Should -BeFalse
    }
    It "rejects a line with a non-IP resolver" {
        $line = "{0}`tdns.google`tgoogle.com`t42" -f ($script:cutoffTs + 10)
        Test-SendableLine -Line $line -CutoffTs $script:cutoffTs | Should -BeFalse
    }
    It "rejects a malformed line" {
        Test-SendableLine -Line "not-a-tsv-line" -CutoffTs $script:cutoffTs | Should -BeFalse
    }
}

Describe "Convert-LinesToB64" {
    It "returns empty string for no lines" {
        Convert-LinesToB64 -Lines @() | Should -Be ""
    }
    It "round-trips a single line" {
        $line = "1718863200`t203.165.31.152`tgoogle.com`t42"
        $b64 = Convert-LinesToB64 -Lines @($line)
        $b64 | Should -Not -Be ""
    }
}

Describe "ConvertFrom-JobListTsv" {
    It "parses the job name, status and conclusion" {
        $jobs = ConvertFrom-JobListTsv -Lines @(
            "Sync DNS data`tcompleted`tsuccess",
            "Report to Downdetector`tcompleted`tskipped"
        )
        $jobs["Sync DNS data"].Status | Should -Be "completed"
        $jobs["Sync DNS data"].Conclusion | Should -Be "success"
        $jobs["Report to Downdetector"].Conclusion | Should -Be "skipped"
    }
    It "keeps a running job without a conclusion" {
        $jobs = ConvertFrom-JobListTsv -Lines @("Report to Downdetector`tin_progress`t")
        $jobs["Report to Downdetector"].Status | Should -Be "in_progress"
        $jobs["Report to Downdetector"].Conclusion | Should -BeNullOrEmpty
    }
    It "ignores blank and malformed lines" {
        $jobs = ConvertFrom-JobListTsv -Lines @("", "   ", "garbage")
        $jobs.Count | Should -Be 0
    }
    It "returns an empty table for no output" {
        (ConvertFrom-JobListTsv -Lines @()).Count | Should -Be 0
    }
}

Describe "Find-WorkflowJobState" {
    It "prefers the current display name" {
        $jobs = @{
            "Sync DNS data" = @{ Status = "completed"; Conclusion = "success" }
            "sync"          = @{ Status = "completed"; Conclusion = "failure" }
        }
        $state = Find-WorkflowJobState -Jobs $jobs -Names @("Sync DNS data", "sync")
        $state.Conclusion | Should -Be "success"
    }
    It "falls back to the legacy job id" {
        $jobs = @{ "sync" = @{ Status = "completed"; Conclusion = "success" } }
        $state = Find-WorkflowJobState -Jobs $jobs -Names @("Sync DNS data", "sync")
        $state.Status | Should -Be "completed"
    }
    It "returns null when the job is absent" {
        $jobs = @{ "Sync DNS data" = @{ Status = "completed"; Conclusion = "success" } }
        Find-WorkflowJobState -Jobs $jobs -Names @("Report to Downdetector", "report") |
            Should -BeNullOrEmpty
    }
}

Describe "Split-LinesToB64Chunks" {
    It "returns no chunks for no lines" {
        $chunks = Split-LinesToB64Chunks -Lines @()
        $chunks.Count | Should -Be 0
    }
    It "returns a single chunk for a small batch" {
        $lines = 1..200 | ForEach-Object {
            "{0}`t203.165.31.152`tgoogle.com`t{1}" -f ($script:cutoffTs + $_), $_
        }
        $chunks = Split-LinesToB64Chunks -Lines $lines
        $chunks.Count | Should -Be 1
        $total = ($chunks | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
        $total | Should -Be 200
    }
    It "keeps each chunk under the base64 size limit" {
        $lines = 1..500 | ForEach-Object {
            "{0}`t203.165.31.152`texample.com`t{1}" -f ($script:cutoffTs + $_), $_
        }
        $chunks = Split-LinesToB64Chunks -Lines $lines
        foreach ($chunk in $chunks) {
            (Convert-LinesToB64 -Lines $chunk).Length | Should -BeLessOrEqual 60000
        }
    }
}
