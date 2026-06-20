#Requires -Version 5.1

function Get-MonitorConfig {
    $RepoRoot = Split-Path $PSScriptRoot -Parent
    Push-Location $RepoRoot
    try {
        $output = npm run read-config --silent 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "read-config failed: $output"
        }
        return $output | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
}