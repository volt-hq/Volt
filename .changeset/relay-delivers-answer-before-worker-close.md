---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Fixed a paired device sometimes losing the answer to an intent that ends its relayed conversation stream, such as unregistering its workspace, when it sent another frame before the stream closed ([#793](https://github.com/volt-hq/Volt/issues/793)).
