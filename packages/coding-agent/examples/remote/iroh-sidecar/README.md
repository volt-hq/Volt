# Iroh sidecar proof of concept

This example tunnels Volt RPC JSONL over an Iroh QUIC bidirectional stream.

The PoC keeps Iroh outside Volt core. `host.mjs` accepts an Iroh connection, validates a one-time pairing secret, spawns a child RPC process, and bridges bytes between Iroh and the child process. The child is `fake-rpc.mjs` by default so the network bridge can be tested without provider credentials.

## Install

From this directory:

```bash
npm install --ignore-scripts
```

`@number0/iroh` is a native package with optional prebuilt platform packages. Keeping it in this example package avoids adding Iroh to Volt's default install path.

## Local fake-RPC smoke test

Terminal 1:

```bash
npm run host -- --once
```

Copy the printed `volt+iroh://v1/...` ticket.

Terminal 2:

```bash
npm run client -- "<ticket>" --message "hello from another device"
```

Expected output:

```text
fake RPC response over Iroh: hello from another device
```

## Test with real Volt RPC

Terminal 1:

```bash
npm run host -- --use-volt --workspace volt=/path/to/repo --allow-tools read,grep,find,ls
```

Terminal 2:

```bash
npm run client -- "<ticket>" --get-state
npm run client -- "<ticket>" --message "List the top-level files."
```

Use a source checkout binary if `volt` is not globally installed:

```bash
npm run host -- --use-volt --volt-bin /path/to/volt/volt-test.sh --workspace volt=/path/to/repo
```

On Windows, a global install normally resolves through `volt.cmd` automatically when `--volt-bin` is omitted.

## Relay mode

The default is `--relay disabled`, which is best for same-machine or same-LAN testing. To exercise Iroh's relay/discovery path:

```bash
npm run host -- --relay default --once
```

The ticket records the relay mode and the client uses the same preset.

## Security notes

This PoC is intentionally small and is not product-ready remote access.

- Pairing tickets contain a one-time secret but are not persisted or revoked.
- Any connected client can control the spawned RPC child for the selected workspace.
- Real Volt RPC can read files, edit files, and run tools allowed by `--allow-tools`.
- Keep the default read-only tool list while testing remotely.
- Do not expose sensitive workspaces or run with `bash,edit,write` unless the client is trusted.

See [the design document](../../../docs/iroh-remote-access-design.md) for the intended product security model.
