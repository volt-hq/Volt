import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyReleaseSection,
	assertNoPendingChangesets,
	assertReleaseSectionNotices,
	assertReleaseTargetSatisfiesChangesets,
	parseChangeset,
	readChangesets,
	RELEASE_NOTICES,
	renderReleaseSection,
	requiredReleaseBump,
} from "./changelog.mjs";

const [UNSIGNED_WINDOWS_NOTICE] = RELEASE_NOTICES;

function changeset(body) {
	return `---\n"@hansjm10/volt-coding-agent": patch\n---\n\n${body}\n`;
}

test("parseChangeset extracts kind, area, sentence, details, packages, and bump", () => {
	const parsed = parseChangeset(
		".changeset/example.md",
		'---\n"@hansjm10/volt-coding-agent": minor\n@hansjm10/volt-tui: minor\n---\n\nbreaking(remote): Paired devices must re-pair.\n\nRun `volt remote pair` again on every device.\n',
	);
	assert.equal(parsed.kind, "breaking");
	assert.equal(parsed.area, "remote");
	assert.equal(parsed.sentence, "Paired devices must re-pair.");
	assert.equal(parsed.details, "Run `volt remote pair` again on every device.");
	assert.deepEqual(parsed.packages, ["@hansjm10/volt-coding-agent", "@hansjm10/volt-tui"]);
	assert.equal(parsed.bump, "minor");

	const noArea = parseChangeset(".changeset/no-area.md", changeset("fix: Fixed a defect."));
	assert.equal(noArea.area, "");
	assert.equal(noArea.details, "");
});

test("parseChangeset rejects malformed or inconsistent changesets", () => {
	const cases = [
		["no front matter\n", /front matter block/],
		['---\n"@hansjm10/volt-coding-agent": patch\n---\n\n', /no summary/],
		['---\n"@other/package": patch\n---\n\nfix: X.\n', /unknown package/],
		['---\n"@hansjm10/volt-coding-agent": major\n---\n\nbreaking: X.\n\nY.\n', /major releases are not used/],
		['---\n"@hansjm10/volt-coding-agent": patch\n"@hansjm10/volt-tui": minor\n---\n\nfix: X.\n', /same bump/],
		['---\nnot a mapping\n---\n\nfix: X.\n', /unparseable front matter/],
		["---\n\n---\n\nfix: X.\n", /at least one package/],
		[changeset("added something without a kind"), /first summary line/],
		[changeset("Added(daemon): Uppercase kind."), /first summary line/],
		[changeset("breaking: Missing minor bump.\n\nMigration."), /minor bump/],
		['---\n"@hansjm10/volt-coding-agent": minor\n---\n\nfix: Non-breaking minor.\n', /only breaking changes/],
		['---\n"@hansjm10/volt-coding-agent": minor\n---\n\nbreaking: No migration body.\n', /migration/],
	];
	for (const [content, expected] of cases) {
		assert.throws(() => parseChangeset(".changeset/bad.md", content), expected, content);
	}
});

test("renderReleaseSection orders sections, groups by area, and hides internal entries", () => {
	const changesets = [
		parseChangeset(".changeset/b-fix.md", changeset("fix(tui): Fixed the transcript roster.")),
		parseChangeset(".changeset/a-fix.md", changeset("fix(daemon): Fixed lease cleanup.")),
		parseChangeset(".changeset/c-fix.md", changeset("fix: Fixed an arealess defect.")),
		parseChangeset(".changeset/feat.md", changeset("feature(remote): Added phone pairing.\n\nSee docs/remote.md.")),
		parseChangeset(".changeset/improve.md", changeset("improvement(lsp): Faster diagnostics.")),
		parseChangeset(".changeset/internal.md", changeset("internal: Refactored CI.")),
		parseChangeset(
			".changeset/break.md",
			'---\n"@hansjm10/volt-coding-agent": minor\n---\n\nbreaking(remote): Re-pair required.\n\nRun `volt remote pair` again.\n',
		),
	];
	const section = renderReleaseSection(changesets, "1.2.3", "2026-07-13");
	assert.equal(
		section,
		[
			"## [1.2.3] - 2026-07-13",
			"",
			"### Highlights",
			"",
			"- Added phone pairing.",
			"  See docs/remote.md.",
			"",
			"### Breaking Changes",
			"",
			"- **remote:** Re-pair required.",
			"  Run `volt remote pair` again.",
			"",
			"### Improvements",
			"",
			"- **lsp:** Faster diagnostics.",
			"",
			"### Fixes",
			"",
			"- **daemon:** Fixed lease cleanup.",
			"- **tui:** Fixed the transcript roster.",
			"- Fixed an arealess defect.",
			"",
		].join("\n"),
	);
});

test("renderReleaseSection notes maintenance releases with only internal changes", () => {
	const changesets = [parseChangeset(".changeset/internal.md", changeset("internal: Refactored CI."))];
	assert.match(renderReleaseSection(changesets, "1.2.3", "2026-07-13"), /Maintenance release with no user-facing changes\./);
});

test("renderReleaseSection opens with release notices before entries and maintenance notes", () => {
	const fix = parseChangeset(".changeset/fix.md", changeset("fix(daemon): Fixed lease cleanup."));
	assert.equal(
		renderReleaseSection([fix], "1.2.3", "2026-07-13", ["First notice.", "Second notice."]),
		"## [1.2.3] - 2026-07-13\n\nFirst notice.\n\nSecond notice.\n\n### Fixes\n\n- **daemon:** Fixed lease cleanup.\n",
	);
	const internal = parseChangeset(".changeset/internal.md", changeset("internal: Refactored CI."));
	assert.equal(
		renderReleaseSection([internal], "1.2.3", "2026-07-13", ["First notice."]),
		"## [1.2.3] - 2026-07-13\n\nFirst notice.\n\nMaintenance release with no user-facing changes.\n",
	);
	assert.doesNotMatch(renderReleaseSection([fix], "1.2.3", "2026-07-13"), /notice/);
});

test("assertReleaseSectionNotices requires every notice as a paragraph of the exact version section", () => {
	const section = `## [0.2.1] - 2026-09-27\n\n${UNSIGNED_WINDOWS_NOTICE}\n\n### Fixes\n\n- Fixed a defect.\n`;
	const changelog = `# Changelog\n\n${section}\n## [0.2.0] - 2026-09-25\n\nOlder release.\n`;
	assert.doesNotThrow(() => assertReleaseSectionNotices(changelog, "0.2.1"));
	assert.doesNotThrow(() => assertReleaseSectionNotices(changelog.replaceAll("\n", "\r\n"), "0.2.1"));
	assert.throws(
		() => assertReleaseSectionNotices(changelog.replace(`${UNSIGNED_WINDOWS_NOTICE}\n\n`, ""), "0.2.1"),
		/missing required release notices/,
	);
	assert.throws(
		() =>
			assertReleaseSectionNotices(
				`# Changelog\n\n## [0.2.1] - 2026-09-27\n\n### Fixes\n\n- Fixed a defect.\n\n## [0.2.0] - 2026-09-25\n\n${UNSIGNED_WINDOWS_NOTICE}\n`,
				"0.2.1",
			),
		/missing required release notices/,
	);
	assert.throws(
		() => assertReleaseSectionNotices(changelog.replace(`\n\n${UNSIGNED_WINDOWS_NOTICE}\n\n`, `\n\n- ${UNSIGNED_WINDOWS_NOTICE}\n\n`), "0.2.1"),
		/missing required release notices/,
	);
	assert.throws(() => assertReleaseSectionNotices(changelog, "0.2.2"), /no release section for 0\.2\.2/);
	assert.throws(() => assertReleaseSectionNotices(changelog.replace("[0.2.1]", "[0x2.1]"), "0.2.1"), /no release section/);
});

test("renderReleaseSection omits the date suffix for dateless previews", () => {
	const changesets = [parseChangeset(".changeset/fix.md", changeset("fix: X."))];
	assert.match(renderReleaseSection(changesets, "Unreleased", undefined), /^## \[Unreleased\]\n/);
});

test("requiredReleaseBump and release-target validation enforce minor for breaking changes", () => {
	const fix = parseChangeset(".changeset/fix.md", changeset("fix: X."));
	const breaking = parseChangeset(
		".changeset/break.md",
		'---\n"@hansjm10/volt-coding-agent": minor\n---\n\nbreaking: X.\n\nMigration.\n',
	);
	assert.equal(requiredReleaseBump([fix]), "patch");
	assert.equal(requiredReleaseBump([fix, breaking]), "minor");
	assert.doesNotThrow(() => assertReleaseTargetSatisfiesChangesets("0.1.0", "0.1.1", [fix]));
	assert.doesNotThrow(() => assertReleaseTargetSatisfiesChangesets("0.1.0", "0.2.0", [fix, breaking]));
	assert.doesNotThrow(() => assertReleaseTargetSatisfiesChangesets("0.9.9", "1.0.0", [fix, breaking]));
	assert.throws(() => assertReleaseTargetSatisfiesChangesets("0.1.0", "0.1.1", [fix, breaking]), /minor/);
});

test("applyReleaseSection inserts the section, consumes fragments, and is idempotent-safe", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-changelog-test-"));
	try {
		const changesetDir = join(directory, ".changeset");
		const changelogPath = join(directory, "CHANGELOG.md");
		mkdirSync(changesetDir);
		writeFileSync(join(changesetDir, "README.md"), "# Changesets\n");
		writeFileSync(join(changesetDir, "fix-a.md"), changeset("fix(daemon): Fixed lease cleanup."));
		writeFileSync(changelogPath, "# Changelog\n\n## [0.1.0] - 2026-07-13\n\nInitial release.\n");

		assert.throws(() => assertNoPendingChangesets(changesetDir), /unconsumed changesets/);
		const { changesets, section } = applyReleaseSection({
			version: "0.1.1",
			date: "2026-07-14",
			changelogPath,
			changesetDir,
		});
		assert.equal(changesets.length, 1);
		assert.match(section, /## \[0\.1\.1\] - 2026-07-14/);
		assert.equal(
			readFileSync(changelogPath, "utf8"),
			`# Changelog\n\n## [0.1.1] - 2026-07-14\n\n${UNSIGNED_WINDOWS_NOTICE}\n\n### Fixes\n\n- **daemon:** Fixed lease cleanup.\n\n## [0.1.0] - 2026-07-13\n\nInitial release.\n`,
		);
		assert.doesNotThrow(() => assertReleaseSectionNotices(readFileSync(changelogPath, "utf8"), "0.1.1"));
		assert.doesNotThrow(() => assertNoPendingChangesets(changesetDir));
		assert.equal(readFileSync(join(changesetDir, "README.md"), "utf8"), "# Changesets\n");

		assert.throws(() => applyReleaseSection({ version: "0.1.2", date: "2026-07-15", changelogPath, changesetDir }), /no changesets/);
		writeFileSync(join(changesetDir, "fix-b.md"), changeset("fix: X."));
		assert.throws(() => applyReleaseSection({ version: "0.1.1", date: "2026-07-15", changelogPath, changesetDir }), /already contains/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("applyReleaseSection preserves CRLF line endings", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-changelog-test-"));
	try {
		const changesetDir = join(directory, ".changeset");
		const changelogPath = join(directory, "CHANGELOG.md");
		mkdirSync(changesetDir);
		writeFileSync(join(changesetDir, "fix-a.md"), changeset("fix(daemon): Fixed lease cleanup."));
		writeFileSync(changelogPath, "# Changelog\r\n\r\n## [0.1.0] - 2026-07-13\r\n\r\nInitial release.\r\n");

		applyReleaseSection({ version: "0.1.1", date: "2026-07-14", changelogPath, changesetDir });
		assert.equal(
			readFileSync(changelogPath, "utf8"),
			`# Changelog\r\n\r\n## [0.1.1] - 2026-07-14\r\n\r\n${UNSIGNED_WINDOWS_NOTICE}\r\n\r\n### Fixes\r\n\r\n- **daemon:** Fixed lease cleanup.\r\n\r\n## [0.1.0] - 2026-07-13\r\n\r\nInitial release.\r\n`,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("readChangesets aggregates every invalid fragment into one error", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-changelog-test-"));
	try {
		const changesetDir = join(directory, ".changeset");
		mkdirSync(changesetDir);
		writeFileSync(join(changesetDir, "bad-a.md"), "no front matter\n");
		writeFileSync(join(changesetDir, "bad-b.md"), changeset("unknownkind: X."));
		writeFileSync(join(changesetDir, "good.md"), changeset("fix: X."));
		assert.throws(() => readChangesets(changesetDir), /bad-a\.md[\s\S]*bad-b\.md/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
