---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Editing the `before_provider_request` payload in place now changes only that request instead of the registered tool parameter schemas, which for built-in tools reached every session in the process. ([#806](https://github.com/volt-hq/Volt/issues/806))
