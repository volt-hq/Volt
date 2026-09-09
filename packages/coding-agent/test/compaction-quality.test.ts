import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createQualityFixtures } from "./compaction-quality/fixtures.ts";
import {
	getQualityInput,
	QUALITY_LAYERS,
	type QualityAssessment,
	type QualityFixture,
	scoreQuality,
	validateQualityFixture,
} from "./compaction-quality/scoring.ts";

function assessed(fixture: QualityFixture, outcome: "pass" | "fail"): QualityAssessment[] {
	return fixture.criteria.map((criterion) => ({
		criterionId: criterion.id,
		outcome,
		evidence: `test-artifact/${fixture.id}: controlled ${outcome} observation for ${criterion.id}`,
	}));
}

describe("compaction quality rubric accounting (not model evaluation)", () => {
	it("does not report unassessed work as success", () => {
		const fixture = createQualityFixtures()[0];
		const result = scoreQuality(fixture, []);
		expect(result.complete).toBe(false);
		expect(result.criticalFailures).toEqual([]);
		expect(result.assessments).toEqual([]);
		for (const layer of QUALITY_LAYERS) {
			expect(result.layers[layer]).toEqual({
				passed: 0,
				failed: 0,
				unassessed: fixture.criteria.filter((criterion) => criterion.layer === layer).length,
				passRate: null,
			});
		}
	});

	it("reports each layer separately and retains assessment evidence in rubric order", () => {
		const fixture = createQualityFixtures()[0];
		const assessments = assessed(fixture, "pass");
		const result = scoreQuality(fixture, [...assessments].reverse());
		expect(result.complete).toBe(true);
		expect(result.fixtureId).toBe(fixture.id);
		expect(result.criticalFailures).toEqual([]);
		expect(result.assessments).toEqual(assessments);
		for (const layer of QUALITY_LAYERS) {
			expect(result.layers[layer]).toEqual({
				passed: fixture.criteria.filter((criterion) => criterion.layer === layer).length,
				failed: 0,
				unassessed: 0,
				passRate: 1,
			});
		}
	});

	it("cannot hide a critical continuation failure behind successful delivery and summary scores", () => {
		const fixture = createQualityFixtures()[0];
		const assessments = assessed(fixture, "pass");
		const continuation = fixture.criteria.find((criterion) => criterion.layer === "continuation")!;
		assessments.find((assessment) => assessment.criterionId === continuation.id)!.outcome = "fail";
		const result = scoreQuality(fixture, assessments);
		expect(result.complete).toBe(true);
		expect(result.criticalFailures).toEqual([continuation.id]);
		expect(result.layers.delivery.passRate).toBe(1);
		expect(result.layers.summary.passRate).toBe(1);
		expect(result.layers.continuation).toEqual({ passed: 0, failed: 1, unassessed: 0, passRate: 0 });
	});

	it("counts noncritical failures without labeling them critical", () => {
		const fixture = createQualityFixtures().find((item) => item.id === "partial-verification")!;
		const assessments = assessed(fixture, "pass");
		assessments.find((assessment) => assessment.criterionId === "focused-result")!.outcome = "fail";
		const result = scoreQuality(fixture, assessments);
		expect(result.criticalFailures).toEqual([]);
		expect(result.layers.summary).toEqual({ passed: 1, failed: 1, unassessed: 0, passRate: 0.5 });
	});

	it("withholds a partial layer score and still reports observed critical failures", () => {
		const fixture = createQualityFixtures()[0];
		const summary = fixture.criteria.find((criterion) => criterion.layer === "summary")!;
		const result = scoreQuality(fixture, [
			{ criterionId: summary.id, outcome: "fail", evidence: "checkpoint: required API constraint absent" },
		]);
		expect(result.complete).toBe(false);
		expect(result.criticalFailures).toEqual([summary.id]);
		expect(result.layers.summary).toEqual({ passed: 0, failed: 1, unassessed: 1, passRate: null });
	});

	it("rejects unknown and duplicate assessments", () => {
		const fixture = createQualityFixtures()[0];
		const assessment = assessed(fixture, "pass")[0];
		expect(() => scoreQuality(fixture, [{ ...assessment, criterionId: "unknown" }])).toThrow("Unknown criterion");
		expect(() => scoreQuality(fixture, [assessment, assessment])).toThrow("Duplicate assessment");
	});

	it.each(["", "  ", undefined, null, 1])("rejects missing or invalid evidence (%j)", (evidence) => {
		const fixture = createQualityFixtures()[0];
		expect(() => scoreQuality(fixture, [{ ...assessed(fixture, "pass")[0], evidence: evidence as string }])).toThrow(
			"Assessment evidence",
		);
	});

	it.each(["unknown", "unassessed", "PASS", undefined, null, 1])(
		"rejects invalid assessment outcomes (%j)",
		(outcome) => {
			const fixture = createQualityFixtures()[0];
			expect(() =>
				scoreQuality(fixture, [
					{ ...assessed(fixture, "pass")[0], outcome: outcome as QualityAssessment["outcome"] },
				]),
			).toThrow("Invalid assessment outcome");
		},
	);

	it("owns report data and does not mutate the fixture or assessments", () => {
		const fixture = createQualityFixtures()[0];
		const originalFixture = structuredClone(fixture);
		const assessments = assessed(fixture, "pass");
		const originalAssessments = structuredClone(assessments);
		const result = scoreQuality(fixture, assessments);
		expect(fixture).toEqual(originalFixture);
		expect(assessments).toEqual(originalAssessments);
		result.assessments[0].evidence = "modified report";
		expect(assessments).toEqual(originalAssessments);
	});
});

describe("offline compaction quality fixtures", () => {
	it("provides twelve distinct, reproducible cases with evidence-backed criteria for every layer", () => {
		const fixtures = createQualityFixtures();
		expect(fixtures).toHaveLength(12);
		expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
		expect(createQualityFixtures()).toEqual(fixtures);
		for (const fixture of fixtures) {
			expect(() => validateQualityFixture(fixture)).not.toThrow();
			expect(scoreQuality(fixture, assessed(fixture, "fail")).complete).toBe(true);
		}
	});

	it("projects detached native input without grader criteria", () => {
		const fixture = createQualityFixtures()[0];
		fixture.criteria[0].requirement = "GRADER-ONLY-ANSWER";
		const input = getQualityInput(fixture);
		expect(Object.keys(input).sort()).toEqual(["continuationPrompt", "firstKeptMessageId", "messages"]);
		expect(input).toEqual(fixture.input);
		expect(JSON.stringify(input)).not.toContain("GRADER-ONLY-ANSWER");
		input.messages[0].id = "modified";
		expect(fixture.input.messages[0].id).toBe("request");
	});

	it("has complete native tool-call/result groups on both sides of each retained boundary", () => {
		for (const fixture of createQualityFixtures()) {
			const input = getQualityInput(fixture);
			const boundary = input.messages.findIndex(({ id }) => id === input.firstKeptMessageId);
			for (const part of [input.messages.slice(0, boundary), input.messages.slice(boundary)]) {
				const pending = new Map<string, string>();
				for (const { message } of part) {
					if (message.role === "toolResult") {
						expect(pending.get(message.toolCallId)).toBe(message.toolName);
						pending.delete(message.toolCallId);
					} else {
						expect(pending.size).toBe(0);
						if (message.role === "assistant") {
							for (const block of message.content) {
								if (block.type === "toolCall") pending.set(block.id, block.name);
							}
						}
					}
				}
				expect(pending.size).toBe(0);
			}
		}
	});

	it("places decisive log evidence beyond the current fallback truncation boundary", () => {
		const fixture = createQualityFixtures().find((item) => item.id === "late-tool-evidence")!;
		const messages = getQualityInput(fixture).messages.map(({ message }) => message);
		const log = messages.find((message) => message.role === "toolResult");
		expect(log?.role).toBe("toolResult");
		if (log?.role !== "toolResult") throw new Error("Missing fixture log");
		const text = log.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text.indexOf("E409_SCHEMA_REVISION")).toBeGreaterThan(2_000);
		// This is a known delivery limitation to measure, not a semantic-quality passing result.
		expect(serializeConversation(convertToLlm(messages))).not.toContain("E409_SCHEMA_REVISION");
	});

	it.each([
		{
			name: "duplicate messages",
			change: (fixture: QualityFixture) => fixture.input.messages.push(fixture.input.messages[0]),
			error: "Duplicate message",
		},
		{
			name: "duplicate criteria",
			change: (fixture: QualityFixture) => fixture.criteria.push(fixture.criteria[0]),
			error: "Duplicate criterion",
		},
		{
			name: "unknown source",
			change: (fixture: QualityFixture) => {
				fixture.criteria[0].sourceMessageIds = ["missing"];
			},
			error: "Unknown source",
		},
		{
			name: "missing source",
			change: (fixture: QualityFixture) => {
				fixture.criteria[0].sourceMessageIds = [];
			},
			error: "Missing source",
		},
		{
			name: "missing layer",
			change: (fixture: QualityFixture) => {
				fixture.criteria = fixture.criteria.filter((criterion) => criterion.layer !== "continuation");
			},
			error: "Missing continuation",
		},
		{
			name: "unknown boundary",
			change: (fixture: QualityFixture) => {
				fixture.input.firstKeptMessageId = "missing";
			},
			error: "valid retained boundary",
		},
		{
			name: "empty older history",
			change: (fixture: QualityFixture) => {
				fixture.input.firstKeptMessageId = "request";
			},
			error: "older history",
		},
		{
			name: "split tool group",
			change: (fixture: QualityFixture) => {
				fixture.input.firstKeptMessageId = "read";
			},
			error: "tool-call/result group",
		},
		{
			name: "empty requirement",
			change: (fixture: QualityFixture) => {
				fixture.criteria[0].requirement = " ";
			},
			error: "Criterion requirement",
		},
	])("rejects $name", ({ change, error }) => {
		const fixture = createQualityFixtures()[0];
		change(fixture);
		expect(() => getQualityInput(fixture)).toThrow(error);
		expect(() => scoreQuality(fixture, [])).toThrow(error);
	});
});
