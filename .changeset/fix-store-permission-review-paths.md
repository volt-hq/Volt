---
"@hansjm10/volt-coding-agent": patch
---

fix(store): `volt install` reviews the permissions of a package installed by a path relative to the current directory, and `volt update <source>` reviews the package it updated however its source is spelled. ([#585](https://github.com/volt-hq/Volt/issues/585))

`/store` in the TUI does the same, and when you decline an update's new permissions it reinstalls the reviewed pin, removes the package if that fails, and reviews the reinstalled revision when its source follows a branch, as `volt store update` does. Declining that revision's permissions too now removes the package in both, instead of leaving it installed unacknowledged, and an install whose package cannot be found to review is removed.
