---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Added CLI and SDK preparation allowances up to 1,000 ms while keeping the default at zero. ([#439](https://github.com/volt-hq/Volt/issues/439))

The opt-in Jev example requests 800 ms with a 1.5-second task deadline; deterministic-only preparation still requests 100 ms. Waiting ends when tasks settle, retains fallback at the cutoff, and never renews on later turns.
