# Volt installer for Windows — https://volt-cli.dev
#
# Usage:
#   irm https://volt-cli.dev/install.ps1 | iex
#
# Options (environment variables):
#   VOLT_INSTALL_METHOD=npm      Full Node.js install (default), including daemon/remote.
#   VOLT_INSTALL_METHOD=binary   Standalone local CLI/TUI only; no daemon/remote/iOS access.
#   VOLT_VERSION=latest          Install the npm beta channel (default) or latest binary.
#   VOLT_VERSION=v0.1.0          Pin a canonical release for either method.

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$package = "@hansjm10/volt-coding-agent"
$repo = "hansjm10/Volt"
$method = if ([string]::IsNullOrWhiteSpace($env:VOLT_INSTALL_METHOD)) { "npm" } else { $env:VOLT_INSTALL_METHOD }
$version = if ([string]::IsNullOrWhiteSpace($env:VOLT_VERSION)) { "latest" } else { $env:VOLT_VERSION }

function Fail([string]$message) {
    Write-Host "volt install: $message" -ForegroundColor Red
    exit 1
}

if ($version -ne "latest" -and $version -notmatch '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Fail "VOLT_VERSION must be 'latest' or a canonical version such as v0.1.0"
}

function Install-NpmVolt {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail "Node.js not found. The full Volt install requires Node.js >= 22.19. Install it from https://nodejs.org. For a local CLI/TUI without daemon or remote/iOS support, set VOLT_INSTALL_METHOD=binary."
    }

    $nodeSupported = node -p 'const [major, minor] = process.versions.node.split(".").map(Number); Number(major > 22 || (major === 22 && minor >= 19))'
    if ($LASTEXITCODE -ne 0 -or $nodeSupported -ne "1") {
        Fail "Node.js $(node --version) is too old. Volt requires Node.js >= 22.19."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "npm not found. It normally ships with Node.js; install Node.js from https://nodejs.org."
    }

    $npmSpec = "$package@beta"
    if ($version -ne "latest") {
        $npmSpec = "$package@$($version.TrimStart('v'))"
    }
    Write-Host "Installing $npmSpec globally (lifecycle scripts disabled)..."
    npm install -g --ignore-scripts $npmSpec
    if ($LASTEXITCODE -ne 0) {
        Fail "npm install failed (exit code $LASTEXITCODE)"
    }

    Write-Host ""
    if (Get-Command volt -ErrorAction SilentlyContinue) {
        Write-Host "Installed. Run 'volt' in a project directory to get started."
        Write-Host "This npm install supports 'volt daemon' and remote/iOS access."
    } else {
        $npmBin = npm prefix -g
        Write-Host "Installed, but '$npmBin' is not on your PATH. Add it and restart your terminal."
    }
}

function Install-BinaryVolt {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    switch ($architecture) {
        "x64" { $platform = "windows-x64" }
        "arm64" { $platform = "windows-arm64" }
        default { Fail "unsupported Windows architecture '$architecture'" }
    }

    $asset = "volt-$platform.zip"
    if ($version -eq "latest") {
        $baseUrl = "https://github.com/$repo/releases/latest/download"
    } else {
        $releaseTag = "v$($version.TrimStart('v'))"
        $baseUrl = "https://github.com/$repo/releases/download/$releaseTag"
    }

    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "volt-install-$([Guid]::NewGuid().ToString('N'))"
    $archivePath = Join-Path $temporaryDirectory $asset
    $checksumsPath = Join-Path $temporaryDirectory "SHA256SUMS"
    $extractedBinary = Join-Path $temporaryDirectory "volt.exe"
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    try {
        Write-Host "Downloading $baseUrl/$asset ..."
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile $checksumsPath

        $escapedAsset = [Regex]::Escape($asset)
        $checksumMatches = @()
        foreach ($line in Get-Content -LiteralPath $checksumsPath) {
            if ($line -match "^([0-9A-Fa-f]{64})\s+$escapedAsset$") {
                $checksumMatches += $Matches[1].ToLowerInvariant()
            }
        }
        if ($checksumMatches.Count -ne 1) {
            Fail "SHA256SUMS must contain exactly one checksum for $asset"
        }
        $actualChecksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        if ($actualChecksum -ne $checksumMatches[0]) {
            Fail "SHA-256 verification failed for $asset"
        }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            $entries = @($archive.Entries | Where-Object { $_.FullName -eq "volt.exe" -and $_.Name -eq "volt.exe" })
            if ($entries.Count -ne 1) {
                Fail "release archive must contain exactly one root volt.exe"
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $extractedBinary, $false)
        } finally {
            $archive.Dispose()
        }

        $binDirectory = Join-Path $HOME ".volt\bin"
        New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
        $destination = Join-Path $binDirectory "volt.exe"
        Move-Item -Force -LiteralPath $extractedBinary -Destination $destination

        Write-Host ""
        Write-Host "Installed verified standalone binary to $destination"
        Write-Host "Capability: local CLI/TUI only. 'volt daemon' and remote/iOS access are unavailable."
        Write-Host "For those features, use the default npm install."
        if (($env:PATH -split ';') -notcontains $binDirectory) {
            Write-Host "Add '$binDirectory' to your PATH and restart your terminal."
        }
    } finally {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $temporaryDirectory
    }
}

switch ($method) {
    "npm" { Install-NpmVolt }
    "binary" { Install-BinaryVolt }
    default { Fail "unknown VOLT_INSTALL_METHOD '$method' (expected 'npm' or 'binary')" }
}

Write-Host "Windows setup notes: https://volt-cli.dev/docs/windows/"
Write-Host "Docs: https://volt-cli.dev/docs/quickstart/"
