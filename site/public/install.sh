#!/bin/sh
# Volt installer — https://volt-cli.dev
#
# Usage:
#   curl -fsSL https://volt-cli.dev/install.sh | sh
#
# Installs the Volt coding agent globally via npm with lifecycle scripts
# disabled. Volt does not require install scripts for normal npm installs.
#
# Options (env vars):
#   VOLT_INSTALL_METHOD=binary   Download a standalone prebuilt binary from
#                                GitHub Releases into ~/.volt/bin instead of
#                                using npm. Note: binary builds do not support
#                                `volt daemon` (remote/iOS access needs the
#                                npm install).
#   VOLT_VERSION=v0.79.6         Pin a specific release (binary method only;
#                                npm method installs the latest published
#                                version).
set -eu

PACKAGE="@hansjm10/volt-cli"
REPO="hansjm10/Volt"
MIN_NODE_MAJOR=22
METHOD="${VOLT_INSTALL_METHOD:-npm}"

say() { printf '%s\n' "$*"; }
fail() { printf 'volt install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

install_npm() {
    have node || fail "Node.js not found. Volt requires Node.js >= 22.19.
Install it from https://nodejs.org or via your package manager, then re-run:
  curl -fsSL https://volt-cli.dev/install.sh | sh
Or install a standalone binary (no Node needed, but 'volt daemon' is unavailable):
  curl -fsSL https://volt-cli.dev/install.sh | VOLT_INSTALL_METHOD=binary sh"

    node_major=$(node -p 'process.versions.node.split(".")[0]')
    [ "$node_major" -ge "$MIN_NODE_MAJOR" ] || fail "Node.js $(node --version) is too old. Volt requires Node.js >= 22.19."

    have npm || fail "npm not found. It normally ships with Node.js; install Node.js from https://nodejs.org."

    say "Installing $PACKAGE globally (lifecycle scripts disabled)..."
    npm install -g --ignore-scripts "$PACKAGE"

    if have volt; then
        say ""
        say "Installed: $(volt --version 2>/dev/null || say volt)"
        say "Run 'volt' in a project directory to get started."
        say "Docs: https://volt-cli.dev/docs/quickstart/"
    else
        npm_bin=$(npm prefix -g)/bin
        say ""
        say "Installed, but '$npm_bin' is not on your PATH."
        say "Add it to your shell profile, e.g.:"
        say "  export PATH=\"$npm_bin:\$PATH\""
    fi
}

install_binary() {
    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in
        Darwin) platform="darwin" ;;
        Linux) platform="linux" ;;
        *) fail "unsupported OS '$os'. On Windows, run: irm https://volt-cli.dev/install.ps1 | iex" ;;
    esac
    case "$arch" in
        arm64 | aarch64) platform="$platform-arm64" ;;
        x86_64 | amd64) platform="$platform-x64" ;;
        *) fail "unsupported architecture '$arch'" ;;
    esac

    version="${VOLT_VERSION:-latest}"
    if [ "$version" = "latest" ]; then
        url="https://github.com/$REPO/releases/latest/download/volt-$platform.tar.gz"
    else
        url="https://github.com/$REPO/releases/download/$version/volt-$platform.tar.gz"
    fi

    bin_dir="$HOME/.volt/bin"
    mkdir -p "$bin_dir"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT

    say "Downloading $url ..."
    curl -fSL --proto '=https' --tlsv1.2 -o "$tmp/volt.tar.gz" "$url"
    tar -xzf "$tmp/volt.tar.gz" -C "$tmp"

    volt_bin=$(find "$tmp" -type f -name volt | head -n 1)
    [ -n "$volt_bin" ] || fail "no 'volt' binary found in the release archive"
    install -m 755 "$volt_bin" "$bin_dir/volt"

    say ""
    say "Installed volt to $bin_dir/volt"
    say "Note: standalone binaries do not support 'volt daemon' (remote/iOS access)."
    say "      For that, install via npm: curl -fsSL https://volt-cli.dev/install.sh | sh"
    case ":$PATH:" in
        *":$bin_dir:"*) ;;
        *)
            say ""
            say "Add volt to your PATH, e.g.:"
            say "  export PATH=\"\$HOME/.volt/bin:\$PATH\""
            ;;
    esac
    say "Docs: https://volt-cli.dev/docs/quickstart/"
}

case "$METHOD" in
    npm) install_npm ;;
    binary) install_binary ;;
    *) fail "unknown VOLT_INSTALL_METHOD '$METHOD' (expected 'npm' or 'binary')" ;;
esac
