---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(remote): Hosts accept host request kinds they do not know from newer clients instead of closing the connection. ([#982](https://github.com/volt-hq/Volt/issues/982))

The protocol contract marks intent names, intent categories and sources, rejection, query error, and fatal codes, and catalog names as open, and the `@hansjm10/volt-protocol` README documents how clients tolerate what a newer host adds within protocol 1.
