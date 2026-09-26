# Quickstart

This page gets you from install to a useful first volt session.

## Install

Install Node.js 22.19 or newer, then install Volt through npm:

```bash
npm install -g --ignore-scripts @hansjm10/volt-coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Volt does not require install scripts for normal npm installs. Keep optional dependencies enabled if you want to connect the iOS app; `--omit=optional` leaves phone transport unavailable.

The npm installation supports the daemon on macOS Apple Silicon, Windows x64/arm64, and Linux x64/arm64. Intel macOS has no native Iroh binding. Standalone executables are local CLI/TUI only and cannot host phone connections.

### Uninstall

Use the package manager that installed volt. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
npm uninstall -g @hansjm10/volt-coding-agent

# pnpm
pnpm remove -g @hansjm10/volt-coding-agent

# Yarn
yarn global remove @hansjm10/volt-coding-agent

# Bun
bun uninstall -g @hansjm10/volt-coding-agent
```

Uninstalling volt leaves settings, credentials, sessions, and installed volt packages in `~/.volt/agent/`.

Then start volt in the project directory you want it to work on:

```bash
cd /path/to/project
volt
```

## Authenticate

Volt can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start volt and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching volt:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
volt
```

You can also run `/login` and select an API-key provider to store the key in `~/.volt/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once volt starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

Volt includes tools for reading and editing files, running shell commands, searching/fetching the web, and managing background jobs and subagents. Other tools depend on the selected model, configuration, and runtime: for example, image generation requires OpenAI Codex, MCP requires configured servers, and structured questions are local-interactive only. See [Tool Options](usage.md#tool-options) to select or exclude tools.

Volt runs with your user account's permissions, not inside a built-in sandbox. Use git checkpoints for rollback and a [container or VM](containerization.md) when you need isolation.

## Continue from your iPhone

The Volt iOS companion app connects to the agent on your computer; it does not run the agent or its tools on the phone. Install and authenticate the CLI first, and keep the computer running and reachable.

From a shell on that computer:

```bash
volt daemon start
volt remote workspace add /path/to/project --name my-project
volt remote pair --workspace my-project
```

1. Open the companion app and scan the pairing QR. Treat the QR/ticket as a credential; do not share it in logs or screenshots.
2. Select the registered workspace and start or resume a conversation. When a terminal session is attached to the daemon, the phone can join that same live conversation.
3. Reconnect using the saved computer next time; ordinary reconnects do not require another QR scan.

You can also open `/remote` in the terminal to start the daemon, register the current directory, pair a phone, or revoke a device. Set `remote.background: true` in settings if you want interactive Volt to start the daemon automatically.

Pair only devices you control. Phone prompts can run tools on your computer, and a phone sharing a desktop-owned conversation uses that terminal session's full local tool set. App backgrounding or network loss detaches the phone without cancelling active work; use the app's stop action to cancel. Host shutdown stops in-memory work.

Direct and self-hosted connections are separate from Volt Pro's managed relay and completion-notification services. An endpoint marked ready does not confirm managed relay access; `/remote` reports relay enrollment and subscription status separately. See the [privacy policy](https://volt-cli.dev/privacy) and [terms](https://volt-cli.dev/terms).

If the phone cannot connect, run `volt daemon status` and inspect `/remote`. Status exits successfully only when phone transport is ready and managed relay access is available. See [Background daemon](daemon.md) for transport errors and [Security](security.md#remote-access-over-iroh-preview) for access boundaries.

## Give volt project instructions

Volt loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Volt loads:

- `~/.volt/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart volt, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
volt @README.md "Summarize this"
volt @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to toggle Build/Plan mode and Ctrl+Shift+T to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
volt -c                  # Continue most recent session
volt -r                  # Browse previous sessions
volt --name "my task"    # Set session display name at startup
volt --session <path|id> # Open a specific session
```

Inside volt, use `/resume`, `/clear`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
volt -p "Summarize this codebase"
cat README.md | volt -p "Summarize this text"
volt -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Volt](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Volt Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
