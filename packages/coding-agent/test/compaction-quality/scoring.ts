import type { AgentMessage } from "@hansjm10/volt-agent-core";

export const QUALITY_LAYERS = ["delivery", "summary", "continuation"] as const;
export type QualityLayer = (typeof QUALITY_LAYERS)[number];

export interface QualityInput {
	messages: Array<{ id: string; message: AgentMessage }>;
	/** First message that remains verbatim; an assistant/tool-result group must not be split. */
	firstKeptMessageId: string;
	continuationPrompt: string;
}

export interface QualityCriterion {
	id: string;
	layer: QualityLayer;
	requirement: string;
	/** Source anchors for the grader, never additional instructions to the evaluated model. */
	sourceMessageIds: string[];
	critical: boolean;
}

export interface QualityFixture {
	id: string;
	input: QualityInput;
	criteria: QualityCriterion[];
}

/** Human- or executable-check assessments of actual artifacts, not model self-reports. */
export interface QualityAssessment {
	criterionId: string;
	outcome: "pass" | "fail";
	/** An artifact location and the concrete observation supporting the verdict. */
	evidence: string;
}

export interface LayerScore {
	passed: number;
	failed: number;
	unassessed: number;
	/** Null until every criterion in this layer has an assessment. Range: 0..1. */
	passRate: number | null;
}

export interface QualityScore {
	fixtureId: string;
	complete: boolean;
	criticalFailures: string[];
	layers: Record<QualityLayer, LayerScore>;
	assessments: QualityAssessment[];
}

function requireText(value: string, label: string): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text`);
}

/** Validate authored rubric references. This is not a parser for untrusted session snapshots. */
export function validateQualityFixture(fixture: QualityFixture): void {
	requireText(fixture.id, "Fixture id");
	requireText(fixture.input.continuationPrompt, "Continuation prompt");
	const messageIds = new Set<string>();
	for (const { id } of fixture.input.messages) {
		requireText(id, "Message id");
		if (messageIds.has(id)) throw new Error(`Duplicate message id: ${id}`);
		messageIds.add(id);
	}
	const firstKeptIndex = fixture.input.messages.findIndex(({ id }) => id === fixture.input.firstKeptMessageId);
	if (firstKeptIndex < 1) throw new Error("Fixture must have older history and a valid retained boundary");
	if (fixture.input.messages[firstKeptIndex].message.role === "toolResult") {
		throw new Error("Retained boundary cannot split a tool-call/result group");
	}
	const criterionIds = new Set<string>();
	for (const criterion of fixture.criteria) {
		requireText(criterion.id, "Criterion id");
		requireText(criterion.requirement, "Criterion requirement");
		if (criterionIds.has(criterion.id)) throw new Error(`Duplicate criterion id: ${criterion.id}`);
		criterionIds.add(criterion.id);
		if (!QUALITY_LAYERS.includes(criterion.layer)) throw new Error(`Invalid quality layer: ${criterion.layer}`);
		if (typeof criterion.critical !== "boolean") throw new Error("Criterion critical flag must be boolean");
		if (criterion.sourceMessageIds.length === 0) throw new Error(`Missing source anchors: ${criterion.id}`);
		for (const id of criterion.sourceMessageIds) {
			if (!messageIds.has(id)) throw new Error(`Unknown source message: ${id}`);
		}
	}
	for (const layer of QUALITY_LAYERS) {
		if (!fixture.criteria.some((criterion) => criterion.layer === layer)) {
			throw new Error(`Missing ${layer} criteria`);
		}
	}
}

/** Deliberately excludes the answer rubric. Callers still choose the production compaction path. */
export function getQualityInput(fixture: QualityFixture): QualityInput {
	validateQualityFixture(fixture);
	return structuredClone({
		messages: fixture.input.messages,
		firstKeptMessageId: fixture.input.firstKeptMessageId,
		continuationPrompt: fixture.input.continuationPrompt,
	});
}

/**
 * Aggregate explicit assessments without pretending to infer semantics from keywords.
 * Missing assessments remain unassessed. No overall average can hide a continuation failure.
 */
export function scoreQuality(fixture: QualityFixture, assessments: readonly QualityAssessment[]): QualityScore {
	validateQualityFixture(fixture);
	const criteria = new Map(fixture.criteria.map((criterion) => [criterion.id, criterion]));
	const byId = new Map<string, QualityAssessment>();
	for (const assessment of assessments) {
		if (!criteria.has(assessment.criterionId)) throw new Error(`Unknown criterion: ${assessment.criterionId}`);
		if (byId.has(assessment.criterionId)) throw new Error(`Duplicate assessment: ${assessment.criterionId}`);
		if (assessment.outcome !== "pass" && assessment.outcome !== "fail") {
			throw new Error(`Invalid assessment outcome: ${assessment.outcome}`);
		}
		requireText(assessment.evidence, "Assessment evidence");
		byId.set(assessment.criterionId, assessment);
	}
	const layers: QualityScore["layers"] = {
		delivery: { passed: 0, failed: 0, unassessed: 0, passRate: null },
		summary: { passed: 0, failed: 0, unassessed: 0, passRate: null },
		continuation: { passed: 0, failed: 0, unassessed: 0, passRate: null },
	};
	const criticalFailures: string[] = [];
	const orderedAssessments: QualityAssessment[] = [];
	for (const criterion of fixture.criteria) {
		const score = layers[criterion.layer];
		const assessment = byId.get(criterion.id);
		if (!assessment) {
			score.unassessed++;
		} else {
			if (assessment.outcome === "pass") score.passed++;
			else {
				score.failed++;
				if (criterion.critical) criticalFailures.push(criterion.id);
			}
			orderedAssessments.push({
				criterionId: criterion.id,
				outcome: assessment.outcome,
				evidence: assessment.evidence,
			});
		}
	}
	for (const layer of QUALITY_LAYERS) {
		const score = layers[layer];
		if (score.unassessed === 0) score.passRate = score.passed / (score.passed + score.failed);
	}
	return {
		fixtureId: fixture.id,
		complete: QUALITY_LAYERS.every((layer) => layers[layer].unassessed === 0),
		criticalFailures,
		layers,
		assessments: orderedAssessments,
	};
}
