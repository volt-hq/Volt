# Contributing to Volt

Volt is maintained by one person. This guide exists so that time goes into the code instead of the tracker.

## Philosophy

**Volt's core is minimal.**

If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

The core exists to be small and extensible so that extensions can shape its behavior. Even new extension hook points should be proposed and discussed first — every hook is API surface that has to be maintained.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated code you do not understand is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` automatically. Your agent must follow the rules in that file.

## Issues

Use one of the GitHub issue templates, and keep the issue short, concrete, and worth reading:

- If it does not fit on one screen, it is too long.
- Write in your own voice. If you paste LLM output, label it clearly.
- State the bug or request, and why it matters.
- For bugs, verify with `volt -ne` that the problem is not caused by an extension you loaded.
- If you want to implement the change yourself, say so.

I triage the tracker on my own schedule. Low-signal issues, duplicates, and reports that ignore this guide may be closed without a reply.

Security-sensitive reports must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.

Spamming the tracker with automated or agent-generated issues will get your account blocked.

## Pull requests

Open an issue first for anything larger than a trivial fix — it saves you from building something that will not be merged.

Before submitting:

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit the per-package `CHANGELOG.md` files. Changelog entries are handled at release time.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Roadmap

Volt is a fork of [Pi](https://github.com/badlogic/pi-mono). Historical Pi design material remains upstream and does not represent the Volt roadmap.
