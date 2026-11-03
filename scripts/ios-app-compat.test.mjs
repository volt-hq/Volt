import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
	APP_FACING_PATHS,
	appFacingChanges,
	BASELINE_PATH,
	BREAKS_LABEL,
	CHECKED_LABEL,
	CODING_AGENT_PACKAGE_PATH,
	decideGate,
	decisionComment,
	decisionFingerprint,
	describeBaseline,
	formatChange,
	IROH_BINDING,
	PROTOCOL_CONTRACT_PATH,
	parseBaseline,
	parseDecision,
	runGate,
} from "./ios-app-compat.mjs";

const baselineContract = '{"contract":"baseline"}\n';
const baseline = {
	build: "15",
	version: "1.0.0",
	status: "in App Review",
	appCommit: "a".repeat(40),
	protocolContract: {
		voltCommit: "b".repeat(40),
		sha256: createHash("sha256").update(baselineContract).digest("hex"),
	},
	voltIroh: "1.1.1-volt.2",
};
const baselineText = JSON.stringify(baseline);
const brokerPath = "services/relay-credential-broker/internal/broker/broker.go";

function packageJson(irohVersion, extra = {}) {
	return JSON.stringify({ dependencies: { ...extra, ...(irohVersion ? { [IROH_BINDING]: irohVersion } : {}) } });
}

function changes(paths, { base = {}, head = {} } = {}) {
	return appFacingChanges({
		paths,
		baseline,
		readBase: (path) => base[path],
		readHead: (path) => head[path],
	});
}

test("the committed baseline is well formed", () => {
	const committed = parseBaseline(readFileSync(new URL(`../${BASELINE_PATH}`, import.meta.url), "utf8"));
	assert.match(describeBaseline(committed), /^Volt iOS \S+ \(\d+\), .+$/);
});

test("rejects an incomplete baseline", () => {
	const { voltIroh: _voltIroh, ...missingIroh } = baseline;
	assert.throws(() => parseBaseline(JSON.stringify(missingIroh)), /must record/);
	assert.throws(
		() => parseBaseline(JSON.stringify({ ...baseline, protocolContract: { ...baseline.protocolContract, sha256: "x" } })),
		/must record/,
	);
});

test("a protocol contract that differs from the baseline is app-facing", () => {
	const result = changes([PROTOCOL_CONTRACT_PATH], { head: { [PROTOCOL_CONTRACT_PATH]: '{"contract":"next"}\n' } });
	assert.equal(result.length, 1);
	assert.match(formatChange(result[0]), /protocol contract differs/);
	assert.match(formatChange(result[0]), /Volt bbbbbbbbb/);
});

test("restoring the baseline protocol contract is not app-facing", () => {
	assert.deepEqual(changes([PROTOCOL_CONTRACT_PATH], { head: { [PROTOCOL_CONTRACT_PATH]: baselineContract } }), []);
});

test("deleting the protocol contract is app-facing", () => {
	assert.equal(changes([PROTOCOL_CONTRACT_PATH]).length, 1);
});

test("app-facing paths outside the contract are flagged; their tests and docs are not", () => {
	const flagged = [
		"packages/coding-agent/src/core/remote/iroh/ticket.ts",
		"packages/coding-agent/src/core/remote/iroh/protocol.ts",
		"packages/coding-agent/src/core/remote/iroh/push.ts",
		"packages/coding-agent/src/core/remote/iroh/completion-notifications.ts",
		"packages/coding-agent/src/core/remote/iroh/handshake.ts",
		"packages/coding-agent/src/core/remote/iroh/handshake-reader.ts",
		"packages/coding-agent/src/core/remote/iroh/authorization.ts",
		"packages/coding-agent/src/core/remote/iroh/metadata.ts",
		"packages/coding-agent/src/core/remote/iroh/connection.ts",
		"packages/coding-agent/src/daemon/relay-deployments.ts",
		"packages/coding-agent/src/daemon/iroh-endpoint-ticket.ts",
		"packages/coding-agent/examples/remote/firebase-push-relay/functions/index.js",
		brokerPath,
		"services/relay-credential-broker/internal/database/migrations/0005_replaceable_app_endpoints.sql",
		"services/relay-credential-broker/relay-patch/iroh-relay-1.0.3-jwt-access.patch",
	];
	const ignored = [
		"packages/coding-agent/src/core/remote/iroh/qr.ts",
		"packages/coding-agent/src/core/remote/iroh/control.ts",
		"packages/coding-agent/src/core/remote/iroh/engine.ts",
		"packages/coding-agent/src/daemon/iroh-service.ts",
		"packages/coding-agent/src/daemon/relay-credential.ts",
		"packages/coding-agent/test/daemon-iroh-service.test.ts",
		"packages/coding-agent/examples/remote/firebase-push-relay/functions/index.test.js",
		"packages/coding-agent/examples/remote/firebase-push-relay/README.md",
		"services/relay-credential-broker/internal/broker/reapproval_test.go",
		"services/relay-credential-broker/README.md",
		"AGENTS.md",
	];
	assert.deepEqual(
		changes([...flagged, ...ignored]).map((change) => change.path),
		flagged,
	);
	for (const path of flagged) {
		assert.ok(APP_FACING_PATHS.some(({ pattern }) => pattern.test(path)), path);
	}
});

test("managed relay and credential service hostnames appear only in watched source files", () => {
	const root = new URL("../", import.meta.url);
	const hostname = /iroh-relay[a-z-]*\.volt-cli\.dev|credentials(?:-canary)?\.volt-cli\.dev/;
	const sources = readdirSync(new URL("packages/", root)).flatMap((name) => {
		const src = new URL(`packages/${name}/src/`, root);
		if (!existsSync(src)) return [];
		return readdirSync(src, { recursive: true })
			.map((path) => `packages/${name}/src/${String(path).split("\\").join("/")}`)
			.filter((path) => path.endsWith(".ts"));
	});
	const defining = sources.filter((path) => hostname.test(readFileSync(new URL(path, root), "utf8")));
	assert.ok(defining.length > 0, "expected the relay deployments to be defined in product source");
	for (const path of defining) {
		assert.ok(
			APP_FACING_PATHS.some(({ pattern }) => pattern.test(path)),
			`${path} names a managed relay or credential service but is not an app-facing path; keep these in packages/coding-agent/src/daemon/relay-deployments.ts`,
		);
	}
});

test("changing the Iroh binding away from the baseline is app-facing", () => {
	const result = changes([CODING_AGENT_PACKAGE_PATH], {
		base: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.1.1-volt.2") },
		head: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.2.0-volt.1") },
	});
	assert.equal(result.length, 1);
	assert.match(formatChange(result[0]), /@hansjm10\/volt-iroh 1\.2\.0-volt\.1 \(baseline 1\.1\.1-volt\.2\)/);
});

test("other dependency changes and a return to the baseline Iroh binding are not app-facing", () => {
	assert.deepEqual(
		changes([CODING_AGENT_PACKAGE_PATH], {
			base: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.1.1-volt.2", { yaml: "2.0.0" }) },
			head: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.1.1-volt.2", { yaml: "2.1.0" }) },
		}),
		[],
	);
	assert.deepEqual(
		changes([CODING_AGENT_PACKAGE_PATH], {
			base: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.2.0-volt.1") },
			head: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.1.1-volt.2") },
		}),
		[],
	);
});

test("the decision fingerprint tracks app-facing content and the baseline, nothing else", () => {
	const reviewed = changes([brokerPath], { head: { [brokerPath]: "package broker // v1\n" } });
	const fingerprint = decisionFingerprint(baselineText, reviewed);
	assert.equal(
		decisionFingerprint(baselineText, changes([brokerPath, "AGENTS.md"], { head: { [brokerPath]: "package broker // v1\n" } })),
		fingerprint,
		"a non-app-facing file does not change the fingerprint",
	);
	assert.notEqual(
		decisionFingerprint(baselineText, changes([brokerPath], { head: { [brokerPath]: "package broker // v2\n" } })),
		fingerprint,
		"new content in a reviewed file needs a new decision",
	);
	assert.notEqual(
		decisionFingerprint(baselineText, [
			...reviewed,
			...changes(["packages/coding-agent/src/core/remote/iroh/ticket.ts"], {
				head: { "packages/coding-agent/src/core/remote/iroh/ticket.ts": "export {};\n" },
			}),
		]),
		fingerprint,
		"another app-facing file needs a new decision",
	);
	assert.notEqual(
		decisionFingerprint(JSON.stringify({ ...baseline, build: "16" }), reviewed),
		fingerprint,
		"a new baseline build needs a new decision",
	);
	const irohOnly = (extra) =>
		decisionFingerprint(
			baselineText,
			changes([CODING_AGENT_PACKAGE_PATH], {
				base: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.1.1-volt.2") },
				head: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.2.0-volt.1", extra) },
			}),
		);
	assert.equal(irohOnly({ yaml: "2.0.0" }), irohOnly({ yaml: "2.1.0" }), "unrelated dependencies are ignored");
});

test("decision comments round-trip their fingerprint and name what they cover", () => {
	const covered = changes([brokerPath], { head: { [brokerPath]: "x" } });
	const fingerprint = decisionFingerprint(baselineText, covered);
	const body = decisionComment({ fingerprint, headSha: "c".repeat(40), baseline, changes: covered });
	assert.equal(parseDecision(body), fingerprint);
	assert.match(body, new RegExp(`\`${brokerPath}\``));
	assert.match(body, /c{40}/);
	assert.equal(parseDecision("ios-app-compat-decision fingerprint=abc"), undefined);
});

const fp = "f".repeat(64);
const gate = (overrides) =>
	decideGate({
		appFacing: true,
		fingerprint: fp,
		labels: [],
		action: "synchronize",
		labelName: undefined,
		recordedFingerprint: undefined,
		...overrides,
	});

test("pull requests without app-facing changes pass unless held by hand", () => {
	assert.equal(gate({ appFacing: false }).ok, true);
	assert.equal(gate({ appFacing: false, labels: [CHECKED_LABEL] }).ok, true);
	assert.equal(gate({ appFacing: false, labels: [BREAKS_LABEL] }).ok, false);
});

test("app-facing changes without a decision are labeled on code events only", () => {
	for (const action of ["opened", "synchronize", "reopened"]) {
		const result = gate({ action });
		assert.equal(result.ok, false);
		assert.deepEqual(result.addLabels, [BREAKS_LABEL], action);
	}
	const unlabeled = gate({ action: "unlabeled", labelName: BREAKS_LABEL });
	assert.equal(unlabeled.ok, false);
	assert.deepEqual(unlabeled.addLabels, []);
});

test("adding ios-compat-checked records a decision for the current changes", () => {
	const result = gate({ action: "labeled", labelName: CHECKED_LABEL, labels: [CHECKED_LABEL] });
	assert.equal(result.ok, true);
	assert.equal(result.record, true);
	const later = gate({ labels: [CHECKED_LABEL], recordedFingerprint: fp });
	assert.equal(later.ok, true);
	assert.equal(later.record, false);
});

test("a recorded decision does not cover later app-facing changes", () => {
	for (const action of ["synchronize", "reopened", "labeled", "unlabeled"]) {
		const result = gate({
			action,
			labelName: action === "synchronize" || action === "reopened" ? undefined : "roadmap",
			labels: [CHECKED_LABEL],
			recordedFingerprint: "0".repeat(64),
		});
		assert.equal(result.ok, false, action);
		assert.equal(result.record, false, action);
		assert.deepEqual(result.removeLabels, [CHECKED_LABEL], action);
		assert.deepEqual(result.addLabels, [BREAKS_LABEL], action);
		assert.match(result.message, /no longer applies/, action);
	}
});

test("ios-compat-checked added before the change existed, or never recorded, is not a decision", () => {
	const result = gate({ labels: [CHECKED_LABEL], recordedFingerprint: undefined });
	assert.equal(result.ok, false);
	assert.deepEqual(result.removeLabels, [CHECKED_LABEL]);
});

test("breaks-ios-app holds, while still recording a decision and clearing a stale one", () => {
	const deciding = gate({ action: "labeled", labelName: CHECKED_LABEL, labels: [BREAKS_LABEL, CHECKED_LABEL] });
	assert.equal(deciding.ok, false);
	assert.equal(deciding.record, true);
	assert.deepEqual(deciding.removeLabels, []);
	const released = gate({ action: "unlabeled", labelName: BREAKS_LABEL, labels: [CHECKED_LABEL], recordedFingerprint: fp });
	assert.equal(released.ok, true);
	const stale = gate({ labels: [BREAKS_LABEL, CHECKED_LABEL], recordedFingerprint: "0".repeat(64) });
	assert.equal(stale.ok, false);
	assert.deepEqual(stale.removeLabels, [CHECKED_LABEL]);
	assert.deepEqual(stale.addLabels, []);
});

function fakeGitHub({ record, labeledAt, onPoll } = {}) {
	const calls = [];
	const state = { record, labeledAt };
	return {
		calls,
		state,
		decisionRecord() {
			calls.push("read");
			return state.record;
		},
		latestDecisionLabelAt() {
			return state.labeledAt;
		},
		recordDecision(body) {
			calls.push("record");
			state.record = { fingerprint: parseDecision(body), updatedAt: "2026-11-02T18:00:10Z" };
		},
		addLabel(name) {
			calls.push(`add ${name}`);
		},
		removeLabel(name) {
			calls.push(`remove ${name}`);
		},
		poll() {
			onPoll?.(state);
		},
	};
}

function event(action, labels, labelName) {
	return {
		action,
		...(labelName ? { label: { name: labelName } } : {}),
		pull_request: { head: { sha: "d".repeat(40) }, labels: labels.map((name) => ({ name })) },
	};
}

async function gateRun(github, evt, reviewedChanges, options = {}) {
	const logs = [];
	let clock = 0;
	const ok = await runGate({
		event: evt,
		baselineText,
		baseline,
		changes: reviewedChanges,
		github,
		sleep: async (ms) => {
			clock += ms;
			github.poll();
		},
		now: () => clock,
		log: (line) => logs.push(line),
		...options,
	});
	return { ok, logs };
}

// Regression: #1008 review. ios-compat-checked stayed on across new commits, so a
// later app-facing change passed on the earlier decision without review.
test("an approved pull request is held again when a later commit changes app-facing code", async () => {
	const v1 = changes([brokerPath], { head: { [brokerPath]: "v1" } });
	const github = fakeGitHub();
	const approved = await gateRun(github, event("labeled", [CHECKED_LABEL], CHECKED_LABEL), v1);
	assert.equal(approved.ok, true);
	assert.deepEqual(github.calls, ["record"]);

	github.calls.length = 0;
	const unchanged = await gateRun(github, event("synchronize", [CHECKED_LABEL]), v1);
	assert.equal(unchanged.ok, true, "a push that leaves app-facing code alone keeps the decision");

	github.calls.length = 0;
	const v2 = changes([brokerPath], { head: { [brokerPath]: "v2" } });
	const changed = await gateRun(github, event("synchronize", [CHECKED_LABEL]), v2);
	assert.equal(changed.ok, false);
	assert.ok(github.calls.includes(`remove ${CHECKED_LABEL}`));
	assert.ok(github.calls.includes(`add ${BREAKS_LABEL}`));
	assert.ok(!github.calls.includes("record"));
	assert.match(changed.logs.at(-1), /^::error::.*no longer applies/);
});

test("a run waits for a just-added decision instead of discarding it", async () => {
	const reviewed = changes([brokerPath], { head: { [brokerPath]: "v1" } });
	const fingerprint = decisionFingerprint(baselineText, reviewed);
	// breaks-ios-app removed at the same time ios-compat-checked was added; the
	// decision run records a moment later.
	const github = fakeGitHub({
		record: undefined,
		labeledAt: "2026-11-02T18:00:05Z",
		onPoll: (state) => {
			state.record = { fingerprint, updatedAt: "2026-11-02T18:00:09Z" };
		},
	});
	const result = await gateRun(github, event("unlabeled", [CHECKED_LABEL], BREAKS_LABEL), reviewed);
	assert.equal(result.ok, true);
	assert.ok(!github.calls.some((call) => call.startsWith("remove") || call.startsWith("add")));
});

test("a decision that is never recorded fails closed after the wait", async () => {
	const reviewed = changes([brokerPath], { head: { [brokerPath]: "v1" } });
	const github = fakeGitHub({ labeledAt: "2026-11-02T18:00:05Z" });
	const result = await gateRun(github, event("synchronize", [CHECKED_LABEL]), reviewed, { waitMs: 20, pollMs: 5 });
	assert.equal(result.ok, false);
	assert.ok(github.calls.includes(`remove ${CHECKED_LABEL}`));
});

test("a decision that cannot be recorded fails, and label update failures do not pass", async () => {
	const reviewed = changes([brokerPath], { head: { [brokerPath]: "v1" } });
	const readOnly = {
		...fakeGitHub(),
		recordDecision() {
			throw new Error("Resource not accessible by integration");
		},
	};
	const result = await gateRun(readOnly, event("labeled", [CHECKED_LABEL], CHECKED_LABEL), reviewed);
	assert.equal(result.ok, false);
	assert.match(result.logs.at(-1), /Could not record/);

	const failingLabels = {
		...fakeGitHub({ record: { fingerprint: "0".repeat(64), updatedAt: "2026-11-02T18:00:10Z" } }),
		removeLabel() {
			throw new Error("boom");
		},
		addLabel() {
			throw new Error("boom");
		},
	};
	const stale = await gateRun(failingLabels, event("synchronize", [CHECKED_LABEL]), reviewed);
	assert.equal(stale.ok, false);
	assert.ok(stale.logs.some((line) => line.startsWith("::warning::")));
});

test("the workflow gates every pull request event and never cancels a decision run", () => {
	const workflow = parse(readFileSync(new URL("../.github/workflows/ios-app-compat.yml", import.meta.url), "utf8"));
	assert.deepEqual(workflow.on.pull_request.types, ["opened", "synchronize", "reopened", "labeled", "unlabeled"]);
	assert.match(workflow.concurrency.group, /'ios-compat-checked'/);
	assert.match(workflow.concurrency.group, /github\.run_id/);
	const job = workflow.jobs["ios-app-compat"];
	assert.equal(job.permissions["pull-requests"], "write");
	const gateStep = job.steps.find((step) => step.run?.includes("scripts/ios-app-compat.mjs"));
	assert.equal(gateStep.run, "node scripts/ios-app-compat.mjs --base HEAD^1 --gate");
	assert.equal(gateStep.env.GH_TOKEN, "${{ github.token }}");
});
