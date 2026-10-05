---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): Extensions now have typed settings that `/extensions`, `volt config`, and paired clients edit as a form, and the permissions an extension declares are shown at install and checked by the extension API. ([#585](https://github.com/volt-hq/Volt/issues/585))

The settings key that lists local extension paths is renamed from `extensions` to `extensionPaths`, in global, project, and profile settings. `extensions` now holds per-extension state by manifest id: `extensions.<id>.settings` stores an extension's setting values. Volt ignores an `extensions` path list and warns until it is renamed.

An extension declares `settings` in its manifest (a flat object of string, string enum, boolean, and integer settings) and reads the effective values from `volt.settings`: each default, then the global value, then a trusted project's value. Changes arrive as the `settings_changed` event in every open conversation, and `volt.updateSettings(values, { scope })` stores values. Type them with `ExtensionAPI<ExtensionSettingsOf<typeof manifest>>`. Manifests whose defaults, bounds, patterns, or `required` names do not hold together, or whose string settings name a credential, are refused; keep credentials in the auth storage. Move configuration an extension read from its own environment variables or config files into manifest settings.

The extension API now enforces declared permissions: `volt.exec` rejects without `exec`; `volt.registerProvider`, `volt.unregisterProvider`, and provider registration through `ctx.modelRegistry` throw without `providers`; and `ctx.modelRegistry.authStorage`, `getApiKeyAndHeaders`, `getApiKeyForProvider`, and `login` throw without `secrets`. Add the permissions your extension uses to its manifest's `permissions`. `volt install`, `volt update`, `/store install`, and `/store update` list a package's unacknowledged permissions and ask; declining an install removes the package, and declining a store update keeps the current version. Acknowledgments are kept in `~/.volt/agent/extension-permissions.json`.

`/extensions` lists the conversation's extensions and opens one's detail and settings (`/extensions <id>` opens it directly); installed packages are under "Installed packages". In `volt config`, Enter on an extension row marked "settings" opens its settings, and Space toggles a row.
