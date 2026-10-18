---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Reopening a conversation on a phone, or opening it on a second phone, reuses what the host already prepared for it instead of presenting every entry again ([#935](https://github.com/volt-hq/Volt/issues/935)).

SDK: a `Profile`'s projection settings moved to `Profile.projection` (the exported `Projection` type): `fidelity`, `includes`, `source`, and `sourceCut` are no longer on `Profile`, and `textScalars` and `presentationBytes` are no longer in `ProfileLimits`. Passing `localProfile` to `serveConnection` is unchanged.
