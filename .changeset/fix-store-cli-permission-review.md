---
"@hansjm10/volt-coding-agent": patch
---

fix(store): `volt store install` and `volt store update` review an extension's permissions as `volt install` does, and an update without a terminal keeps a catalog package at its installed pin when the new pin asks for permissions the installed one did not. ([#585](https://github.com/volt-hq/Volt/issues/585))

In a terminal, an install asks to acknowledge the permissions not acknowledged yet and removes the package when declined; an update to a new catalog pin asks for the new ones and reinstalls the previous pin when declined (or removes the package when the previous pin cannot be reinstalled). Ending a permission prompt with Ctrl+C or Ctrl+D now declines, in `volt install` and `volt update` too, instead of exiting with the package installed. Without a terminal, permissions are listed unacknowledged, and an update to a new catalog pin reads the pin's manifest before installing it and skips the package (exit code 1) when it declares a permission the installed pin does not, or cannot be read.
