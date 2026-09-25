---
"@hansjm10/volt-ai": patch
---

fix(ai): Fixed Claude Opus 5 and Claude Sonnet 5 requests failing with a 400 error when thinking or a temperature is set, and made their xhigh and max thinking levels available.

Claude models now use adaptive thinking unless they are Claude 4.5 or earlier, and omit temperature from Claude 4.7 onward, so new Claude releases no longer need a code change to accept these requests. Claude Opus 4.7 and later expose the max thinking level on Anthropic, Amazon Bedrock, and gateway providers. GitHub Copilot now routes Claude 5 models through the Anthropic Messages API. Amazon Bedrock application inference profiles whose name mentions Claude without a version now use adaptive thinking.
