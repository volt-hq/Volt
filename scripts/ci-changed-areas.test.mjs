import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CI_AREAS, selectAreas } from "./ci-changed-areas.mjs";

// The pre-commit hook runs this suite with GIT_DIR and friends pointing at the commit in progress.
// Drop them so the fixture repository below never retargets the developer's checkout.
for (const name of [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_INDEX_VERSION",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_WORK_TREE",
]) {
	delete process.env[name];
}

const script = fileURLToPath(new URL("./ci-changed-areas.mjs", import.meta.url));
const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const none = { tests: false, "workspace-fs-native": false, "iroh-native": false, "relay-credential-broker": false };
const all = { tests: true, "workspace-fs-native": true, "iroh-native": true, "relay-credential-broker": true };

test("documentation-only changes select no test shard or native job", () => {
	assert.deepEqual(
		selectAreas([
			"README.md",
			"CONTRIBUTING.md",
			"docs/github-release-automation.md",
			"packages/agent/docs/events.md",
			"packages/coding-agent/README.md",
			"packages/coding-agent/docs/docs.json",
			"packages/coding-agent/docs/images/tree-view.png",
		]),
		none,
	);
});

test("any other change selects the test shards", () => {
	for (const path of [
		"packages/coding-agent/src/main.ts",
		"packages/coding-agent/test/args.test.ts",
		"packages/coding-agent/examples/extensions/README.md",
		"packages/coding-agent/CHANGELOG.md",
		".changeset/fix-something.md",
		".volt/skills/view-cli.md",
		"scripts/release.mjs",
		"site/package.json",
		"test.sh",
		".github/workflows/build-binaries.yml",
	]) {
		assert.deepEqual(selectAreas([path]), { ...none, tests: true }, path);
	}
	assert.deepEqual(selectAreas(["README.md", "packages/tui/src/tui.ts"]), { ...none, tests: true });
	assert.deepEqual(
		selectAreas(["packages/coding-agent/docs/sqlite-session-storage-design.md"]),
		{ ...none, tests: true },
		"a document a Vitest suite reads is not documentation-only",
	);
});

test("native and broker jobs run only when their inputs change", () => {
	for (const path of [
		"packages/coding-agent/native/workspace-fs/src/lib.rs",
		"packages/coding-agent/native/workspace-fs/Cargo.lock",
		"packages/coding-agent/native/workspace-fs/deny.toml",
		"packages/coding-agent/native/workspace-fs/prebuilds/linux-x64-musl/workspace-fs.node",
		"scripts/workspace-fs-native.mjs",
	]) {
		assert.deepEqual(selectAreas([path]), { ...none, tests: true, "workspace-fs-native": true }, path);
	}
	for (const path of [
		"package.json",
		"package-lock.json",
		".npmrc",
		"packages/coding-agent/package.json",
		"scripts/check-iroh-native-load.mjs",
	]) {
		assert.deepEqual(selectAreas([path]), { ...none, tests: true, "iroh-native": true }, path);
	}
	assert.deepEqual(selectAreas(["packages/tui/package.json"]), { ...none, tests: true });
	assert.deepEqual(
		selectAreas(["services/relay-credential-broker/go.sum", "services/relay-credential-broker/README.md", "README.md"]),
		{ ...none, "relay-credential-broker": true },
	);
});

test("an empty diff or a change to job selection runs every job", () => {
	assert.deepEqual(selectAreas([]), all);
	assert.deepEqual(selectAreas([".github/workflows/ci.yml"]), all);
	assert.deepEqual(selectAreas(["README.md", "scripts/ci-changed-areas.mjs"]), all);
});

test("the CLI diffs without rename detection and writes GitHub step outputs", (t) => {
	const repository = mkdtempSync(join(tmpdir(), "volt-ci-changed-areas-"));
	t.after(() => rmSync(repository, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
	const commit = (message) =>
		git("-c", "user.name=Volt", "-c", "user.email=volt@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
	const nativeSource = join(repository, "packages/coding-agent/native/workspace-fs/src/lib.rs");
	git("init", "--quiet");
	mkdirSync(dirname(nativeSource), { recursive: true });
	writeFileSync(nativeSource, "pub fn native() {}\n");
	git("add", ".");
	commit("native");
	mkdirSync(join(repository, "docs"));
	git("mv", "packages/coding-agent/native/workspace-fs/src/lib.rs", "docs/lib.rs");
	commit("move");

	const output = join(repository, "github-output");
	const run = (...args) =>
		spawnSync(process.execPath, [script, ...args], {
			cwd: repository,
			encoding: "utf8",
			env: { ...process.env, GITHUB_OUTPUT: output },
		});
	const moved = run("--base", "HEAD^1");
	assert.equal(moved.status, 0, moved.stderr);
	assert.equal(
		readFileSync(output, "utf8"),
		"tests=true\nworkspace-fs-native=true\niroh-native=false\nrelay-credential-broker=false\n",
		"moving a native source into docs still selects the jobs for its old path",
	);

	rmSync(output);
	const full = run("--all");
	assert.equal(full.status, 0, full.stderr);
	assert.equal(readFileSync(output, "utf8"), `${CI_AREAS.map((area) => `${area}=true`).join("\n")}\n`);

	assert.notEqual(run("--base", "no-such-ref").status, 0, "an unreadable diff fails the job");
	assert.notEqual(run().status, 0);
});

test("CI gates each job on its area and pushes to main select every area", () => {
	const changes = workflow.jobs.changes;
	assert.deepEqual(
		changes.outputs,
		Object.fromEntries(CI_AREAS.map((area) => [area, `\${{ steps.areas.outputs.${area} }}`])),
	);
	assert.deepEqual(changes.permissions, { contents: "read" });
	const checkout = changes.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
	assert.deepEqual(checkout.with, { "fetch-depth": 2, "persist-credentials": false });
	const select = changes.steps.find((step) => step.id === "areas");
	assert.equal(select.env.EVENT_NAME, "${{ github.event_name }}");
	assert.match(
		select.run,
		/if \[ "\$EVENT_NAME" = pull_request \]; then\s+node scripts\/ci-changed-areas\.mjs --base HEAD\^1\s+else\s+node scripts\/ci-changed-areas\.mjs --all\s+fi/,
	);

	const gates = {
		"test-linux": "tests",
		"test-windows": "tests",
		"workspace-fs-native": "workspace-fs-native",
		"workspace-fs-musl-load": "workspace-fs-native",
		"iroh-native-darwin-arm64": "iroh-native",
		"relay-credential-broker": "relay-credential-broker",
	};
	for (const [name, job] of Object.entries(workflow.jobs)) {
		if (name in gates) {
			assert.equal(job.needs, "changes", name);
			assert.equal(job.if, `needs.changes.outputs.${gates[name]} == 'true'`, name);
		} else {
			assert.ok(!JSON.stringify(job).includes("needs.changes.outputs.") || name === "build-check-test", name);
		}
	}
	assert.equal(workflow.jobs["build-check"].if, undefined, "build-check validates every change");
});

test("the required check fails closed unless change detection, build-check, and selected Linux shards pass", () => {
	const job = workflow.jobs["build-check-test"];
	assert.deepEqual(job.needs, ["changes", "build-check", "test-linux"]);
	assert.equal(job.if, "always()");
	const [step] = job.steps;
	assert.deepEqual(step.env, {
		CHANGES_RESULT: "${{ needs.changes.result }}",
		BUILD_RESULT: "${{ needs.build-check.result }}",
		TEST_RESULT: "${{ needs.test-linux.result }}",
		TESTS_SELECTED: "${{ needs.changes.outputs.tests }}",
	});
	const passes = (env) =>
		spawnSync("bash", ["-e", "-c", step.run], {
			env: { PATH: process.env.PATH, CHANGES_RESULT: "success", BUILD_RESULT: "success", ...env },
		}).status === 0;

	assert.equal(passes({ TESTS_SELECTED: "true", TEST_RESULT: "success" }), true);
	assert.equal(passes({ TESTS_SELECTED: "false", TEST_RESULT: "skipped" }), true);
	assert.equal(passes({ TESTS_SELECTED: "true", TEST_RESULT: "failure" }), false);
	assert.equal(passes({ TESTS_SELECTED: "true", TEST_RESULT: "skipped" }), false);
	assert.equal(passes({ TESTS_SELECTED: "true", TEST_RESULT: "cancelled" }), false);
	assert.equal(passes({ TESTS_SELECTED: "", TEST_RESULT: "skipped" }), false);
	assert.equal(passes({ TESTS_SELECTED: "false", TEST_RESULT: "failure" }), false);
	assert.equal(passes({ CHANGES_RESULT: "failure", TESTS_SELECTED: "", TEST_RESULT: "skipped" }), false);
	assert.equal(passes({ BUILD_RESULT: "failure", TESTS_SELECTED: "false", TEST_RESULT: "skipped" }), false);
	assert.equal(passes({ BUILD_RESULT: "skipped", TESTS_SELECTED: "true", TEST_RESULT: "success" }), false);
});
