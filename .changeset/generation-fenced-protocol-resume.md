---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(remote): Require log generation when resuming cached conversations so a recreated session cannot mix old and new history. ([#957](https://github.com/volt-hq/Volt/issues/957))

Update hosts and clients together, including volt-app's generation-fenced resume milestone in [#464](https://github.com/volt-hq/volt-app/issues/464). Keep each snapshot's required `sessionGeneration` alongside its fold and ordinal, and send it with numeric `subscribe.after`. A fresh `after:"snapshot"` request must omit it. Discard ordinal-only recovery records rather than inferring a generation; a generation-mismatch snapshot replaces the old fold and entry-keyed overlays. ProtocolClient and its observations carry the generation automatically.
