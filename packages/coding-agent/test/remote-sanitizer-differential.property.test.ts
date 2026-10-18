/**
 * The remote path sanitizer against its reference (#935): the sanitizer's
 * scan examines only the indices where a path may start, and its root
 * expressions are compiled once, but what it redacts is unchanged. For text
 * and values built from roots in every spelling, separators, quotes, Unicode
 * whitespace, URLs, drives, UNC prefixes, home paths, and the host's own file
 * names, every function of the sanitizer returns what the pre-optimization
 * copy in test/fixtures/iroh-sanitizer-reference.ts returns, for a workspace,
 * a worktree with further roots, and a root reached through a symlink.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createIrohRemoteProjectionSanitizer,
	type IrohRemoteSanitizerOptions,
	type IrohRemoteSanitizerValuePreserver,
} from "../src/core/remote/iroh/sanitizer.ts";
import { createIrohRemoteProjectionSanitizer as createReferenceSanitizer } from "./fixtures/iroh-sanitizer-reference.ts";

const TEXT_RUNS = 1_500;
const VALUE_RUNS = 600;

/** Every spelling of a root text may hold: as resolved, NFC and NFD, with forward slashes, and with a trailing part. */
function spellings(root: string): string[] {
	const forms = [root, root.normalize("NFC"), root.normalize("NFD"), root.split(sep).join("/")];
	return [
		...new Set(
			forms.flatMap((form) => [form, `${form}/src/a.ts`, `${form}-old`, `${form}\\b.ts`, form.slice(0, -2)]),
		),
	];
}

const FRAGMENTS = [
	"/",
	"\\",
	"//",
	":",
	";",
	",",
	"|",
	'"',
	"'",
	"`",
	'\\"',
	" ",
	"\t",
	"\n",
	"\r\n",
	"\u00a0",
	"\u2028",
	"file://",
	"FILE:///",
	"File:",
	"f",
	"F",
	"C:\\",
	"c:/",
	"Z:",
	"\\\\server\\share\\",
	"\\\\\\\\server\\\\share\\\\x",
	"~",
	"~/",
	"~user/",
	"/tmp/volt-bash-abc_1.log",
	"/x/sessions/s.jsonl",
	"Volt-session-1.html",
	"/workspace",
	"/workspace/",
	"https://host/path",
	"/Users/jordan",
	"a.ts",
	"src",
	"Build",
	"logs",
	"and/or",
	"done",
	"(",
	")",
	"[",
	"]",
	"<",
	">",
	"=",
	".",
	"…",
	"...",
	"$&",
	"$1",
	"é",
	"e\u0301",
];

interface OptionSet {
	readonly name: string;
	readonly options: () => IrohRemoteSanitizerOptions;
}

let linkedBase: string | undefined;

const OPTION_SETS: readonly OptionSet[] = [
	{ name: "a workspace", options: () => ({ workspacePath: resolve("/tmp/volt-differential/café") }) },
	{
		name: "a worktree with further roots",
		options: () => ({
			workspacePath: resolve("/tmp/volt-differential/worktrees/w1"),
			remoteWorkspacePath: "/workspace/pkg",
			additionalRedactedPaths: [resolve("/tmp/volt-differential/café"), resolve("/tmp/volt-differential/worktrees")],
		}),
	},
	{
		name: "a root reached through a symlink",
		options: () => {
			if (!linkedBase) throw new Error("The symlinked root is made before the tests");
			return { workspacePath: join(linkedBase, "linked") };
		},
	},
];

/** The roots `options` names, and the real path of each. */
function rootsOf(options: IrohRemoteSanitizerOptions): string[] {
	const roots = [options.workspacePath, ...(options.additionalRedactedPaths ?? [])].map((root) => resolve(root));
	return roots.flatMap((root) => {
		try {
			return [root, realpathSync(root)];
		} catch {
			return [root];
		}
	});
}

function textArbitrary(roots: readonly string[]): fc.Arbitrary<string> {
	const fragment = fc.oneof(
		{ weight: 4, arbitrary: fc.constantFrom(...roots.flatMap(spellings)) },
		{ weight: 6, arbitrary: fc.constantFrom(...FRAGMENTS) },
		{ weight: 2, arbitrary: fc.string({ maxLength: 4 }) },
	);
	return fc.array(fragment, { maxLength: 24 }).map((parts) => parts.join(""));
}

const KEYS = [
	"path",
	"cwd",
	"filePath",
	"outputDir",
	"sessionFile",
	"fullOutputPath",
	"label",
	"id",
	"data",
	"type",
	"mimeType",
	"text",
	"textSignature",
	"thinkingSignature",
	"thoughtSignature",
	"name",
	"keep",
];

function valueArbitrary(text: fc.Arbitrary<string>, roots: readonly string[]): fc.Arbitrary<unknown> {
	const key = fc.oneof(fc.constantFrom(...KEYS), fc.constantFrom(...roots.flatMap(spellings)), text);
	const record = (entries: fc.Arbitrary<unknown>) =>
		fc
			.array(fc.tuple(key, entries), { maxLength: 4 })
			.map((pairs) => Object.fromEntries(pairs.filter(([name]) => name !== "__proto__")));
	const { node } = fc.letrec<{ node: unknown }>((tie) => ({
		node: fc.oneof(
			{ depthSize: "small", withCrossShrink: true },
			text,
			fc.integer(),
			fc.constant(null),
			fc.record({ type: fc.constant("image"), mimeType: fc.constant("image/png"), data: text }),
			fc.record({ type: fc.constant("text"), text, textSignature: text }),
			fc.record({ type: fc.constant("thinking"), thinking: text, thinkingSignature: text }),
			fc.record({ type: fc.constant("toolCall"), arguments: tie("node"), thoughtSignature: text }),
			fc.array(tie("node"), { maxLength: 3 }),
			record(tie("node")),
		),
	}));
	return node;
}

/** Preserves every `keep` entry, as the frame redactor preserves the keys it names. */
const keep: IrohRemoteSanitizerValuePreserver = (_record, key) => key === "keep";

beforeAll(() => {
	linkedBase = realpathSync(mkdtempSync(join(tmpdir(), "volt-sanitizer-differential-")));
	mkdirSync(join(linkedBase, "real"));
	symlinkSync(join(linkedBase, "real"), join(linkedBase, "linked"), process.platform === "win32" ? "junction" : "dir");
});

afterAll(() => {
	if (linkedBase) rmSync(linkedBase, { recursive: true, force: true });
});

describe.each(OPTION_SETS)("the remote sanitizer for $name", ({ options }) => {
	it("redacts text, cut text, and roots exactly as its reference", () => {
		const current = createIrohRemoteProjectionSanitizer(options());
		const reference = createReferenceSanitizer(options());
		fc.assert(
			fc.property(textArbitrary(rootsOf(options())), (text) => {
				expect(current.sanitizeText(text)).toBe(reference.sanitizeText(text));
				expect(current.sanitizeCutText(text)).toBe(reference.sanitizeCutText(text));
				expect(current.sanitizeCutText(`${text}…`)).toBe(reference.sanitizeCutText(`${text}…`));
				expect(current.containsRoot(text)).toBe(reference.containsRoot(text));
				expect(current.rootPrefixSuffix(text)).toBe(reference.rootPrefixSuffix(text));
			}),
			{ numRuns: TEXT_RUNS },
		);
	});

	it("redacts values field by field exactly as its reference", () => {
		const current = createIrohRemoteProjectionSanitizer(options());
		const reference = createReferenceSanitizer(options());
		const roots = rootsOf(options());
		fc.assert(
			fc.property(valueArbitrary(textArbitrary(roots), roots), fc.boolean(), (value, preserve) => {
				const preserver = preserve ? keep : undefined;
				expect(current.sanitizeValue(value, preserver)).toEqual(reference.sanitizeValue(value, preserver));
			}),
			{ numRuns: VALUE_RUNS },
		);
	});
});
