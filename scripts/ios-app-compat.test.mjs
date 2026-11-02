import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
	APP_FACING_PATHS,
	appFacingChanges,
	BASELINE_PATH,
	CODING_AGENT_PACKAGE_PATH,
	describeBaseline,
	IROH_BINDING,
	PROTOCOL_CONTRACT_PATH,
	parseBaseline,
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
	assert.match(result[0], /protocol contract differs/);
	assert.match(result[0], /Volt bbbbbbbbb/);
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
		"packages/coding-agent/examples/remote/firebase-push-relay/functions/index.js",
		"services/relay-credential-broker/internal/broker/broker.go",
		"services/relay-credential-broker/internal/database/migrations/0005_replaceable_app_endpoints.sql",
		"services/relay-credential-broker/relay-patch/iroh-relay-1.0.3-jwt-access.patch",
	];
	const ignored = [
		"packages/coding-agent/src/core/remote/iroh/qr.ts",
		"packages/coding-agent/src/daemon/iroh-service.ts",
		"packages/coding-agent/examples/remote/firebase-push-relay/functions/index.test.js",
		"packages/coding-agent/examples/remote/firebase-push-relay/README.md",
		"services/relay-credential-broker/internal/broker/reapproval_test.go",
		"services/relay-credential-broker/README.md",
		"AGENTS.md",
	];
	const result = changes([...flagged, ...ignored]);
	assert.deepEqual(
		result.map((line) => line.slice(0, line.indexOf(": "))),
		flagged,
	);
	for (const path of flagged) {
		assert.ok(APP_FACING_PATHS.some(({ pattern }) => pattern.test(path)), path);
	}
});

test("changing the Iroh binding away from the baseline is app-facing", () => {
	const result = changes([CODING_AGENT_PACKAGE_PATH], {
		base: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.1.1-volt.2") },
		head: { [CODING_AGENT_PACKAGE_PATH]: packageJson("1.2.0-volt.1") },
	});
	assert.equal(result.length, 1);
	assert.match(result[0], /@hansjm10\/volt-iroh 1\.2\.0-volt\.1 \(baseline 1\.1\.1-volt\.2\)/);
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

test("the workflow reruns on label changes and gates on both labels", () => {
	const workflow = parse(readFileSync(new URL("../.github/workflows/ios-app-compat.yml", import.meta.url), "utf8"));
	assert.deepEqual(workflow.on.pull_request.types, ["opened", "synchronize", "reopened", "labeled", "unlabeled"]);
	const steps = workflow.jobs["ios-app-compat"].steps;
	assert.ok(steps.some((step) => step.run?.includes("node scripts/ios-app-compat.mjs --base HEAD^1")));
	const gate = JSON.stringify(steps);
	assert.ok(gate.includes("breaks-ios-app"));
	assert.ok(gate.includes("ios-compat-checked"));
});
