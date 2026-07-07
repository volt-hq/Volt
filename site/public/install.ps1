# Volt installer for Windows — https://volt-cli.dev
#
# Usage:
#   irm https://volt-cli.dev/install.ps1 | iex
#
# Installs the Volt coding agent globally via npm with lifecycle scripts
# disabled. Requires Node.js >= 22.19 (https://nodejs.org).

$ErrorActionPreference = "Stop"

$package = "@hansjm10/volt-cli"
$minNodeMajor = 22

function Fail($message) {
    Write-Host "volt install: $message" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js not found. Volt requires Node.js >= 22.19. Install it from https://nodejs.org, then re-run this script."
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $minNodeMajor) {
    Fail "Node.js $(node --version) is too old. Volt requires Node.js >= 22.19."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm not found. It normally ships with Node.js; install Node.js from https://nodejs.org."
}

Write-Host "Installing $package globally (lifecycle scripts disabled)..."
npm install -g --ignore-scripts $package
if ($LASTEXITCODE -ne 0) {
    Fail "npm install failed (exit code $LASTEXITCODE)"
}

Write-Host ""
if (Get-Command volt -ErrorAction SilentlyContinue) {
    Write-Host "Installed. Run 'volt' in a project directory to get started."
} else {
    $npmBin = npm prefix -g
    Write-Host "Installed, but '$npmBin' is not on your PATH. Add it and restart your terminal."
}
Write-Host "Windows setup notes: https://volt-cli.dev/docs/windows/"
Write-Host "Docs: https://volt-cli.dev/docs/quickstart/"
