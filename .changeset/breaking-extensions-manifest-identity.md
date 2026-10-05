---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(extensions): Every extension now declares a manifest whose `id` is its identity, and an extension without a valid manifest fails to load with an error that says what to fix. ([#585](https://github.com/volt-hq/Volt/issues/585))

A single-file extension (a `.ts` or `.js` file, or a directory's `index.ts`) exports its manifest: add `import { defineManifest } from "@hansjm10/volt-coding-agent"` and `export const manifest = defineManifest({ id: "my-extension", displayName: "My Extension" })`. The id is lowercase letters, digits, and `-`, at most 64 characters; `volt`, `core`, `builtin`, `host`, and `ext` are reserved. Single-file extensions load only from your and a trusted project's extension directories, paths in settings, and `-e` paths.

A package replaces `"volt": { "extensions": [...] }` in package.json with its manifest: `"volt": { "id": "my-package", "displayName": "My Package", "entry": "src/index.ts" }`, keeping `skills`, `prompts`, and `themes` as before. A package declares one extension; `entry` must be a file inside the package, and the extension's version is the package's `version`. Packages installed from npm or git load an extension only through this manifest, which Volt reads without running package code. A package filter's `extensions` key now only turns the package's extension on (omitted) or off (`[]`).

Two extensions cannot share an id: a user or `-e` extension beats a project extension, otherwise the one loaded first wins, and the other is reported and not loaded.

SDK hosts pass `extensionFactories: [{ manifest, factory }]` instead of bare factory functions. `ExtensionError.extensionPath` is now `extensionId` (the manifest id, or a label such as `<runtime>` for host errors), and `RegisteredTool`, `ResolvedCommand`, `ExtensionFlag`, and `ExtensionShortcut` carry `extensionId` instead of `extensionPath`.

Extension work kinds are `ext:<manifest id>/<kind>` (`EXTENSION_WORK_KIND_PATTERN` in `@hansjm10/volt-protocol` now refuses reserved ids). Protocol clients invoke extension commands as the intent `extension.command.<manifest id>.<command>` instead of an opaque per-catalog name. Command names are a letter or digit, then at most 63 letters, digits, `_`, `:`, and `-`; when an earlier extension took a name, the later command is `/<manifest id>:<command>` instead of `/<command>:<n>`. Volt no longer serves `@hansjm10/volt-tui` to extensions; an extension that still imports it must depend on it itself.
