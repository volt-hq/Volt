---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): `volt.on()` now throws for an event name Volt does not define, so an extension that subscribes to a misspelled or nonexistent event fails to load with an error naming the extension and the event instead of loading a handler that never runs. ([#582](https://github.com/volt-hq/Volt/issues/582))

Subscribe only to the events listed in the extensions documentation. Remove subscriptions to events that do not exist: for example, replace `volt.on("session_switch", ...)` with `volt.on("session_start", ...)`, which fires with reason `new`, `resume`, or `fork` when the session changes. TypeScript extensions that type `volt` as `ExtensionAPI` already get a compile error for an unknown name.
