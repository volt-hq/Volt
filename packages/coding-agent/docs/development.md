# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

```bash
cd <volt-repo>
npm install
npm run build
```

Run from source:

```bash
/path/to/volt/volt-test.sh
```

The script can be run from any directory. Volt keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "voltConfig": {
    "name": "volt",
    "configDir": ".volt"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.volt/agent/volt-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
