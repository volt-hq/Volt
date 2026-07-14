#!/usr/bin/env node
/**
 * Draft a changeset fragment with Volt itself.
 *
 * Collects the current diff (staged changes first, otherwise the branch diff
 * against the merge base with origin/main), pipes it into a one-shot
 * `volt -p --no-session --no-tools` run that classifies the change and writes
 * the user-facing sentence, validates the reply with the changeset parser, and
 * writes the fragment via addChangeset(). The human still reviews the file —
 * Volt drafts, you approve.
 *
 * Usage:
 *   npm run changeset:draft                     # staged diff, else branch diff
 *   npm run changeset:draft -- --base <ref>     # explicit diff base vs HEAD
 *
 * Environment:
 *   VOLT_BIN          volt executable to run (default: volt)
 *   VOLT_DRAFT_MODEL  optional --model override for the drafting run
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { addChangeset } from "./changelog.mjs";
import { RELEASE_PACKAGE_IDENTITIES } from "./verify-release-provenance.mjs";

const MAX_DIFF_CHARS = 80_000;
const DRAFT_KINDS = new Set(["breaking", "feature", "improvement", "fix", "internal"]);
const DIFF_EXCLUDES = [
	":(exclude)package-lock.json",
	":(exclude)**/npm-shrinkwrap.json",
	":(exclude)**/dist/**",
	":(exclude)packages/ai/src/models.generated.ts",
];

export function buildDraftPrompt() {
	return [
		"You are drafting a changelog changeset fragment for Volt, a terminal coding agent.",
		"Read the diff provided as input and reply with ONLY one JSON object — no code fences, no prose before or after:",
		"",
		'{"kind":"feature|improvement|fix|breaking|internal","area":"<lowercase slug or empty string>","sentence":"<one user-facing sentence>","details":"<optional detail paragraphs or empty string>"}',
		"",
		"Rules:",
		"- kind: feature = new user-visible capability; improvement = better existing behavior; fix = bug fix; breaking = requires user action (details MUST describe the migration); internal = no user-visible behavior change (refactor, CI, tests, docs plumbing).",
		"- area: short lowercase slug grouping the change (examples: daemon, remote, tui, lsp, subagents, mcp, compaction, providers, store); empty string if none fits.",
		"- sentence: exactly one sentence for a Volt user, past tense (Added/Fixed/Changed ...), describing observable behavior. Never mention file names, functions, classes, or other implementation details.",
		"- details: only when genuinely needed (migration steps or essential context); otherwise an empty string.",
	].join("\n");
}

export function extractDraftReply(output) {
	const withoutFences = output.replaceAll(/```[a-z]*\n?/g, "");
	const match = /\{[\s\S]*\}/.exec(withoutFences);
	if (!match) {
		throw new Error(`volt reply contains no JSON object:\n${output.trim()}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		throw new Error(`volt reply is not valid JSON:\n${match[0]}`);
	}
	const kind = String(parsed.kind ?? "").trim();
	const area = String(parsed.area ?? "").trim();
	const sentence = String(parsed.sentence ?? "").trim();
	const details = String(parsed.details ?? "").trim();
	if (!DRAFT_KINDS.has(kind)) {
		throw new Error(`volt reply has invalid kind: ${JSON.stringify(parsed.kind)}`);
	}
	if (!sentence) {
		throw new Error("volt reply has an empty sentence");
	}
	return { area, details, kind, sentence };
}

export function packagesForChangedPaths(changedPaths) {
	const packages = RELEASE_PACKAGE_IDENTITIES.filter(({ directory }) =>
		changedPaths.some((path) => path.startsWith(`${directory}/`)),
	).map(({ name }) => name);
	return packages.length > 0 ? packages : ["@hansjm10/volt-coding-agent"];
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitLines(args) {
	return git(args)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function collectDiff(baseOverride) {
	const staged = gitLines(["diff", "--cached", "--name-only", "--", ".", ...DIFF_EXCLUDES]);
	if (!baseOverride && staged.length > 0) {
		return {
			changedPaths: staged,
			description: "staged changes",
			diff: git(["diff", "--cached", "--", ".", ...DIFF_EXCLUDES]),
			subjects: [],
		};
	}

	const base = baseOverride ?? git(["merge-base", "origin/main", "HEAD"]).trim();
	const changedPaths = gitLines(["diff", "--name-only", base, "HEAD", "--", ".", ...DIFF_EXCLUDES]);
	return {
		changedPaths,
		description: `diff ${base.slice(0, 12)}..HEAD`,
		diff: git(["diff", base, "HEAD", "--", ".", ...DIFF_EXCLUDES]),
		subjects: gitLines(["log", "--format=%s", `${base}..HEAD`]),
	};
}

function runVolt(prompt, input) {
	const bin = process.env.VOLT_BIN || "volt";
	const args = ["-p", "--no-session", "--no-tools"];
	if (process.env.VOLT_DRAFT_MODEL) {
		args.push("--model", process.env.VOLT_DRAFT_MODEL);
	}
	args.push(prompt);
	return execFileSync(bin, args, {
		encoding: "utf8",
		input,
		maxBuffer: 16 * 1024 * 1024,
		timeout: 180_000,
	});
}

function main(argv) {
	const baseIndex = argv.indexOf("--base");
	const base = baseIndex !== -1 ? argv[baseIndex + 1] : undefined;
	if (baseIndex !== -1 && !base) {
		throw new Error("--base requires a git ref");
	}

	const { changedPaths, description, diff, subjects } = collectDiff(base);
	if (!diff.trim()) {
		throw new Error("no changes to describe: stage your change or run from a branch with commits ahead of origin/main");
	}

	const truncated = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
	const inputSections = [];
	if (subjects.length > 0) {
		inputSections.push(`Commit subjects:\n${subjects.map((subject) => `- ${subject}`).join("\n")}`);
	}
	inputSections.push(`Diff (${description}):\n${truncated}`);
	const input = inputSections.join("\n\n");

	console.log(`Drafting changeset with Volt from ${description} (${changedPaths.length} file(s))...`);
	const prompt = buildDraftPrompt();
	const packages = packagesForChangedPaths(changedPaths);
	const draftOnce = (draftPrompt) => {
		const draft = extractDraftReply(runVolt(draftPrompt, input));
		return addChangeset({ ...draft, packages });
	};

	let result;
	try {
		result = draftOnce(prompt);
	} catch (error) {
		const firstError = error instanceof Error ? error.message : String(error);
		console.error(`First attempt failed (${firstError.split("\n")[0]}); retrying once...`);
		result = draftOnce(`${prompt}\n\nYour previous reply was rejected: ${firstError}\nReply with ONLY the corrected JSON object.`);
	}

	console.log(`\nWrote ${result.file}:\n\n${result.content}`);
	console.log("Review the sentence before committing — Volt drafts, you approve. Edit the file or rerun to redraft.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
