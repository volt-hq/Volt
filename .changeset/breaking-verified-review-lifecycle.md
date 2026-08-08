---
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Upgraded review to immutable two-pass verification with durable structured findings and lifecycle actions.

RPC clients must migrate review results from transient workflow IDs and legacy `file`/`line` and model-authored coverage fields to durable run IDs, structured change/evidence locations, verification metadata, and host-derived coverage. Clients must also handle complete and incomplete results, paginate durable run listings, and use the new finding lifecycle actions.
