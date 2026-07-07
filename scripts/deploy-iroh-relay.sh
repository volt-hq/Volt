#!/usr/bin/env bash
# Deploy (or update) a self-hosted iroh relay for Volt on a fresh Ubuntu/Debian
# VPS. Idempotent: re-running upgrades the binary, rewrites the config, and
# restarts the service. See docs/self-hosted-relay.md for the manual version.
#
# Prereqs: root SSH access to the server; DNS A (and AAAA) record for HOSTNAME
# already pointing at it (Let's Encrypt issuance fails otherwise).
#
# Usage:
#   scripts/deploy-iroh-relay.sh <ssh-target> <hostname> [options]
#   scripts/deploy-iroh-relay.sh <ssh-target> --add-allow <endpoint-id>
#
#   <ssh-target>   ssh destination (host alias, user@host, ...)
#   <hostname>     public DNS name of the relay, e.g. iroh-relay-eu.volt-cli.dev
#
# Options:
#   --contact <email>      Let's Encrypt contact email (default: none)
#   --allowlist <id,id,..> restrict relay access to these endpoint ids;
#                          omit to allow everyone (lock down later!)
#   --version <vX.Y.Z>     iroh-relay release tag (default: v1.0.2)
#   --add-allow <id>       append one endpoint id to an existing relay's
#                          allowlist and restart (no other changes)
set -euo pipefail

VERSION="v1.0.2"
CONTACT=""
ALLOWLIST=""
ADD_ALLOW=""

SSH_TARGET="${1:?usage: deploy-iroh-relay.sh <ssh-target> <hostname> [options]}"
shift
HOSTNAME_ARG=""
if [[ "${1:-}" != --* ]]; then
	HOSTNAME_ARG="${1:?usage: deploy-iroh-relay.sh <ssh-target> <hostname> [options]}"
	shift
fi

while [[ $# -gt 0 ]]; do
	case "$1" in
		--contact) CONTACT="$2"; shift 2 ;;
		--allowlist) ALLOWLIST="$2"; shift 2 ;;
		--version) VERSION="$2"; shift 2 ;;
		--add-allow) ADD_ALLOW="$2"; shift 2 ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

run() { ssh "$SSH_TARGET" "$@"; }

# --add-allow: append an endpoint id to the allowlist and restart. -----------
if [[ -n "$ADD_ALLOW" ]]; then
	if ! [[ "$ADD_ALLOW" =~ ^[0-9a-f]{64}$ ]]; then
		echo "error: --add-allow expects a 64-char hex endpoint id" >&2
		exit 2
	fi
	run "set -e
		test -f /etc/iroh-relay/config.toml || { echo 'no relay config on server' >&2; exit 1; }
		grep -q 'allowlist' /etc/iroh-relay/config.toml || { echo 'relay has no allowlist (access is open)' >&2; exit 1; }
		if grep -q '$ADD_ALLOW' /etc/iroh-relay/config.toml; then
			echo 'endpoint id already allowed'
		else
			sed -i 's/^allowlist = \[/allowlist = [\n  \"$ADD_ALLOW\",/' /etc/iroh-relay/config.toml
			systemctl restart iroh-relay
			echo 'endpoint id added; relay restarted'
		fi"
	exit 0
fi

[[ -n "$HOSTNAME_ARG" ]] || { echo "error: hostname required for deploy" >&2; exit 2; }

# Sanity: DNS must already point at the server. ------------------------------
SERVER_IP=$(run 'curl -s -4 --max-time 10 ifconfig.me || true')
DNS_IP=$(dig +short "$HOSTNAME_ARG" A | head -1)
if [[ -z "$DNS_IP" || "$DNS_IP" != "$SERVER_IP" ]]; then
	echo "error: DNS for $HOSTNAME_ARG resolves to '${DNS_IP:-<nothing>}' but server reports '$SERVER_IP'." >&2
	echo "Create/fix the A record first; Let's Encrypt issuance will fail without it." >&2
	exit 1
fi

# Map server arch to release artifact. ----------------------------------------
ARCH=$(run 'uname -m')
case "$ARCH" in
	x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
	aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
	*) echo "error: unsupported server arch: $ARCH" >&2; exit 1 ;;
esac
ARTIFACT="iroh-relay-$VERSION-$TARGET.tar.gz"
URL="https://github.com/n0-computer/iroh/releases/download/$VERSION/$ARTIFACT"

echo "==> installing iroh-relay $VERSION ($TARGET) on $SSH_TARGET"
run "set -e
	cd /tmp
	curl -sfLO '$URL'
	tar xzf '$ARTIFACT'
	install iroh-relay /usr/local/bin/iroh-relay
	rm -f iroh-relay '$ARTIFACT'
	useradd --system --home /var/lib/iroh-relay --create-home iroh-relay 2>/dev/null || true
	mkdir -p /etc/iroh-relay /var/lib/iroh-relay/certs
	chown -R iroh-relay:iroh-relay /var/lib/iroh-relay
	/usr/local/bin/iroh-relay --version"

echo "==> writing /etc/iroh-relay/config.toml"
CONFIG="# Managed by Volt scripts/deploy-iroh-relay.sh — edits may be overwritten.
# Plain-HTTP listener: serves the ACME HTTP-01 challenge and probes.
http_bind_addr = \"[::]:80\"

# Lets clients learn their public address over QUIC.
enable_quic_addr_discovery = true

[tls]
https_bind_addr = \"[::]:443\"
quic_bind_addr = \"[::]:7824\"
hostname = \"$HOSTNAME_ARG\"
cert_mode = \"LetsEncrypt\"
prod_tls = true
cert_dir = \"/var/lib/iroh-relay/certs\""
if [[ -n "$CONTACT" ]]; then
	CONFIG+=$'\n'"contact = \"$CONTACT\""
fi
if [[ -n "$ALLOWLIST" ]]; then
	CONFIG+=$'\n\n'"# Only these Volt endpoints may use this relay."$'\n'"[access]"$'\n'"allowlist = ["
	IFS=',' read -ra IDS <<<"$ALLOWLIST"
	for id in "${IDS[@]}"; do
		CONFIG+=$'\n'"  \"$(echo "$id" | tr -d '[:space:]')\","
	done
	CONFIG+=$'\n'"]"
fi
printf '%s\n' "$CONFIG" | run 'cat > /etc/iroh-relay/config.toml'

echo "==> installing systemd unit"
run 'cat > /etc/systemd/system/iroh-relay.service' <<'UNIT'
[Unit]
Description=iroh relay
After=network-online.target
Wants=network-online.target

[Service]
User=iroh-relay
ExecStart=/usr/local/bin/iroh-relay --config-path /etc/iroh-relay/config.toml
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
run 'systemctl daemon-reload && systemctl enable --now iroh-relay && systemctl restart iroh-relay'

echo "==> configuring firewall (ufw)"
run 'if command -v ufw >/dev/null; then
	ufw allow OpenSSH >/dev/null
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	ufw allow 7824/udp >/dev/null
	ufw --force enable >/dev/null
	ufw status | head -2
else
	echo "ufw not present; open 80/tcp 443/tcp 7824/udp in your provider firewall"
fi'

echo "==> waiting for HTTPS (Let's Encrypt issuance can take a minute on first deploy)"
for i in $(seq 1 30); do
	if curl -sfo /dev/null --max-time 10 "https://$HOSTNAME_ARG/"; then
		echo "==> relay is live: https://$HOSTNAME_ARG"
		echo "    point Volt at it: VOLT_IROH_RELAY_URLS=https://$HOSTNAME_ARG"
		exit 0
	fi
	sleep 5
done
echo "error: relay did not serve HTTPS within 150s; check: ssh $SSH_TARGET journalctl -u iroh-relay -n 50" >&2
exit 1
