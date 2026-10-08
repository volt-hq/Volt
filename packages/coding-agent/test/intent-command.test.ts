/**
 * An intent's input as a command line (`client/intent-command.ts`), against the real `review` input schema as a
 * client receives it in the intents catalog: the grammar `/review` always had, the equivalent command of an input,
 * the options form, and completions.
 */

import { INTENT_SCHEMAS, UiNodeFormFieldSchema } from "@hansjm10/volt-protocol";
import * as fc from "fast-check";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
	completeIntentCommand,
	formatIntentCommand,
	type IntentCommand,
	IntentCommandHintsError,
	type IntentCommandInput,
	intentCommandExample,
	intentCommandFlagValue,
	intentCommandForm,
	intentCommandFormInput,
	intentCommandUsage,
	parseIntentCommand,
	readCommandHints,
} from "../src/client/intent-command.ts";
import { intentRegistry } from "../src/core/protocol/intents/index.ts";
import { DEFAULT_REVIEW_RUN_CONTROLS } from "../src/core/review.ts";

const PROPERTY_SEED = 7_250_003;

type JsonObject = Record<string, unknown>;

/** The review intent's input schema as the intents catalog carries it. */
function reviewInput(): JsonObject {
	return JSON.parse(JSON.stringify(INTENT_SCHEMAS.review.input)) as JsonObject;
}

function child(parent: JsonObject, key: string): JsonObject {
	const value = parent[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} is not an object`);
	return value as JsonObject;
}

function listOf(parent: JsonObject, key: string): unknown[] {
	const value = parent[key];
	if (!Array.isArray(value)) throw new Error(`${key} is not a list`);
	return value;
}

function reviewCommand(): IntentCommand {
	const command = readCommandHints(reviewInput(), {
		name: "review",
		localKeywords: [{ word: "tools", description: "Choose the auxiliary review tools" }],
	});
	if (!command) throw new Error("The review intent declares no command");
	return command;
}

const review = reviewCommand();

function parsed(text: string): IntentCommandInput {
	const result = parseIntentCommand(review, text);
	if (result.error !== undefined) throw new Error(`"${text}" did not parse: ${result.error}`);
	if (result.input === undefined) throw new Error(`"${text}" filled no input`);
	return result.input;
}

function errorOf(text: string): string {
	const result = parseIntentCommand(review, text);
	if (result.error === undefined) throw new Error(`"${text}" parsed: ${JSON.stringify(result)}`);
	return result.error;
}

describe("parsing /review's command line", () => {
	it("reads the target, its positional word, and quoted flags", () => {
		expect(
			parsed(
				'branch main --focus "security boundary" --scope "src/**/*.ts,test/**/*.ts" --effort high --include-optional --full',
			),
		).toEqual({
			target: "branch",
			base: "main",
			focus: "security boundary",
			scope: "src/**/*.ts,test/**/*.ts",
			effort: "high",
			includeOptional: true,
			scopeMode: "full",
		});
		expect(parsed("uncommitted --incremental").scopeMode).toBe("incremental");
	});

	it("leaves out what the text does not name, so the host applies its defaults", () => {
		expect(parsed("uncommitted")).toEqual({ target: "uncommitted" });
		expect(parsed("pr")).toEqual({ target: "pr" });
		// A bare commit has no ref: the TUI offers its commit picker.
		expect(parsed("commit")).toEqual({ target: "commit" });
	});

	it("takes the positional word of the target, unless it is a flag", () => {
		expect(parsed("pr 42")).toEqual({ target: "pr", number: "42" });
		expect(parsed("commit abc123 --full")).toEqual({ target: "commit", ref: "abc123", scopeMode: "full" });
		expect(parsed("branch --effort high")).toEqual({ target: "branch", effort: "high" });
		expect(parsed("branch-uncommitted main --focus tests")).toEqual({
			target: "branch_uncommitted",
			base: "main",
			focus: "tests",
		});
		expect(parsed("branch_uncommitted")).toEqual({ target: "branch_uncommitted" });
	});

	it("accepts the aliases and any case for the target word", () => {
		expect(parsed("unstaged")).toEqual({ target: "uncommitted" });
		expect(parsed("working --full")).toEqual({ target: "uncommitted", scopeMode: "full" });
		expect(parsed("BRANCH Main")).toEqual({ target: "branch", base: "Main" });
	});

	it("accepts --name=value, and a bare boolean, with the last scope-mode flag winning", () => {
		expect(parsed('branch main --effort=high --focus="a b"')).toEqual({
			target: "branch",
			base: "main",
			effort: "high",
			focus: "a b",
		});
		expect(parsed("uncommitted --include-optional=false")).toEqual({ target: "uncommitted", includeOptional: false });
		expect(parsed("uncommitted --incremental --full").scopeMode).toBe("full");
		expect(parsed("uncommitted --full --incremental").scopeMode).toBe("incremental");
		// A value that reads as a flag can follow `=`.
		expect(parsed("uncommitted --focus=--weird")).toEqual({ target: "uncommitted", focus: "--weird" });
	});

	it("splits scope on commas and newlines, merges repeats, and drops duplicates and empty entries", () => {
		expect(parsed('uncommitted --scope "a, b" --scope "b\nc" --scope a')).toEqual({
			target: "uncommitted",
			scope: "a,b,c",
		});
		expect(parsed('uncommitted --scope ","')).toEqual({ target: "uncommitted" });
	});

	it("keeps quoting rules: an escape only inside quotes", () => {
		expect(parsed('uncommitted --focus "say \\"hi\\""').focus).toBe('say "hi"');
		expect(parsed("uncommitted --focus a\\b").focus).toBe("a\\b");
		expect(parsed("uncommitted --focus 'single quoted'").focus).toBe("single quoted");
	});

	it("gives {} for empty text and names a local keyword", () => {
		expect(parseIntentCommand(review, "")).toEqual({});
		expect(parseIntentCommand(review, "   ")).toEqual({});
		expect(parseIntentCommand(review, "tools")).toEqual({ local: "tools" });
		expect(parseIntentCommand(review, "TOOLS")).toEqual({ local: "tools" });
		expect(errorOf("tools now")).toMatch(/Unexpected arguments after "tools"/);
	});

	it("reports errors with the usage line", () => {
		expect(errorOf('commit HEAD --focus "unterminated')).toMatch(/Unterminated/);
		expect(errorOf("pr 1 --effort extreme")).toMatch(/low, standard, or high/);
		expect(errorOf("uncommitted --effort")).toMatch(/--effort must be low, standard, or high/);
		expect(errorOf("uncommitted --focus")).toMatch(/--focus needs a value/);
		expect(errorOf("uncommitted --focus --scope x")).toMatch(/--focus needs a value/);
		expect(errorOf("uncommitted --focus=")).toMatch(/--focus needs a value/);
		expect(errorOf("uncommitted extra")).toMatch(/Unknown or misplaced argument "extra"/);
		expect(errorOf("--effort high")).toMatch(/Unknown target "--effort"/);
		expect(errorOf("nonsense")).toMatch(/Unknown target "nonsense"/);
		expect(errorOf("uncommitted --include-optional=maybe")).toMatch(/true or false/);
		expect(errorOf("uncommitted --full=yes")).toMatch(/--full takes no value/);
		// What is not a declared flag is not one: the auxiliary tools and a pinned URL are typed input only.
		for (const flag of ["--tools bash", "--url https://example.test/pull/1", "--base main", "--target pr"]) {
			expect(errorOf(`uncommitted ${flag}`)).toMatch(/Unknown or misplaced argument/);
		}
		expect(errorOf("nonsense")).toContain("Usage: /review");
	});
});

describe("the equivalent command", () => {
	it("writes the target, its positional word, and only the flags that differ from their defaults", () => {
		expect(
			formatIntentCommand(review, {
				target: "branch",
				base: "main",
				focus: "security boundary",
				scope: "src/**,test/**",
				effort: "high",
				includeOptional: true,
				scopeMode: "full",
			}),
		).toBe('branch main --focus "security boundary" --scope src/**,test/** --effort high --include-optional --full');
		expect(
			formatIntentCommand(review, {
				target: "branch_uncommitted",
				effort: "standard",
				includeOptional: false,
				scopeMode: "incremental",
			}),
		).toBe("branch-uncommitted");
		expect(formatIntentCommand(review, { target: "uncommitted", scopeMode: "incremental" })).toBe("uncommitted");
	});

	it("leaves out what the command has no flag for", () => {
		expect(
			formatIntentCommand(review, {
				target: "pr",
				number: "7",
				url: "https://example.test/pull/7",
				tools: ["bash"],
			}),
		).toBe("pr 7");
	});

	it("quotes values that would not read back, and puts a value that reads as a flag after =", () => {
		expect(formatIntentCommand(review, { target: "uncommitted", focus: 'say "hi" \\ there' })).toBe(
			'uncommitted --focus "say \\"hi\\" \\\\ there"',
		);
		expect(formatIntentCommand(review, { target: "uncommitted", focus: "--weird" })).toBe(
			"uncommitted --focus=--weird",
		);
		expect(formatIntentCommand(review, { target: "branch", base: "my branch" })).toBe('branch "my branch"');
	});

	it("reads back as the same input without its defaults, for any input", () => {
		const word = fc
			.array(fc.constantFrom(..."abZ9 \"'\\,=é漢😀-_/*.".split("")), { minLength: 1, maxLength: 10 })
			.map((characters) => characters.join(""));
		const positional = word.filter((value) => !value.startsWith("--"));
		const entry = word.map((value) => value.replace(/,/g, "").trim()).filter((value) => value !== "");
		const positionalField: Record<string, string> = {
			branch: "base",
			branch_uncommitted: "base",
			pr: "number",
			commit: "ref",
		};
		const arbitrary = fc.record({
			target: fc.constantFrom("uncommitted", "branch", "branch_uncommitted", "pr", "commit"),
			positional,
			focus: fc.option(word, { nil: undefined }),
			scope: fc.option(fc.uniqueArray(entry, { maxLength: 4 }), { nil: undefined }),
			effort: fc.option(fc.constantFrom("low", "standard", "high"), { nil: undefined }),
			includeOptional: fc.option(fc.boolean(), { nil: undefined }),
			scopeMode: fc.option(fc.constantFrom("incremental", "full"), { nil: undefined }),
		});
		fc.assert(
			fc.property(arbitrary, (generated) => {
				const field = positionalField[generated.target];
				const input: IntentCommandInput = { target: generated.target };
				if (field !== undefined) input[field] = generated.positional;
				if (generated.focus !== undefined) input.focus = generated.focus;
				if (generated.scope !== undefined && generated.scope.length > 0) input.scope = generated.scope.join(",");
				if (generated.effort !== undefined) input.effort = generated.effort;
				if (generated.includeOptional !== undefined) input.includeOptional = generated.includeOptional;
				if (generated.scopeMode !== undefined) input.scopeMode = generated.scopeMode;

				const expected: IntentCommandInput = { ...input };
				if (expected.effort === "standard") delete expected.effort;
				if (expected.includeOptional === false) delete expected.includeOptional;
				if (expected.scopeMode === "incremental") delete expected.scopeMode;

				const text = formatIntentCommand(review, input);
				const result = parseIntentCommand(review, text);
				expect(result.error, text).toBeUndefined();
				expect(result.input, text).toEqual(expected);
			}),
			{ seed: PROPERTY_SEED, numRuns: 300 },
		);
	});
});

describe("the declaration", () => {
	it("is read from the real review schema", () => {
		expect(review.name).toBe("review");
		expect(review.keyword?.field).toBe("target");
		expect(review.keyword?.values).toEqual(["uncommitted", "branch", "branch_uncommitted", "pr", "commit"]);
		expect(review.fields.map((field) => field.name)).toEqual([
			"focus",
			"scope",
			"effort",
			"includeOptional",
			"scopeMode",
			"engine",
		]);
		expect([...review.flags.keys()]).toEqual([
			"focus",
			"scope",
			"effort",
			"include-optional",
			"incremental",
			"full",
			"engine",
		]);
		// The engine is a flag the options form does not show.
		expect(review.fields.filter((field) => !field.inForm).map((field) => field.name)).toEqual(["engine"]);
	});

	it("is undefined for a schema that declares none", () => {
		const input = reviewInput();
		delete input["x-volt-command"];
		expect(readCommandHints(input, { name: "review" })).toBeUndefined();
	});

	it("is refused when it does not fit the schema it annotates", () => {
		const broken = (change: (hints: JsonObject, input: JsonObject) => void): (() => unknown) => {
			const input = reviewInput();
			change(child(input, "x-volt-command"), input);
			return () => readCommandHints(input, { name: "review" });
		};
		const keyword = (hints: JsonObject): JsonObject => child(hints, "keyword");
		const set = (target: JsonObject, key: string, value: unknown): void => {
			target[key] = value;
		};
		const cases: Array<[string, () => unknown, RegExp]> = [
			["a keyword on a string", broken((hints) => set(keyword(hints), "field", "base")), /must be a string enum/],
			["a keyword on nothing", broken((hints) => set(keyword(hints), "field", "nope")), /not a property/],
			[
				"an alias of nothing",
				broken((hints) => set(keyword(hints), "aliases", { gone: "missing" })),
				/does not name a value/,
			],
			[
				"a positional of nothing",
				broken((hints) => set(child(keyword(hints), "positional"), "nothing", "base")),
				/not a value/,
			],
			[
				"a positional on an enum",
				broken((hints) => set(child(keyword(hints), "positional"), "pr", "effort")),
				/string property/,
			],
			["bare flags on a string", broken((hints) => set(hints, "flagValues", ["focus"])), /must be an enum/],
			["a list of an enum", broken((hints) => set(hints, "lists", ["effort"])), /must be a string/],
			[
				"an array as a flag",
				broken((hints) => listOf(hints, "form").push("tools")),
				/not a string, boolean, integer/,
			],
			["the keyword as a flag", broken((hints) => listOf(hints, "form").push("target")), /keyword's property/],
			["a flag twice", broken((hints) => listOf(hints, "form").push("focus")), /twice/],
			["a flag in the form and beside it", broken((hints) => listOf(hints, "flags").push("focus")), /twice/],
			[
				"the keyword as a flag beside the form",
				broken((hints) => listOf(hints, "flags").push("target")),
				/flags: "target" is the keyword's property/,
			],
			[
				"a flag beside the form of nothing",
				broken((hints) => listOf(hints, "flags").push("nope")),
				/flags: "nope" is not a property/,
			],
			["flags that are not a list", broken((hints) => set(hints, "flags", "engine")), /flags must be a list/],
			[
				"bare flags on a field that is not an enum",
				broken((hints) => set(hints, "flagValues", ["scopeMode", "effort", "focus"])),
				/must be an enum/,
			],
			[
				"a bare flag with no place in the form",
				broken((hints) => set(hints, "form", ["focus", "scope", "effort", "includeOptional"])),
				/is a flag but not in form/,
			],
			[
				"two words for two values",
				broken((hints) => set(keyword(hints), "aliases", { branch: "pr" })),
				/selects both/,
			],
			[
				"a default that is not an option",
				broken((_hints, input) => set(child(child(input, "properties"), "effort"), "default", "extreme")),
				/default of "effort" does not fit/,
			],
			[
				"hints that are not an object",
				broken((_hints, input) => set(input, "x-volt-command", 5)),
				/must be an object/,
			],
		];
		for (const [name, attempt, message] of cases) {
			expect(attempt, name).toThrow(IntentCommandHintsError);
			expect(attempt, name).toThrow(message);
		}
	});

	it("keeps the schema's defaults the host's own, and the slash example what the grammar generates", () => {
		const defaults = Object.fromEntries(
			review.fields.filter((field) => field.default !== undefined).map((field) => [field.name, field.default]),
		);
		expect(defaults).toEqual({
			effort: DEFAULT_REVIEW_RUN_CONTROLS.effort,
			includeOptional: DEFAULT_REVIEW_RUN_CONTROLS.includeOptional,
			scopeMode: DEFAULT_REVIEW_RUN_CONTROLS.scopeMode,
		});
		expect(DEFAULT_REVIEW_RUN_CONTROLS.scope).toEqual([]);
		expect(intentRegistry.get("review").slash?.example).toBe(intentCommandExample(review));
		expect(intentCommandExample(review)).toBe(
			"/review uncommitted | branch [base] | branch-uncommitted [base] | pr [number] | commit [ref]",
		);
	});

	it("names every keyword, positional word, and flag in the usage line", () => {
		expect(intentCommandUsage(review)).toBe(
			"Usage: /review [tools | uncommitted | branch [base] | branch-uncommitted [base] | pr [number] | commit [ref]] [--focus <focus>] [--scope <scope>] [--effort low|standard|high] [--include-optional] [--incremental|--full] [--engine <engine>]",
		);
	});
});

describe("a flag the options form does not show", () => {
	it("parses and writes like any other flag, and the form leaves it out", () => {
		expect(parseIntentCommand(review, "uncommitted --engine swarm --effort high").input).toEqual({
			target: "uncommitted",
			engine: "swarm",
			effort: "high",
		});
		expect(parseIntentCommand(review, "branch main --engine=ext:a/b").input).toEqual({
			target: "branch",
			base: "main",
			engine: "ext:a/b",
		});
		expect(parseIntentCommand(review, "uncommitted --engine").error).toContain("--engine needs a value.");
		expect(formatIntentCommand(review, { target: "uncommitted", engine: "swarm", effort: "high" })).toBe(
			"uncommitted --effort high --engine swarm",
		);
		// A submitted options form fills only what the form shows.
		expect(intentCommandFormInput(review, { focus: "auth", engine: "swarm" })).toEqual({ focus: "auth" });
	});

	it("is found in a line before the rest of it is read", () => {
		const value = (text: string) => intentCommandFlagValue(text, "engine");
		expect(value("uncommitted --engine swarm")).toBe("swarm");
		expect(value("branch main --focus x --engine=deep --effort high")).toBe("deep");
		expect(value('uncommitted --engine "ext:a/b"')).toBe("ext:a/b");
		// The last one wins, as in parsing.
		expect(value("uncommitted --engine a --engine b")).toBe("b");
		// Not given, or not given a value.
		expect(value("uncommitted")).toBeUndefined();
		expect(value("uncommitted --engine")).toBeUndefined();
		expect(value("uncommitted --engine --effort high")).toBeUndefined();
		expect(value("uncommitted --engine=")).toBeUndefined();
		// A value that merely contains the flag, another flag, and a broken quote are not it.
		expect(value('uncommitted --focus "--engine swarm"')).toBeUndefined();
		expect(value("uncommitted --engines swarm")).toBeUndefined();
		expect(value('uncommitted --engine "swarm')).toBeUndefined();
	});
});

describe("the options form", () => {
	it("has a field per flag, in order, each with its title, description, and default", () => {
		const form = intentCommandForm(review);
		expect(form.map((field) => [field.id, field.kind, field.label])).toEqual([
			["focus", "string", "Focus"],
			["scope", "string", "Scope"],
			["effort", "enum", "Effort"],
			["includeOptional", "boolean", "Include optional findings"],
			["scopeMode", "enum", "Scope mode"],
		]);
		for (const field of form) {
			expect(Check(UiNodeFormFieldSchema, field), JSON.stringify(field)).toBe(true);
			expect(field.description).toBeTruthy();
		}
		expect(form[2]).toMatchObject({
			value: "standard",
			options: [{ value: "low" }, { value: "standard" }, { value: "high" }],
		});
		expect(form[3]).toMatchObject({ value: false });
		expect(form[4]).toMatchObject({ value: "incremental", options: [{ value: "incremental" }, { value: "full" }] });
		expect(form[0]).not.toHaveProperty("value");
	});

	it("answers with only what is set and differs from the default", () => {
		expect(
			intentCommandFormInput(review, {
				focus: "",
				scope: "",
				effort: "standard",
				includeOptional: false,
				scopeMode: "incremental",
			}),
		).toEqual({});
		expect(
			intentCommandFormInput(review, {
				focus: "auth",
				scope: " src/** , test/** ,src/**",
				effort: "high",
				includeOptional: true,
				scopeMode: "full",
			}),
		).toEqual({ focus: "auth", scope: "src/**,test/**", effort: "high", includeOptional: true, scopeMode: "full" });
	});

	it("gives a form answer the same command a typed line gives", () => {
		const input = {
			target: "branch",
			base: "main",
			...intentCommandFormInput(review, { effort: "high", scopeMode: "full" }),
		};
		expect(formatIntentCommand(review, input)).toBe("branch main --effort high --full");
		expect(parsed("branch main --effort high --full")).toEqual(input);
	});
});

describe("completions", () => {
	const options: Record<string, readonly { value: string; label?: string; description?: string }[]> = {
		base: [{ value: "main" }, { value: "feature/login" }],
		ref: [{ value: "abc123", label: "Fix the thing", description: "2 days ago" }],
		number: [{ value: "243", label: "#243 Compact width UI", description: "Current branch" }],
	};
	const completer = vi.fn(async (field: string, prefix: string) =>
		(options[field] ?? []).filter((option) => option.value.startsWith(prefix)),
	);
	const values = async (text: string): Promise<string[]> =>
		(await completeIntentCommand(review, text, completer)).map((completion) => completion.value);

	it("offers the keywords for the first word, and the client's own", async () => {
		expect(await values("")).toEqual(["tools", "uncommitted", "branch", "branch-uncommitted", "pr", "commit"]);
		expect(await values("br")).toEqual(["branch", "branch-uncommitted"]);
		expect(await values("branch")).toEqual(["branch", "branch-uncommitted"]);
		expect(await values("BR")).toEqual(["branch", "branch-uncommitted"]);
		expect(await values("t")).toEqual(["tools"]);
		expect(await values("zzz")).toEqual([]);
	});

	it("offers nothing for a flag before the keyword, or for an unknown keyword", async () => {
		expect(await values("--e")).toEqual([]);
		expect(await values("nope ")).toEqual([]);
	});

	it("offers the host's values for the keyword's positional word, then the flags", async () => {
		const all = await values("branch ");
		expect(all.slice(0, 2)).toEqual(["branch main", "branch feature/login"]);
		expect(all.slice(2)).toEqual([
			"branch --focus",
			"branch --scope",
			"branch --effort",
			"branch --include-optional",
			"branch --incremental",
			"branch --full",
			"branch --engine",
		]);
		expect(await values("branch ma")).toEqual(["branch main"]);
		expect(await values("pr ")).toContain("pr 243");
		const commit = await completeIntentCommand(review, "commit ", completer);
		expect(commit[0]).toEqual({ value: "commit abc123", label: "Fix the thing", description: "2 days ago" });
	});

	it("quotes a value that needs it", async () => {
		const quoting = async () => [{ value: "my branch" }];
		const [first] = await completeIntentCommand(review, "branch ", quoting);
		expect(first?.value).toBe('branch "my branch"');
	});

	it("offers only flags once the positional word is given, and none already used", async () => {
		expect((await values("branch main ")).slice(0, 3)).toEqual([
			"branch main --focus",
			"branch main --scope",
			"branch main --effort",
		]);
		expect(await values("branch main --e")).toEqual(["branch main --effort", "branch main --engine"]);
		expect(await values("uncommitted --effort high --e")).toEqual(["uncommitted --effort high --engine"]);
		// One bare flag of an enum uses the enum.
		expect(await values("uncommitted --full --")).not.toContain("uncommitted --full --full");
		expect(await values("uncommitted --full --")).not.toContain("uncommitted --full --incremental");
		// A list flag can repeat.
		expect(await values("uncommitted --scope a --s")).toEqual(["uncommitted --scope a --scope"]);
	});

	it("offers an enum flag's values, and nothing for free text or inside quotes", async () => {
		expect(await values("uncommitted --effort ")).toEqual([
			"uncommitted --effort low",
			"uncommitted --effort standard",
			"uncommitted --effort high",
		]);
		expect(await values("uncommitted --effort h")).toEqual(["uncommitted --effort high"]);
		expect(await values("uncommitted --focus ")).toEqual([]);
		expect(await values("uncommitted --focus x")).toEqual([]);
		expect(await values('uncommitted --focus "abc')).toEqual([]);
	});

	it("does not ask the host for a word the keyword does not take", async () => {
		completer.mockClear();
		await values("uncommitted ");
		expect(completer).not.toHaveBeenCalled();
	});
});
