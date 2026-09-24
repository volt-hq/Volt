---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Fixed compaction failing on Claude adaptive-thinking models such as Opus 5.5, on Anthropic and Amazon Bedrock, because thinking used up the summary's output limit.
