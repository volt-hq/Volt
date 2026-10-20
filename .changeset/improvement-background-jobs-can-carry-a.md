---
"@hansjm10/volt-coding-agent": patch
---

improvement(jobs): Background jobs can carry a short description that job lists, the work status, job cards, and completion notices show instead of the raw command.

Job cards now read in plain words ("wait for Run the unit tests", "check on …", "cancel …", "list background jobs") and name the job by its label instead of its id, also while a wait runs. Their table shows "Running" instead of "Running at capture", a Command or Agent type instead of the tool name, and job ids only when expanded.
