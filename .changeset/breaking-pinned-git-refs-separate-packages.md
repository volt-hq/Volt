---
"@hansjm10/volt-coding-agent": minor
---

breaking(packages): Each pinned git ref is now its own package with its own checkout, so store packages from the same repository install side by side instead of replacing each other. ([#659](https://github.com/volt-hq/Volt/issues/659))

Migration: `volt install git:host/user/repo@new-ref` now installs the new ref beside the installed one instead of moving it. To move a package to a new ref, `volt remove git:host/user/repo@old-ref` and install the new one. `volt remove`, `volt update`, and `volt store remove` with a repository source without a ref still act on the repository's pinned ref when it is the only one configured in the scope, and fail when there are several; name the ref then. A user-scope and a project-scope entry of one repository at different refs are now two packages that both load: when they declare the same extension id, the user-scope one runs and the project one is reported as not loaded, so remove the entry you do not want. Existing pinned packages are cloned again into `<path>@<ref>` on the next start; their previous checkout at `<path>` is no longer used and can be deleted.

`volt store update` installs a catalog package's new pin beside the installed one and replaces it once its permissions are acknowledged; declining keeps the installed pin. Installing a catalog package that is already installed at another pin points to `volt store update`.
