---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-agent-core": minor
---

breaking(streaming): Made assistant streaming events immutable and self-contained. ([#72](https://github.com/volt-hq/Volt/issues/72))

Custom providers must emit fragments through `AssistantStreamNormalizer`. Event consumers must read the immutable `snapshot`, contiguous `seq`, and typed `toolState` fields instead of `partial` or provider-owned argument scratch fields.
