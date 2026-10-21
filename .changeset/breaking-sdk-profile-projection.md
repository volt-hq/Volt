---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): A protocol `Profile` now groups its projection settings under `Profile.projection`. ([#935](https://github.com/volt-hq/Volt/issues/935))

Read `fidelity`, `includes`, `source`, and `sourceCut` from `profile.projection` (the exported `Projection` type) instead of from `Profile`, and `textScalars` and `presentationBytes` from `profile.projection` instead of from `ProfileLimits`. Passing `localProfile` to `serveConnection` is unchanged.
