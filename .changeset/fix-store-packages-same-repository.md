---
"@hansjm10/volt-coding-agent": patch
---

fix(store): Fixed store packages from the same repository replacing each other: each pinned git ref is now its own package with its own checkout, so several store packages install side by side. ([#659](https://github.com/volt-hq/Volt/issues/659))

`volt install git:host/user/repo@new-ref` now installs the new ref beside other refs of the repository instead of moving the installed one; to move a package to a new ref, `volt remove` the old ref and install the new one. `volt store update` installs a catalog package's new pin beside the installed one and replaces it once its permissions are acknowledged; declining keeps the installed pin. Installing a catalog package already installed at another pin points to `volt store update`.
