# Review-quality benchmark

This benchmark scores structured review reports against small repository-style before/after fixtures. The checked-in corpus contains both a buggy change and a clean change. Expected findings are identified by semantic issue keys and accepted path/line ranges; reviewer prose is not scored.

Run the deterministic checked-in sample without API calls:

```sh
npm run benchmark:review-quality
```

The command writes one JSON evaluation to stdout. It reports precision, recall, clean-diff/no-finding accuracy, duplicate and invalid-anchor rates, changed-file and changed-hunk coverage, latency, token use, and provider-reported cost.

A finding is a true positive only when its semantic issue key and changed-line anchor match an expected issue. Repeated issue keys in one case count as duplicates. An anchor is invalid when it does not overlap an added or modified after-file line. Coverage comes from the report's explicit `reviewedFiles` and `reviewedHunks` lists.

Real-model mode is opt-in and is never used by normal tests. It requires all three variables:

```sh
VOLT_REVIEW_QUALITY_REAL_MODEL=1 \
VOLT_REVIEW_QUALITY_PROVIDER=openai \
VOLT_REVIEW_QUALITY_MODEL=gpt-5.4-mini \
npm run benchmark:review-quality
```

Provider credentials use the normal Volt AI environment variables. Real-model mode makes one request per corpus case and aggregates provider usage and reported cost.
