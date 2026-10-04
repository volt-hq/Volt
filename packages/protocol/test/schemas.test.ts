import { ApiSchema } from "@hansjm10/volt-ai/schemas";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import { type RpcGitContext, RpcGitContextSchema } from "../src/git-context.ts";
import { IntentPresentationSchema } from "../src/intents.ts";
import { RpcPlanningStateSchema } from "../src/planning.ts";
import { RpcSubscriptionUsageReportSchema } from "../src/subscription-usage.ts";

function check(schema: TSchema, value: unknown): boolean {
	return Compile(schema).Check(value);
}

describe("shared schemas", () => {
	test("open string enums accept novel values", () => {
		for (const schema of [ApiSchema, IntentPresentationSchema.properties.kind]) {
			expect(check(schema, "some-novel-value.v9")).toBe(true);
			expect(check(schema, 7)).toBe(false);
		}
	});

	test("subscription usage reports are strict and normalized", () => {
		const report = {
			status: "providers",
			providers: [
				{
					providerId: "openai-codex",
					result: {
						status: "success",
						snapshot: {
							providerId: "openai-codex",
							fetchedAt: 1_800_000_000_000,
							plan: "plus",
							limits: [
								{
									id: "weekly",
									label: "Weekly",
									usedPercent: 25.5,
									resetsAt: 1_800_086_400_000,
									windowDurationMs: 604_800_000,
									limitReached: false,
								},
							],
						},
					},
				},
			],
		};
		expect(check(RpcSubscriptionUsageReportSchema, report)).toBe(true);
		expect(check(RpcSubscriptionUsageReportSchema, { status: "no_subscription" })).toBe(true);
		expect(check(RpcSubscriptionUsageReportSchema, { status: "unsupported" })).toBe(true);
		expect(check(RpcSubscriptionUsageReportSchema, { ...report, rawPayload: {} })).toBe(false);
		expect(
			check(RpcSubscriptionUsageReportSchema, {
				...report,
				providers: [
					{
						...report.providers[0],
						result: {
							...report.providers[0].result,
							snapshot: { ...report.providers[0].result.snapshot, accountEmail: "private@example.com" },
						},
					},
				],
			}),
		).toBe(false);
		expect(
			check(RpcSubscriptionUsageReportSchema, {
				status: "providers",
				providers: [
					{
						providerId: "anthropic",
						result: { status: "error", error: { code: "rate_limited", message: "Try again later." } },
					},
				],
			}),
		).toBe(true);
	});

	test("Git context keeps path-free bounded fields", () => {
		const gitContext: RpcGitContext = {
			repository: "workspace",
			head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
			upstream: { ref: "origin/main", ahead: 2, behind: 1 },
			base: { ref: "main", ahead: 3, behind: 0 },
			status: {
				staged: { added: 1, modified: 2, deleted: 3, renamed: 4 },
				unstaged: { added: 4, modified: 3, deleted: 2, renamed: 1 },
				untracked: 5,
				conflicted: 1,
				total: 12,
				clean: false,
			},
			operation: { kind: "rebase", step: 2, total: 4 },
			revision: 7,
			observedAt: "2026-07-29T00:00:00.000Z",
			stale: false,
		};
		expect(check(RpcGitContextSchema, gitContext)).toBe(true);
		expect(check(RpcGitContextSchema, { ...gitContext, repository: "r".repeat(257) })).toBe(false);
		expect(check(RpcGitContextSchema, { ...gitContext, head: { kind: "detached", oid: "not-an-object-id" } })).toBe(
			false,
		);
	});

	test("planning state is a complete phase-consistent snapshot", () => {
		const planning = {
			mode: "build",
			plan: {
				id: "plan-1",
				revision: 3,
				phase: "active",
				title: "Ship Plan mode",
				summary: "Implement and verify the native workflow.",
				steps: [
					{
						id: "step-1",
						text: "Implement",
						status: "in_progress",
						substeps: [
							{ id: "substep-1", text: "Persist", status: "completed" },
							{ id: "substep-2", text: "Render", status: "in_progress" },
						],
					},
				],
				execution: {
					id: "execution-1",
					approvedRevision: 2,
					strategy: "retain_context",
					sourceSessionId: "session-1",
					targetSessionId: "session-1",
				},
			},
		};
		const validator = Compile(RpcPlanningStateSchema);
		expect(validator.Errors(planning)).toEqual([]);
		expect(validator.Check({ ...planning, plan: { ...planning.plan, execution: undefined } })).toBe(false);
		expect(validator.Check({ ...planning, plan: { ...planning.plan, phase: "ready" } })).toBe(false);
		expect(
			validator.Check({
				...planning,
				plan: {
					...planning.plan,
					steps: [{ ...planning.plan.steps[0], note: "Groups cannot carry execution notes" }],
				},
			}),
		).toBe(false);
		expect(validator.Check({ ...planning, unexpected: true })).toBe(false);
	});
});
