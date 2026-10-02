---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): The login service from `volt daemon install-service` keeps starting after `brew upgrade node` removes the previous Homebrew Node version. ([#563](https://github.com/volt-hq/Volt/issues/563))

The service now records Homebrew's `opt/<formula>/bin/node` link instead of the versioned Cellar path. Services installed earlier switch to it at the next `volt update`; to switch now, run `volt daemon install-service`.
