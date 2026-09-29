---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

improvement(models): Updated the model catalog with GPT-6.1 Sol, Grok 4.7 on Bedrock, and current provider pricing and limits.

GPT-6.1 Sol is available through OpenAI, Azure OpenAI, OpenAI Codex, GitHub Copilot, OpenCode, OpenRouter, and Vercel AI Gateway. It supports low through max reasoning and Fast mode, but not disabled reasoning. OpenAI Codex now defaults to GPT-6.1 Sol instead of GPT-5.5.

All OpenAI Codex models now use Codex's default 272K-token context window, including GPT-5.6 Sol (previously 1M) and GPT-6 Astra (previously 1.05M). GPT-6 and GPT-5.6 models accept up to 872K tokens through a `contextWindow` model override.

Removed GPT-5.3 Codex Spark, GPT-5.4, and GPT-5.4 mini from OpenAI Codex, where they are retired for ChatGPT sign-in. Removed retired Together Kimi K2.6 and Kimi K2.7 Code and Mistral Magistral Small entries; Together now defaults to Kimi K3 instead of Kimi K2.6.
