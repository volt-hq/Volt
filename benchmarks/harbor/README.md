# Volt Harbor evaluation

This directory contains Volt's repository-owned Harbor adapter and the first fixed-model evaluation milestone. The committed pilot is:

- Harbor `0.13.2`
- Terminal-Bench `2.1` at dataset digest `sha256:7d7bdc1c...a0699a`
- 25 precommitted tasks
- Volt, Claude Code, Codex, and OpenCode
- one attempt per agent/task: 100 trials total
- one upstream model: `anthropic/claude-sonnet-4-5-20250929`
- high reasoning effort, no Harbor retries, no gateway retries

The four harnesses retain their native prompts, tools, context management, and client-side recovery. Those are harness behavior. Harbor conditions, task images, upstream model, routing, reasoning profile, attempt count, and external retry policy are fixed.

## Operator quick start

`volt-bench` is repository-only benchmark tooling. It is not part of the Volt CLI or published customer package.

Install the pinned environment, configure the upstream key and an explicit maximum pilot budget, then run the 25-task × 4-agent pilot:

```bash
uv sync --project benchmarks/harbor --frozen
export UPSTREAM_ANTHROPIC_API_KEY='sk-ant-...'
export PILOT_MAX_BUDGET_USD='500'

uv run --project benchmarks/harbor --frozen volt-bench doctor
uv run --project benchmarks/harbor --frozen volt-bench run pilot
```

On the first run, the CLI builds and validates the exact four-package Volt bundle under the user cache directory (`%LOCALAPPDATA%/volt-bench` on Windows or `$XDG_CACHE_HOME/volt-bench`/`~/.cache/volt-bench`). Managed mode starts digest-pinned LiteLLM and PostgreSQL containers, creates a 24-hour model-, concurrency-, and budget-scoped worker key, launches the pilot, revokes the key, removes the containers and database volume, and runs strict analysis. The upstream key remains in the managed gateway and is never passed to Harbor agents.

Inspect and analyze local jobs:

```bash
uv run --project benchmarks/harbor --frozen volt-bench jobs list
uv run --project benchmarks/harbor --frozen volt-bench jobs show <job-name>
uv run --project benchmarks/harbor --frozen volt-bench analyze <job-name> --strict
uv run --project benchmarks/harbor --frozen volt-bench view <job-name>
```

`view` starts Harbor's local web viewer on `127.0.0.1:8080-8089`. Jobs and raw artifacts remain under `jobs/volt-harbor/` and are not committed. Put `--json` before the command for machine-readable `doctor`, `prepare`, and `jobs` output.

Useful options:

```bash
# Build or refresh the local Volt bundle without launching trials.
uv run --project benchmarks/harbor --frozen volt-bench prepare

# Use an already managed LiteLLM gateway instead of ephemeral containers.
uv run --project benchmarks/harbor --frozen volt-bench run pilot \
  --gateway external --job-name my-pilot

# Use another jobs directory or an existing bundle.
uv run --project benchmarks/harbor --frozen volt-bench run pilot \
  --jobs-dir /tmp/volt-jobs \
  --volt-package-dir /tmp/volt-eval-release/tarballs

# Deliberately use pinned registry packages instead of a local bundle.
uv run --project benchmarks/harbor --frozen volt-bench run pilot --use-registry

# Use an externally managed gateway on a dedicated Docker network.
uv run --project benchmarks/harbor --frozen volt-bench run pilot \
  --gateway external --gateway-network volt-bench-external \
  --container-gateway-url http://volt-bench-gateway-proxy:4000
```

External mode reads `PILOT_GATEWAY_KEY`, `PILOT_GATEWAY_MASTER_KEY`, `PILOT_GATEWAY_NETWORK`, `PILOT_GATEWAY_URL`, and optional `PILOT_GATEWAY_HEALTH_URL`, and the configured pilot budget. `doctor` and `prepare` make no model calls. `run pilot` is noninteractive after its explicit budget is supplied, so agents and CI can use stable exit codes.

Managed mode creates a per-run Docker network shared by the gateway and a pinned HAProxy sidecar for each trial. The task container reaches only its trial-local `volt-bench-gateway-proxy`; it is not attached to the shared gateway network or given a host-gateway mapping. The published host port is used only for operator preflight and defaults to loopback. Apply host firewall rules if overriding the loopback bind.

## Fairness boundary

A local LiteLLM gateway exposes the same upstream deployment through both Anthropic Messages and OpenAI-compatible APIs. Claude Code uses the Anthropic surface; Volt, Codex, and OpenCode use OpenAI-compatible surfaces. This isolates the upstream model and route, but API-protocol differences remain part of each harness stack. Do not describe this as a raw model comparison or combine it with product-default results.

The gateway has one deployment per alias, no fallback, and zero gateway retries. Harbor also uses one attempt and zero trial retries. Native client retries are not forcibly patched out because doing so would modify the evaluated harnesses; trajectories and adapter metadata should be used to identify recovery behavior.

## Layout

- `agents/volt.py`: pinned `BaseInstalledAgent` implementation, Volt JSONL capture, ATIF conversion, usage extraction, and workspace evidence.
- `agents/run_only_secrets.py`: thin wrappers that preserve native competitor behavior while withholding inference credentials from package installation commands.
- `configs/pilot.yaml`: four-agent, 25-task pilot.
- `configs/smoke-*.yaml`: oracle, no-op, five-task Volt, and isolated local-auth checks.
- `gateway/litellm.yaml`: dual-protocol fixed-model route.
- `manifests/terminal-bench-2.1-pilot-v1.json`: deterministic task manifest.
- `scripts/run_pilot.py`: validation, runtime route/package preflight, launch, post-run completeness checks, and run-manifest capture.
- `scripts/analyze.py`: success, efficiency, reliability, and paired-outcome reporting.
- `scripts/select_pilot.py`: reproducible stratified selection.

## Prerequisites

- Docker
- Python 3.12–3.14
- `uv`
- all four exact Volt `0.79.6` npm packages published, or a local-release `tarballs/` directory containing `volt-ai`, `volt-agent-core`, `volt-tui`, and `volt-coding-agent`
- an Anthropic API key with access to the pinned model
- disposable PostgreSQL storage for scoped LiteLLM worker keys

Create the pinned environment and run local checks without model calls:

```bash
uv sync --project benchmarks/harbor --frozen
uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.run_pilot --validate-only
uv run --project benchmarks/harbor --frozen \
  python -m unittest discover -s benchmarks/harbor/tests -v
```

The `0.79.6` Volt workspace packages are not currently available from the public npm registry. Create the exact four-package bundle outside the repository with the existing release tooling; do not substitute only the coding-agent tarball because its three Volt dependencies are also unpublished:

```bash
npm run release:local -- \
  --out /tmp/volt-eval-release --force --skip-install --skip-bun-install
```

Use `/tmp/volt-eval-release/tarballs` as `VOLT_HARBOR_PACKAGE_DIR` or `--volt-package-dir`. Launchers validate every package name/version and record every SHA-256 digest. `VOLT_HARBOR_PACKAGE_DIR` is intentionally distinct from Volt's own `VOLT_PACKAGE_DIR` runtime asset override.

## Reproduce the task manifest

Export the pinned dataset, then compare the generated bytes with the committed file:

```bash
harbor datasets download \
  terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a \
  --output-dir /tmp/volt-tbench-metadata --export

uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.select_pilot \
  /tmp/volt-tbench-metadata/terminal-bench-2-1 \
  --check benchmarks/harbor/manifests/terminal-bench-2.1-pilot-v1.json
```

Selection uses Hamilton apportionment over `(category, difficulty)` strata. Tasks within each stratum are ranked by `SHA-256("volt-tbench-2.1-pilot-v1\0" + task_name)`. The result contains 15 medium, 9 hard, and 1 easy task across 11 categories.

## Start an external fixed-model gateway manually

Use three distinct secrets: the upstream provider key, a host-only LiteLLM master key, and a scoped worker key for agents. Point `DATABASE_URL` at disposable PostgreSQL storage and keep `LITELLM_SALT_KEY` stable for that database. The gateway must be a container on a dedicated Docker network so trials do not receive a route to unrelated host services:

```bash
export UPSTREAM_ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://...'
export PILOT_GATEWAY_MASTER_KEY="$(python -c 'import secrets; print("sk-" + secrets.token_urlsafe(32))')"
export LITELLM_SALT_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export PILOT_GATEWAY_NETWORK='volt-bench-external'

docker network create "$PILOT_GATEWAY_NETWORK"
docker run -d --name volt-bench-external-gateway \
  --network "$PILOT_GATEWAY_NETWORK" \
  --network-alias volt-bench-gateway \
  -p 127.0.0.1:4000:4000 \
  -e DATABASE_URL -e LITELLM_SALT_KEY -e PILOT_GATEWAY_MASTER_KEY \
  -e UPSTREAM_ANTHROPIC_API_KEY \
  -v "$PWD/benchmarks/harbor/gateway/litellm.yaml:/app/config.yaml:ro" \
  ghcr.io/berriai/litellm-database:v1.91.1@sha256:a0952ba673e930ff6fcf4c78e291a7fe60ce0f9cd0d0d0f5a1fe6fa3d0624c89 \
  --config /app/config.yaml --host 0.0.0.0 --port 4000
```

In another shell, generate a time-, model-, concurrency-, and budget-limited virtual key with the host-only master key. Set the budget before running:

```bash
export PILOT_MAX_BUDGET_USD='500'
export PILOT_GATEWAY_KEY="$(
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
    "$PILOT_GATEWAY_MASTER_KEY" \
  | curl -fsS --config - http://127.0.0.1:4000/key/generate \
      --data "{\"models\":[\"pilot-model\",\"openai/pilot-model\"],\"duration\":\"24h\",\"max_budget\":$PILOT_MAX_BUDGET_USD,\"max_parallel_requests\":16}" \
  | python -c 'import json, sys; print(json.load(sys.stdin)["key"])'
)"
```

The master and upstream keys stay in the gateway process; Harbor receives only the scoped worker key. Trials use `http://volt-bench-gateway-proxy:4000`; the trusted probe uses `http://volt-bench-gateway:4000` on `PILOT_GATEWAY_NETWORK`. `PILOT_GATEWAY_HEALTH_URL` is the host-side preflight URL and defaults to `http://127.0.0.1:4000`. Do not attach the gateway network to unrelated host or infrastructure services. See LiteLLM's [virtual-key documentation](https://docs.litellm.ai/docs/proxy/virtual_keys).

## Adapter parity checks

First run Harbor's controls. Oracle should solve the task; no-op should not:

```bash
uv run --project benchmarks/harbor --frozen harbor run \
  --config benchmarks/harbor/configs/smoke-oracle.yaml --yes
uv run --project benchmarks/harbor --frozen harbor run \
  --config benchmarks/harbor/configs/smoke-nop.yaml --yes
```

For the five-task Volt smoke, export the gateway values used by Harbor and its installed agents:

```bash
export PILOT_GATEWAY_NETWORK='volt-bench-external'
export PILOT_GATEWAY_URL='http://volt-bench-gateway-proxy:4000'
export PILOT_OPENAI_BASE_URL="$PILOT_GATEWAY_URL/v1"
export OPENAI_BASE_URL="$PILOT_OPENAI_BASE_URL"
export OPENAI_API_KEY="$PILOT_GATEWAY_KEY"
# Required until all four exact workspace packages are published:
export VOLT_HARBOR_PACKAGE_DIR='/tmp/volt-eval-release/tarballs'

uv run --project benchmarks/harbor --frozen harbor run \
  --config benchmarks/harbor/configs/smoke-volt.yaml --yes
```

Do not proceed to the paid pilot unless the control outcomes are correct, all five Volt trials produce verifier results, and every Volt trial contains `agent/trajectory.json` with `settled: true` in its final metrics. Terminal-Bench verifiers install tools from the network; a control reward is invalid if `verifier/test-stdout.txt` shows DNS, connection, or `uv` bootstrap failure. Repeat the control rather than treating that reward as agent behavior.

## Local subscription auth checks

Local-auth checks are separate product-auth tracks. They do not use the fixed-model gateway and must not be merged with the 100-trial pilot results. Each runs only `fix-git`, with one concurrent trial, to limit credential refresh and account usage.

Validate their structure without reading credentials:

```bash
uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.run_local_auth \
  --provider openai --validate-only
uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.run_local_auth \
  --provider anthropic --validate-only
```

### OpenAI subscription

Sign into Volt with `/login` → ChatGPT Plus/Pro and sign into Codex with `codex login`. The launcher defaults to `~/.volt/agent/auth.json` and `~/.codex/auth.json`; override them with `--volt-auth`, `--codex-auth`, `VOLT_AUTH_JSON_PATH`, or `CODEX_AUTH_JSON_PATH`.

```bash
uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.run_local_auth \
  --provider openai --acknowledge-credential-risk \
  --volt-package-dir /tmp/volt-eval-release/tarballs
```

This compares Volt and Codex on `openai-codex/gpt-5.4` using their native subscription authentication.

### Anthropic subscription

Sign into Volt with `/login` → Claude Pro/Max. Claude Code's host login is not copied automatically; create an explicit token with `claude setup-token` and export it:

```bash
export CLAUDE_CODE_OAUTH_TOKEN='...'
uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.run_local_auth \
  --provider anthropic --acknowledge-credential-risk \
  --volt-package-dir /tmp/volt-eval-release/tarballs
```

This compares Volt and Claude Code on `anthropic/claude-sonnet-4-5`. Volt's third-party Anthropic subscription access may draw from billed extra usage rather than plan limits; confirm account billing before running.

Use dedicated benchmark logins, not a primary personal or organization account. The launcher reads and validates each credential once, then creates private `0600` snapshots containing only the selected Volt provider and the exact validated Codex bytes. The adapters upload snapshots outside `/logs/agent`, enforce non-suppressed credential-file cleanup after the turn, and request Docker environment deletion. The launcher also owns Harbor's process group and performs label-scoped removal and verification of any trial containers, volumes, and networks before deleting host snapshots. If Docker cleanup cannot be verified after retries, the run is invalid and the private snapshot directory is retained and reported for manual recovery rather than unlinking a still-mounted credential. Credential values are not written to `run-manifest.json`. Refreshed credentials are not copied back to the host, so the launcher requires Volt and Codex access tokens to remain valid for at least 60 minutes and stops before launch otherwise. Refresh the dedicated host logins first rather than allowing benchmark containers to rotate shared credentials.

The selected provider credential necessarily enters the benchmark container and can reach arbitrary public hosts because Harbor's Docker backend does not enforce hostname allowlists. The run-only wrappers keep credentials out of downloaded package installers and Docker command arguments, but they cannot protect a credential from task code or privileged host inspection during the agent turn. These launchers therefore require `--acknowledge-credential-risk` and are restricted to the reviewed one-task smoke. Use an external egress-enforcing proxy/firewall for stronger isolation. The fixed-model gateway track is preferable for broad task sets because it exposes only a short-lived, model- and budget-limited worker key.

## Run the 100-trial pilot manually

The `volt-bench run pilot` quick start above is preferred. To use the lower-level launcher with an external gateway:

```bash
export PILOT_GATEWAY_KEY='sk-scoped-worker-...'
export PILOT_GATEWAY_MASTER_KEY='the same host-only master used by LiteLLM'
export PILOT_GATEWAY_NETWORK='volt-bench-external'
export PILOT_GATEWAY_URL='http://volt-bench-gateway-proxy:4000'
export PILOT_GATEWAY_HEALTH_URL='http://127.0.0.1:4000'

uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.run_pilot \
  --volt-package-dir /tmp/volt-eval-release/tarballs
```

Omit `--volt-package-dir` after all four exact releases are available from the configured npm registry. When supplied, the launcher validates and hashes all four tarballs, uploads them, and installs them with local `file:` dependencies and overrides equivalent to `release:local`. The launcher also validates the protocol, probes the gateway from the host and from the pinned `curlimages/curl:8.16.0` Docker image, requires one live deployment per alias, verifies the exact upstream model and zero retries, and attests that the worker key has the declared finite budget, 2–25 hour expiry, exact model scope, and concurrency limit. It rejects unsafe job paths, constructs a minimal allowlisted child environment rather than forwarding the host environment, and writes `run-manifest.json` without credential values. After Harbor exits, it requires the exact 100-trial matrix, rewards, no trial exceptions, nonempty valid verifier CTRF artifacts, and complete protocol-v3 settled Volt trajectories with assistant events; an incomplete job exits nonzero even if Harbor itself returned success. The launcher revokes the worker key through LiteLLM's `/key/delete` endpoint on normal completion or failure and marks the run invalid if revocation fails; finite expiry remains the backstop for process termination that prevents cleanup.

## Captured evidence

Harbor records each verifier result, timing, exception, version, model identity, and `AgentContext`. The Volt adapter additionally writes:

- `agent/volt.jsonl`: complete Volt JSON event stream
- `agent/volt.stderr`: stderr separated from machine-readable events
- `agent/trajectory.json`: ATIF v1.7 trajectory
- `agent/final.patch`: binary Git diff when `/app` is a Git worktree
- `agent/workspace-before.txt` and `agent/workspace-after.txt`: Git status or deterministic file inventories
- usage metadata: input/output/cache tokens, reported cost, tool calls/errors, compactions, retries, agent runs, response models, and terminal settled state

Volt currently does not expose the summarization call's usage in `compaction_end`. For compacted trials, ordinary assistant-call totals are retained only as lower-bound metadata and aggregate token/cost coverage is marked incomplete rather than understated.

Harbor's built-in Claude Code, Codex, and OpenCode adapters also emit ATIF trajectories. The verifier, not textual output or the patch, determines success.

## Analyze results

```bash
uv run --project benchmarks/harbor --frozen \
  python -m benchmarks.harbor.scripts.analyze \
  jobs/volt-harbor/<job-name> \
  --manifest benchmarks/harbor/manifests/terminal-bench-2.1-pilot-v1.json \
  --strict
```

This produces `analysis/summary.json` and `analysis/summary.md` with:

- solved count, pass rate, and 95% Wilson interval
- verifier reward and exceptions
- reported cost, cost coverage, and cost per solved task
- token coverage and tokens per solved task
- agent time
- trajectory coverage
- tool calls, tool errors, compactions, and Volt-visible native retries
- pairwise both/left-only/right-only/neither outcomes on matched tasks
- warnings for missing, extra, or duplicate tasks
- detection of verifier DNS, connection, and `uv` bootstrap failures

`--strict` fails when verifier infrastructure or task-parity warnings are present. Do not score those failures as agent failures and do not selectively retry only the affected agent. To preserve the precommitted one-attempt policy, discard an infrastructure-invalid pilot job and rerun the complete 100-trial job; publish the first complete infrastructure-clean run. Keep invalid job artifacts as reliability evidence.

Cost-per-solve and tokens-per-solve are intentionally omitted when an agent lacks complete coverage. With 25 tasks, confidence intervals remain wide; this pilot is a harness comparison and integration validation, not a definitive leaderboard.
