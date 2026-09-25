---
"@hansjm10/volt-coding-agent": minor
---

breaking(rpc): Added explicit epoch and sequence positions to assistant streaming frames. ([#72](https://github.com/volt-hq/Volt/issues/72))

RPC clients must adopt assistant base, snapshot, and final frames unconditionally, apply only contiguous compact deltas within an epoch, and seed resumable tool arguments from snapshot `toolState`. TypeScript clients can use `StreamProjectionDecoder` for this reconstruction.
