# Changelog

## [0.1.0] - 2026-07-13

Volt's first release: a terminal coding agent with a companion daemon that can hand a running session to your phone and back. Volt is a fork of [Pi](https://github.com/badlogic/pi-mono); this release restarts the version line under the `@hansjm10/volt-coding-agent` package identity.

### Highlights

- **Remote sessions on your phone** — Pair the Volt iOS app with your machine over an end-to-end encrypted Iroh connection (QR-code pairing, no port forwarding or accounts), attach to live conversations, steer runs from anywhere, and get push notifications and Live Activities as turns complete. Every device pairs with an explicit access preset: `coding`, `review`, `chat`, or `full`.
- **`voltd` daemon and `/remote` control center** — A background daemon owns workspaces, runtimes, and conversation leases, so sessions survive TUI restarts and move cleanly between desktop and phone. The `/remote` command manages daemon health, workspace registration, pairing, paired devices, active leases, and runtime tool policy from inside the TUI. See [Daemon](docs/daemon.md).
- **Subagent delegation** — A built-in `subagent` tool discovers user- and project-defined child agents, ships reserved `general`, `researcher`, `design-doc`, and `security-reviewer` roles, enforces bounded recursive delegation budgets, and renders live nested delegation trees in the TUI and on remote clients.
- **Native MCP support** — Trusted config loading, a built-in `mcp` gateway tool, stdio/Streamable HTTP/SSE transports, and OAuth (browser PKCE and device-code) with host-side token storage. See [MCP](docs/mcp.md).
- **LSP-backed editing** — Language servers spawn lazily per project and append diagnostics to `edit`/`write` results by default, and the `lsp` tool adds navigation, references, call hierarchy, project-wide rename, and quick fixes. See [LSP Diagnostics](docs/lsp.md).
- **`/review`** — Review uncommitted changes, branch diffs, GitHub PRs, or single commits in an isolated session, then continue from the numbered findings with clean context.
- **Built-in web search** — A `web_search` tool enabled by default across SDK, CLI/RPC, and remote sessions, with OpenAI/Codex, custom-endpoint, and Brave Search backends.
- **Settings profiles** — Workflow-specific settings and resource overlays selectable with `--profile`, `VOLT_PROFILE`, or `defaultProfile`, plus `/profile` for switching interactively.

### Breaking Changes

- Volt now ships as `@hansjm10/volt-coding-agent` with the release line restarted at 0.1.0; npm beta installs use the `beta` dist-tag.
- Paired remote devices and pending pairing tickets require a versioned per-device access grant; pairings created before this release fail closed and must re-pair with `volt remote pair --access coding|review|chat|full`.

### Also in this release

- Standalone releases are Node.js Single Executable Applications for six OS/architecture targets, with checksum-verified installers, pinned license manifests, and a reviewed exact-commit release pipeline.
- Live model catalog updates, mid-turn reconnect state (`get_state` active tools), remote model/thinking-level switching, and remote-safe transcript projection for paired clients.
- Proactive mid-run compaction, an `agent_settled` idle-boundary event, and bounded summarization input for long conversations.
- Pi extension compatibility: `volt install` reads `pi` manifests when no `volt` manifest is present and aliases Pi core imports to Volt modules at load time.
- A redesigned interactive shell: responsive startup lockup, electric purple themes, Bash syntax highlighting, tool duration suffixes, focus-aware turn-done alerts, and `/clear` replacing `/new`.
- Extensive hardening across daemon lifecycle and Windows support, Iroh pairing and connection admission, push delivery, MCP and OAuth handling, local persistence, and release integrity. The full engineering log for this release (~180 entries) is preserved in this file's git history.
