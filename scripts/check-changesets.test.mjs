import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addChangeset } from "./changelog.mjs";
import { isFragmentPath, isProductSourcePath, suggestFragment, suggestSlug } from "./check-changesets.mjs";

test("product source paths cover package src and exclude tests, docs, and generated files", () => {
	assert.equal(isProductSourcePath("packages/coding-agent/src/core/session.ts"), true);
	assert.equal(isProductSourcePath("packages/tui/src/tui.ts"), true);
	assert.equal(isProductSourcePath("packages/ai/src/models.generated.ts"), false);
	assert.equal(isProductSourcePath("packages/coding-agent/test/session.test.ts"), false);
	assert.equal(isProductSourcePath("packages/coding-agent/docs/lsp.md"), false);
	assert.equal(isProductSourcePath("scripts/release.mjs"), false);
	assert.equal(isProductSourcePath(".github/workflows/ci.yml"), false);
	assert.equal(isProductSourcePath("site/index.html"), false);
});

test("fragment paths match changeset markdown but not the README", () => {
	assert.equal(isFragmentPath(".changeset/some-fix.md"), true);
	assert.equal(isFragmentPath(".changeset/README.md"), false);
	assert.equal(isFragmentPath(".changeset/config.json"), false);
	assert.equal(isFragmentPath("packages/coding-agent/CHANGELOG.md"), false);
});

test("suggested fragments derive kind, area, packages, and attribution from the pull request", () => {
	const suggestion = suggestFragment({
		changedPaths: ["packages/tui/src/tui.ts", "packages/coding-agent/src/main.ts"],
		pullNumber: 42,
		title: "fix(tui): preserve scrollback during live updates",
	});
	assert.equal(
		suggestion,
		'---\n"@hansjm10/volt-tui": patch\n"@hansjm10/volt-coding-agent": patch\n---\n\nfix(tui): Preserve scrollback during live updates. ([#42](https://github.com/hansjm10/Volt/pull/42))\n',
	);

	const featureSuggestion = suggestFragment({ changedPaths: [], title: "feat: add web search" });
	assert.match(featureSuggestion, /"@hansjm10\/volt-coding-agent": patch/);
	assert.match(featureSuggestion, /feature: Add web search\./);

	const refactorSuggestion = suggestFragment({ changedPaths: [], title: "refactor(coding-agent): split session module" });
	assert.match(refactorSuggestion, /internal: Split session module\./);
	assert.doesNotMatch(refactorSuggestion, /\(coding-agent\)/);

	const breakingSuggestion = suggestFragment({ changedPaths: [], title: "breaking(remote): require re-pairing" });
	assert.match(breakingSuggestion, /"@hansjm10\/volt-coding-agent": minor/);
	assert.match(breakingSuggestion, /breaking\(remote\): Require re-pairing\./);
	assert.match(breakingSuggestion, /Describe the migration here\./);

	const bareSuggestion = suggestFragment({ changedPaths: [], title: "Stabilize release tests" });
	assert.match(bareSuggestion, /improvement: Stabilize release tests\./);
});

test("suggested slugs are kebab-case and never empty", () => {
	assert.equal(suggestSlug("fix(tui): preserve scrollback!"), "fix-tui-preserve-scrollback");
	assert.equal(suggestSlug(""), "describe-this-change");
});

test("addChangeset writes a validated fragment with a unique slug", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-changeset-add-"));
	try {
		const changesetDir = join(directory, ".changeset");
		mkdirSync(changesetDir);
		const first = addChangeset({
			kind: "fix",
			area: "daemon",
			sentence: "Fixed lease cleanup.",
			changesetDir,
		});
		assert.equal(
			readFileSync(first.file, "utf8"),
			'---\n"@hansjm10/volt-coding-agent": patch\n---\n\nfix(daemon): Fixed lease cleanup.\n',
		);
		const second = addChangeset({ kind: "fix", area: "daemon", sentence: "Fixed lease cleanup.", changesetDir });
		assert.notEqual(second.file, first.file);

		const breaking = addChangeset({
			kind: "breaking",
			area: "remote",
			sentence: "Devices must re-pair.",
			details: "Run `volt remote pair` again.",
			packages: ["@hansjm10/volt-coding-agent", "@hansjm10/volt-tui"],
			changesetDir,
		});
		assert.match(readFileSync(breaking.file, "utf8"), /volt-coding-agent": minor\n"@hansjm10\/volt-tui": minor/);
		assert.match(readFileSync(breaking.file, "utf8"), /\nRun `volt remote pair` again\.\n$/);

		assert.throws(() => addChangeset({ kind: "nonsense", sentence: "X.", changesetDir }), /first summary line/);
		assert.throws(() => addChangeset({ kind: "breaking", sentence: "X.", changesetDir }), /migration/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
