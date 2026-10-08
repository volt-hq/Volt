/**
 * `/review --engine <name>`: the engines a client offers after `--engine`, the engine's own options as flags once
 * the line names it, and the split of a parsed line into what the host's `review` intent takes.
 */

import { INTENT_SCHEMAS, type RpcReviewEngine } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import {
	completeIntentCommand,
	formatIntentCommand,
	type IntentCommand,
	intentCommandForm,
	intentCommandUsage,
	parseIntentCommand,
	readCommandHints,
} from "../src/client/intent-command.ts";
import {
	findReviewEngine,
	reviewEngineInput,
	reviewEngineParameterNames,
	reviewEngineWord,
	reviewEngineWords,
	withReviewEngine,
	withReviewEngines,
} from "../src/client/review-engine-command.ts";

function engine(extension: string, name: string, overrides: Partial<RpcReviewEngine> = {}): RpcReviewEngine {
	return {
		id: `ext:${extension}/${name}`,
		name,
		extension,
		label: name[0]?.toUpperCase() + name.slice(1),
		description: `The ${name} engine.`,
		targets: ["uncommitted", "branch"],
		remoteSafe: false,
		...overrides,
	};
}

const swarm = engine("swarm-review", "swarm", {
	cost: "Much slower than standard.",
	parameters: {
		type: "object",
		properties: {
			workers: {
				type: "integer",
				title: "Workers",
				description: "Reviewers to run.",
				minimum: 1,
				maximum: 32,
				default: 30,
			},
			waveSize: { type: "integer", minimum: 1, maximum: 32 },
			model: { type: "string", maxLength: 100 },
			thinking: { type: "string", enum: ["low", "high"], default: "high" },
			exec: { type: "boolean", default: false },
		},
	},
	localOnly: ["exec"],
});
const deep = engine("other", "deep");

function reviewCommand(): IntentCommand {
	const command = readCommandHints(
		JSON.parse(JSON.stringify(INTENT_SCHEMAS.review.input)) as Record<string, unknown>,
		{
			name: "review",
		},
	);
	if (!command) throw new Error("The review intent declares no command");
	return command;
}

const base = reviewCommand();

describe("naming an engine", () => {
	it("says its name when no other engine has it, else its id, and never lets an engine shadow standard", () => {
		const clash = engine("third", "deep");
		const shadow = engine("fourth", "standard");
		const all = [swarm, deep, clash, shadow];
		expect(reviewEngineWord(swarm, all)).toBe("swarm");
		expect(reviewEngineWord(deep, all)).toBe("ext:other/deep");
		expect(reviewEngineWord(clash, all)).toBe("ext:third/deep");
		expect(reviewEngineWord(shadow, all)).toBe("ext:fourth/standard");
		expect(reviewEngineWords([swarm, deep])).toEqual(["standard", "swarm", "deep"]);
	});

	it("finds the engine a word chooses, by its word or its id", () => {
		const all = [swarm, deep];
		expect(findReviewEngine("standard", all)).toBe("standard");
		expect(findReviewEngine("swarm", all)).toBe(swarm);
		expect(findReviewEngine("ext:swarm-review/swarm", all)).toBe(swarm);
		expect(findReviewEngine("Swarm", all)).toBeUndefined();
		expect(findReviewEngine("swarm-review", all)).toBeUndefined();
		expect(findReviewEngine("nothing", all)).toBeUndefined();
		const clash = engine("third", "deep");
		// With two engines of one name, the short name no longer says which.
		expect(findReviewEngine("deep", [deep, clash])).toBeUndefined();
		expect(findReviewEngine("ext:third/deep", [deep, clash])).toBe(clash);
	});
});

describe("offering engines after --engine", () => {
	const offered = withReviewEngines(base, [swarm, deep]);
	const values = async (text: string): Promise<string[]> =>
		(await completeIntentCommand(offered, text, async () => [])).map((completion) => completion.value);

	it("completes standard and each engine, with what it costs", async () => {
		expect(await values("uncommitted --engine ")).toEqual([
			"uncommitted --engine standard",
			"uncommitted --engine swarm",
			"uncommitted --engine deep",
		]);
		expect(await values("uncommitted --engine s")).toEqual([
			"uncommitted --engine standard",
			"uncommitted --engine swarm",
		]);
		const [, swarmCompletion] = await completeIntentCommand(offered, "uncommitted --engine ", async () => []);
		// The left column is the word to type, as for standard; the label is for the running review.
		expect(swarmCompletion).toMatchObject({
			label: "swarm",
			description: "The swarm engine. Much slower than standard.",
		});
		// The engines are only suggestions: without any, nothing is offered for the value.
		expect(
			(await completeIntentCommand(withReviewEngines(base, []), "uncommitted --engine ", async () => [])).map(
				(completion) => completion.value,
			),
		).toEqual(["uncommitted --engine standard"]);
		expect(await values("uncommitted --engine=")).toEqual([]);
	});

	it("leaves the options form as it was", () => {
		expect(intentCommandForm(offered).map((field) => field.id)).toEqual(
			intentCommandForm(base).map((field) => field.id),
		);
		expect(intentCommandForm(offered).map((field) => field.id)).not.toContain("engine");
	});
});

describe("an engine's own flags", () => {
	const command = withReviewEngine(withReviewEngines(base, [swarm, deep]), swarm);

	it("parse beside the review's, typed by their declaration, in kebab case", () => {
		expect(
			parseIntentCommand(
				command,
				"branch main --engine swarm --workers 4 --wave-size 2 --model gpt --thinking low --exec --focus auth",
			).input,
		).toEqual({
			target: "branch",
			base: "main",
			engine: "swarm",
			workers: 4,
			waveSize: 2,
			model: "gpt",
			thinking: "low",
			exec: true,
			focus: "auth",
		});
		for (const [text, message] of [
			["uncommitted --workers 0", "--workers must be an integer from 1 to 32."],
			["uncommitted --workers many", "--workers must be an integer from 1 to 32."],
			["uncommitted --thinking max", "--thinking must be low or high."],
			["uncommitted --model", "--model needs a value."],
			["uncommitted --colour red", 'Unknown or misplaced argument "--colour".'],
		] as const) {
			expect(parseIntentCommand(command, text).error, text).toContain(message);
		}
	});

	it("are not flags until the line names the engine", () => {
		expect(parseIntentCommand(withReviewEngines(base, [swarm]), "uncommitted --workers 4").error).toContain(
			'Unknown or misplaced argument "--workers".',
		);
	});

	it("show in the usage line, in completions, and in the equivalent command", async () => {
		expect(intentCommandUsage(command)).toContain(
			"[--engine <engine>] [--workers <n>] [--wave-size <n>] [--model <model>] [--thinking low|high] [--exec]",
		);
		const values = async (text: string): Promise<string[]> =>
			(await completeIntentCommand(command, text, async () => [])).map((completion) => completion.value);
		expect(await values("uncommitted --engine swarm --w")).toEqual([
			"uncommitted --engine swarm --workers",
			"uncommitted --engine swarm --wave-size",
		]);
		expect(await values("uncommitted --engine swarm --thinking ")).toEqual([
			"uncommitted --engine swarm --thinking low",
			"uncommitted --engine swarm --thinking high",
		]);
		const [workers] = await completeIntentCommand(command, "uncommitted --engine swarm --wo", async () => []);
		expect(workers?.description).toBe("Reviewers to run.");
		// Only what differs from a default is written.
		expect(
			formatIntentCommand(command, {
				target: "branch",
				base: "main",
				engine: "swarm",
				workers: 30,
				thinking: "low",
				exec: false,
			}),
		).toBe("branch main --engine swarm --thinking low");
		expect(formatIntentCommand(command, { target: "uncommitted", engine: "swarm", workers: 4, exec: true })).toBe(
			"uncommitted --engine swarm --workers 4 --exec",
		);
	});

	it("never replace one of the review's own flags", () => {
		const shadowing = engine("bad", "shadow", {
			parameters: {
				type: "object",
				properties: { focus: { type: "string", default: "mine" }, extra: { type: "boolean" } },
			},
		});
		const derived = withReviewEngine(base, shadowing);
		expect(derived.flags.get("focus")?.field.default).toBeUndefined();
		expect(derived.flags.has("extra")).toBe(true);
	});

	it("keep the engine's declared order", () => {
		expect(reviewEngineParameterNames(swarm)).toEqual(["workers", "waveSize", "model", "thinking", "exec"]);
		expect(reviewEngineParameterNames(deep)).toEqual([]);
	});
});

describe("what the host's review intent takes", () => {
	it("splits a parsed line into the review's fields, the engine's id, and the engine's options", () => {
		const line = {
			target: "branch",
			base: "main",
			engine: "swarm",
			focus: "auth",
			workers: 4,
			waveSize: 2,
			exec: true,
		};
		expect(reviewEngineInput(line, swarm)).toEqual({
			input: { target: "branch", base: "main", focus: "auth", engine: "ext:swarm-review/swarm" },
			engineParams: { workers: 4, waveSize: 2, exec: true },
		});
		// An engine with no options gets none, and standard is no engine at all.
		expect(reviewEngineInput({ target: "uncommitted", engine: "deep" }, deep)).toEqual({
			input: { target: "uncommitted", engine: "ext:other/deep" },
		});
		expect(reviewEngineInput({ target: "uncommitted", engine: "standard", focus: "x" }, "standard")).toEqual({
			input: { target: "uncommitted", focus: "x" },
		});
		expect(reviewEngineInput({ target: "uncommitted", focus: "x" }, undefined)).toEqual({
			input: { target: "uncommitted", focus: "x" },
		});
	});
});
