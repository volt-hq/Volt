# Self-hosted iroh relay

Volt uses [iroh](https://www.iroh.computer/) for the daemon ↔ phone transport. By
default the endpoint binds with the n0 production preset, which uses n0's public
relay servers. This guide sets up your own relay on a cheap VPS and points both
sides of Volt at it, so no Volt traffic transits the public relays.

Relayed traffic is end-to-end encrypted by iroh (the relay only forwards opaque
QUIC packets between node ids), so this is about infrastructure ownership and
availability, not payload confidentiality.

## What you need

- A VPS with a public IPv4 (and ideally IPv6). 1 vCPU / 1 GB RAM is plenty for
  development (e.g. Hetzner CX22/CAX11, a small DigitalOcean droplet, etc.).
- A DNS name you control, e.g. `relay.example.com`.
- Ubuntu 24.04 is assumed below; adjust for your distro.

## 1. DNS

Create records pointing at the server, and wait for them to resolve before
starting the relay (Let's Encrypt issuance needs them):

```
relay.example.com.  A     <server IPv4>
relay.example.com.  AAAA  <server IPv6>   # if you have one
```

## 2. Install iroh-relay

The relay is a single static binary; n0 publishes prebuilt releases. Volt pins
iroh 1.0, so use a 1.x relay (v1.0.2 verified against Volt's bindings):

```sh
# on the server — pick the artifact matching your arch (aarch64/x86_64, gnu/musl)
curl -sLO https://github.com/n0-computer/iroh/releases/download/v1.0.2/iroh-relay-v1.0.2-x86_64-unknown-linux-gnu.tar.gz
tar xzf iroh-relay-v1.0.2-x86_64-unknown-linux-gnu.tar.gz
sudo install iroh-relay /usr/local/bin/iroh-relay
iroh-relay --version
```

(Alternative: `cargo install iroh-relay --features server` if you prefer
building from source.)

## 3. Configure

```sh
sudo useradd --system --home /var/lib/iroh-relay --create-home iroh-relay
sudo mkdir -p /etc/iroh-relay
```

`/etc/iroh-relay/config.toml`:

```toml
# Plain-HTTP listener: serves the ACME HTTP-01 challenge and probes.
http_bind_addr = "[::]:80"

# Lets clients learn their public address over QUIC (n0's replacement for STUN).
enable_quic_addr_discovery = true

[tls]
https_bind_addr = "[::]:443"
# QUIC address discovery socket (UDP). Defaults to port 7824.
quic_bind_addr = "[::]:7824"
hostname = "relay.example.com"
cert_mode = "LetsEncrypt"
contact = "you@example.com"     # Let's Encrypt account email
prod_tls = true
cert_dir = "/var/lib/iroh-relay/certs"

# Optional: lock the relay down to your own endpoints once you know their ids
# (voltd logs its id as hostNodeId; anything not listed is rejected).
# access.allowlist = [
#   "<daemon endpoint id>",
#   "<phone endpoint id>",
# ]
```

Metrics are served on port 9090 by default; leave it firewalled and query it
from the box (`curl 127.0.0.1:9090/metrics`) or set `enable_metrics = false`.

## 4. systemd unit

`/etc/systemd/system/iroh-relay.service`:

```ini
[Unit]
Description=iroh relay
After=network-online.target
Wants=network-online.target

[Service]
User=iroh-relay
ExecStart=/usr/local/bin/iroh-relay --config-path /etc/iroh-relay/config.toml
# Binding ports 80/443 as a non-root user:
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now iroh-relay
journalctl -u iroh-relay -f    # watch the Let's Encrypt issuance on first start
```

## 5. Firewall

Open exactly:

| Port | Proto | Purpose |
| ---- | ----- | ------- |
| 80   | tcp   | ACME HTTP-01 challenge, HTTP probes |
| 443  | tcp   | Relay traffic (HTTPS + websocket upgrade) |
| 7824 | udp   | QUIC address discovery |

```sh
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 7824/udp
```

## 6. Verify

```sh
curl -sSf https://relay.example.com/ | head -1   # serves the relay index page
```

A TLS error here usually means DNS hadn't propagated when the service started;
restart the unit after DNS resolves.

## 7. Point Volt at it

Restart the daemon with the relay URL(s); comma-separate to run more than one:

```sh
VOLT_IROH_RELAY_URLS=https://relay.example.com volt daemon run
```

When `VOLT_IROH_RELAY_URLS` is set, voltd binds its endpoint with a custom
relay map (relay mode `custom`) instead of the n0 relays, and every pairing
ticket it mints carries the relay URLs. The startup log line
`iroh endpoint online` shows `relayMode: "custom"` and the URLs.

On the phone: **re-pair once** (scan a fresh QR). The ticket's `relayUrls`
travel into the saved-host record, so reconnects — including cold starts — bind
against your relay from then on. Hosts saved before the switch still reference
the old relay mode; delete and re-pair them.

Config precedence: an explicit `createIrohDaemonService({ relayMode, relayUrls })`
beats the env var; with neither, the n0 default preset is used, and
`relayMode: "disabled"` still disables relaying entirely.

## Scope note: discovery is separate

This moves *relay traffic* off public infrastructure. Endpoint **discovery**
(publishing/resolving node addresses via n0's DNS/pkarr service) is still the
n0 preset's; Volt keeps it enabled so reconnects survive IP changes. If you
later want zero n0 dependencies, that's a separate step: self-host
[iroh-dns-server](https://github.com/n0-computer/iroh/tree/main/iroh-dns-server)
and swap the discovery preset in both endpoints.
