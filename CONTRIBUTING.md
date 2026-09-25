# Contributing to Volt

Volt is maintained by one person. This guide exists so that time goes into the code instead of the tracker.

## Philosophy

**Volt is a coding agent for terminal and phone workflows.**

Shared capabilities belong in core when they need consistent behavior across the terminal, daemon, and companion app. Plan mode, code review, subagents, background jobs, LSP, and MCP are built-in features, not requirements for users to assemble through extensions.

Project-specific workflows belong in extensions, skills, prompt templates, or packages. Propose architectural changes and new extension hooks before implementing them; every public API and remote protocol change has to be maintained across its clients.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated code you do not understand is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` automatically. Your agent must follow the rules in that file.

## Issues

Use one of the GitHub issue templates, and keep the issue short, concrete, and worth reading:

- If it does not fit on one screen, it is too long.
- Write in your own voice. If you paste LLM output, label it clearly.
- State the bug or request, and why it matters.
- Include `volt --version`, your operating system, and the affected surface: terminal, daemon/phone connection, provider, or library. For phone issues, also include the app version and iOS version.
- For local CLI bugs, retry with `volt --no-extensions` when relevant and report whether it changes the result. Do not include explicit `-e` paths in that run. This does not disable extensions in an already-running daemon.
- Redact provider credentials, pairing tickets/QR codes, and private repository content from logs or screenshots.
- If you want to implement the change yourself, say so.

I triage the tracker on my own schedule. Low-signal issues, duplicates, and reports that ignore this guide may be closed without a reply.

Security-sensitive reports must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.

Spamming the tracker with automated or agent-generated issues will get your account blocked.

## Pull requests

Open an issue first for anything larger than a trivial fix — it saves you from building something that will not be merged.

Before submitting, run `npm run check` and only the tests affected by your change, including every test file you create or modify. Choose focused tests that cover the changed behavior and its directly affected callers; a full-suite run is not required. For docs-only changes, validate relevant links, examples, and metadata instead of running unrelated runtime tests.

For example, when changing skill loading, run the affected test from the repository root:

```bash
npm run check
./test.sh test --workspace packages/coding-agent -- test/skills.test.ts
```

Required checks and affected tests must pass. Fix failures caused by your changes and report unrelated failures without expanding the PR's scope. Include the commands and results in the PR description.

The AI, agent, and coding-agent Vitest configs default to two workers locally to
reduce contention with the editor, daemon, and other worktrees. Override a
workspace run with the standard Vitest option:

```bash
./test.sh test --workspace packages/coding-agent -- test/skills.test.ts --maxWorkers=1
```

Only run the full non-e2e suite when explicitly requested. To limit its concurrency, set both Vitest pool limits:

```bash
VITEST_MAX_FORKS=1 VITEST_MAX_THREADS=1 ./test.sh
```

Explicit CLI and pool limits are preserved. Vitest's pool-specific environment
variables take precedence over `--maxWorkers` when both are set. CI retains its
existing worker limits and shards, and Node's built-in test runner (including
the TUI suite) keeps its existing concurrency. Limits are per invocation, so
avoid running several full suites simultaneously on the same host.

Do not edit `packages/coding-agent/CHANGELOG.md` directly. User-visible changes add a changeset fragment in `.changeset/` instead (see `.changeset/README.md`); release tooling generates the changelog from those fragments.

If you are adding a new provider to `packages/ai`, follow the [provider checklist](.volt/skills/add-llm-provider.md) for required tests and integration points.

## Roadmap

Planned and in-flight work across the Volt CLI and its companion app is tracked on the [Volt Roadmap](https://github.com/orgs/volt-hq/projects/1) project board. Items from private repositories are only visible to people with access, so the board may look sparse from the outside.

Volt is a fork of [Pi](https://github.com/earendil-works/pi). Historical Pi design material remains upstream and does not represent the Volt roadmap.
