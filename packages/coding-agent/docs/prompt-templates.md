> volt can create prompt templates. Ask it to build one for your workflow.

# Prompt Templates

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`.

## Locations

Volt loads prompt templates from:

- Global: `~/.volt/agent/prompts/*.md`
- Project: `.volt/prompts/*.md` (only after the project is trusted)
- Packages: `prompts/` directories or `volt.prompts` entries in `package.json`
- Settings: `prompts` array with files or directories
- CLI: `--prompt-template <path>` (repeatable)

Disable discovery with `--no-prompt-templates`.

## Format

```markdown
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- The filename becomes the command name. `review.md` becomes `/review`.
- `description` is optional. If missing, the first non-empty line is used.
- `argument-hint` is optional. When set, the hint is displayed before the description in the autocomplete dropdown.

### Argument Hints

Use `argument-hint` in frontmatter to show expected arguments in autocomplete. Use `<angle brackets>` for required arguments and `[square brackets]` for optional ones:

```markdown
---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
```

This renders in the autocomplete dropdown as:

```
→ pr   <PR-URL>       — Review PRs from URLs with structured issue and code analysis
  is   <issue>        — Analyze GitHub issues (bugs or feature requests)
  wr   [instructions] — Finish the current task end-to-end
  cl   — Audit changelog entries before release
```

## Usage

Type `/` followed by the template name in the editor. Autocomplete shows available templates with descriptions.

```
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

### Intents

Protocol clients see each prompt template as a dynamic intent named `prompt.template.<id>` (see [rpc.md](rpc.md#dynamic-intents)). The `intents` query lists it with the template's name and description, so clients can render it in a command palette and invoke it by name with `{arguments?, streamingBehavior?}`.

The descriptor is a safe projection:

- The id is opaque and stays the same while the session's extension commands, prompt templates, and skills do.
- The slash alias is display metadata; clients should invoke the intent instead of constructing raw slash text.
- Template bodies and template file paths are not included in descriptors.
- Arguments are passed through the host template-expansion path, so the host remains responsible for parsing and expansion. While the agent streams, `streamingBehavior` (`steer` or `followUp`) says how to queue the prompt. An intent from a catalog that changed after a reload or a session change is rejected `unknown_intent`.

Paired remote clients may invoke prompt-template intents with `conversation.control.v1`.

## Arguments

Templates support positional arguments, defaults, and simple slicing:

- `$1`, `$2`, ... positional args
- `$@` or `$ARGUMENTS` for all args joined
- `${1:-default}` uses arg 1 when present/non-empty, otherwise `default`
- `${@:N}` for args from the Nth position (1-indexed)
- `${@:N:L}` for `L` args starting at N

Example:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Default values are useful for optional arguments:

```markdown
Summarize the current state in ${1:-7} bullet points.
```

Usage: `/component Button "onClick handler" "disabled support"`

## Loading Rules

- Template discovery in `prompts/` is non-recursive.
- If you want templates in subdirectories, add them explicitly via `prompts` settings or a package manifest.
