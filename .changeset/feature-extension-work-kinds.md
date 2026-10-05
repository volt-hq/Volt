---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-agent-core": patch
---

feature(extensions): Extensions can run background work that every client sees, follows, and cancels. ([#585](https://github.com/volt-hq/Volt/issues/585))

An extension registers a kind with `volt.registerWorkKind(name, kind)` and starts its work with `ctx.startWork(name, { title, input }, run)`: the work is recorded in the conversation as `ext:<extension>/<name>`, reports progress, checkpoints, and output, and ends with a result that can ride the model's next turn (`delivery: "message"`) or wake it (`"wake"`). Only the registering extension starts its kinds, and reloading the extensions interrupts their running work. A paired device cannot read the output of work whose extension kind the host no longer knows. A stop that delivers queued input no longer starts an empty turn when only such a quiet notice is queued.
