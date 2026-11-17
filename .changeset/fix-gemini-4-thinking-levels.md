---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

fix(models): Gemini 4 models on Google, Vertex AI, and OpenCode no longer fail with HTTP 400, sending thinking levels instead of thinking budgets, with Extra high thinking on Gemini 4 Hydrogen and Vertex AI requests that allow compacted history.
