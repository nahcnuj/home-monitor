#Requires -Version 5.1

function Get-RepoRoot {
    return Split-Path $PSScriptRoot -Parent
}

function Get-NodeExe {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $fnmDefault = Join-Path $env:APPDATA "fnm\aliases\default\node.exe"
    if (Test-Path $fnmDefault) { return $fnmDefault }

    $programFiles = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $programFiles) { return $programFiles }

    throw "node.exe not found. Install Node.js or fnm."
}

function Get-GhExe {
    $cmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $ghPath = Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"
    if (Test-Path $ghPath) { return $ghPath }

    throw "gh not found. Install GitHub CLI."
}

function Get-MonitorConfig {
    $repoRoot = Get-RepoRoot
    $tsxCli = Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"
    if (-not (Test-Path $tsxCli)) {
        throw "tsx not found. Run npm install in $repoRoot"
    }

    $node = Get-NodeExe
    $readConfig = Join-Path $repoRoot "scripts\read-config.ts"
    $output = & $node $tsxCli $readConfig 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "read-config failed: $output"
    }

    return ($output | Out-String).Trim() | ConvertFrom-Json
}