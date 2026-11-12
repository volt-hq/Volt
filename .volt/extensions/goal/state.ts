import { randomUUID } from "node:crypto";
import { StringEnum } from "@hansjm10/volt-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const STATE_ENTRY = "volt-goal.state";

export const TaskProposalSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 500 }),
		requirement: Type.String({ maxLength: 2000 }),
	},
	{ additionalProperties: false },
);
export const ProposalSchema = Type.Object(
	{
		objective: Type.String({ minLength: 1, maxLength: 8000 }),
		requirements: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 30 }),
		tasks: Type.Array(TaskProposalSchema, { maxItems: 50 }),
	},
	{ additionalProperties: false },
);
export type Proposal = Static<typeof ProposalSchema>;
export type GoalMode = "regular" | "ordered";

const TaskSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	requirement: Type.String(),
	status: StringEnum(["pending", "active", "complete", "skipped"] as const),
	evidence: Type.String(),
});
const AuditSchema = Type.Object({
	verdict: StringEnum(["approved", "rejected", "error"] as const),
	report: Type.String(),
	model: Type.String(),
});
const GoalSchema = Type.Object({
	id: Type.String(),
	objective: Type.String(),
	mode: StringEnum(["regular", "ordered"] as const),
	status: StringEnum(["active", "paused", "blocked", "auditing", "complete"] as const),
	requirements: Type.Array(Type.String()),
	tasks: Type.Array(TaskSchema),
	note: Type.String(),
	audit: Type.Union([AuditSchema, Type.Null()]),
});
export const StateSchema = Type.Object({
	version: Type.Literal(1),
	revision: Type.Integer({ minimum: 0 }),
	goal: Type.Union([GoalSchema, Type.Null()]),
	draft: Type.Union([
		Type.Object({ mode: StringEnum(["regular", "ordered"] as const), request: Type.String(), revise: Type.Boolean() }),
		Type.Null(),
	]),
});
export type Goal = Static<typeof GoalSchema>;
export type GoalTask = Static<typeof TaskSchema>;
export type Audit = Static<typeof AuditSchema>;
export type GoalState = Static<typeof StateSchema>;

export function emptyState(): GoalState {
	return { version: 1, revision: 0, goal: null, draft: null };
}

export function restoreState(entries: readonly { type: string; customType?: string; data?: unknown }[]): GoalState {
	const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
	if (!entry) return emptyState();
	if (!Check(StateSchema, entry.data)) throw new Error("The saved goal state is invalid; no goal was resumed.");
	return structuredClone(entry.data);
}

export function createGoal(proposal: Proposal, mode: GoalMode): Goal {
	if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > 16_000) {
		throw new Error("Keep the proposal below 16 KB so the full goal fits in the approval dialog.");
	}
	if (!proposal.objective.trim()) throw new Error("A goal needs a nonempty objective.");
	if (mode === "ordered" && proposal.tasks.length === 0) throw new Error("An ordered goal needs at least one step.");
	if (proposal.tasks.some((task) => !task.title.trim())) throw new Error("Tasks need nonempty titles.");
	return {
		id: randomUUID(),
		objective: proposal.objective.trim(),
		mode,
		status: "active",
		requirements: proposal.requirements.map((requirement) => requirement.trim()).filter(Boolean),
		tasks: proposal.tasks.map((task, index) => ({
			id: String(index + 1),
			title: task.title.trim(),
			requirement: task.requirement.trim(),
			status: "pending",
			evidence: "",
		})),
		note: "",
		audit: null,
	};
}

export function updateTask(goal: Goal, id: string, status: GoalTask["status"], evidence: string): Goal {
	if (goal.status !== "active") throw new Error("Resume the goal before updating tasks.");
	const index = goal.tasks.findIndex((task) => task.id === id);
	if (index < 0) throw new Error(`Unknown goal task: ${id}`);
	if ((status === "complete" || status === "skipped") && !evidence.trim()) {
		throw new Error(status === "complete" ? "Record completion evidence." : "Explain why the task is skipped.");
	}
	if (goal.mode === "ordered" && status !== "pending") {
		if (status === "skipped") throw new Error("Ordered steps cannot be skipped; use /goal-tweak to revise the plan.");
		if (goal.tasks.slice(0, index).some((task) => task.status !== "complete")) {
			throw new Error("Complete preceding ordered steps first.");
		}
	}
	const tasks = goal.tasks.map((task, taskIndex) => {
		if (taskIndex === index) return { ...task, status, evidence: evidence.trim() };
		// Reopening an ordered step also invalidates the completion of later steps.
		if (goal.mode === "ordered" && (status === "pending" || status === "active") && taskIndex > index) {
			return { ...task, status: "pending" as const, evidence: "" };
		}
		return status === "active" && task.status === "active" ? { ...task, status: "pending" as const } : task;
	});
	return { ...goal, tasks, audit: null };
}

export function assertCompletable(goal: Goal): void {
	if (goal.status !== "active") throw new Error("Resume the goal before requesting completion.");
	if (goal.tasks.some((task) => task.status !== "complete" && task.status !== "skipped")) {
		throw new Error("Finish the remaining tasks before requesting completion.");
	}
}

export function goalSummary(goal: Goal): string {
	return [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}; mode: ${goal.mode}`,
		...(goal.requirements.length ? ["Completion requirements:", ...goal.requirements.map((item) => `- ${item}`)] : []),
		...goal.tasks.map((task) =>
			[
				`${task.id}. [${task.status}] ${task.title}`,
				...(task.requirement ? [`   Required: ${task.requirement}`] : []),
				...(task.evidence ? [`   Evidence/reason: ${task.evidence}`] : []),
			].join("\n"),
		),
		...(goal.note ? [`Note: ${goal.note}`] : []),
		...(goal.audit ? [`Last audit (${goal.audit.verdict}, ${goal.audit.model}):\n${goal.audit.report}`] : []),
	].join("\n");
}
