---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-protocol": patch
---

internal(agent): Added the `Conversation` kernel host hooks coding-agent needs to run on it: turn reservations, compaction before a turn's first request with retry or continue, delivery and compaction batches that carry host entries and messages, navigation preparation, input admission without delivery with a durable started fence, durable host-queued messages with a host origin, and a client input digest shared through the protocol; nothing uses them yet. ([#585](https://github.com/volt-hq/Volt/issues/585))
