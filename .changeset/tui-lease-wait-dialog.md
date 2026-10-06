---
"@hansjm10/volt-coding-agent": patch
---

improvement(tui): Resuming a session whose remote turn is still running asks in a dialog with Stop remote turn and Cancel. ([#585](https://github.com/volt-hq/Volt/issues/585))

The dialog replaces the wait shown in place of the editor and clears itself once the session opens. Only the TUI that is resuming sees and answers it; phones on the same session do not.
