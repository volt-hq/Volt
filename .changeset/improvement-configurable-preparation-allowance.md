---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Added CLI and SDK preparation allowances up to 1,000 ms while keeping the default at zero. ([#439](https://github.com/volt-hq/Volt/issues/439))

The deterministic context-preparation example still requests 100 ms. Waiting ends when tasks settle, retains fallback at the cutoff, and never renews on later turns.
