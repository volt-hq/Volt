import { Type } from "typebox";
import { stringEnum } from "./helpers.ts";

export type AgentMode = "build" | "plan";
export type PlanPhase = "draft" | "ready" | "active" | "completed" | "handed_off";
export type PlanStepStatus = "pending" | "in_progress" | "completed";
export type PlanExecutionStrategy = "retain_context" | "new_session";

export interface PlanItem {
	id: string;
	text: string;
	status: PlanStepStatus;
	note?: string;
}

export type PlanSubstep = PlanItem;

export interface PlanStep extends PlanItem {
	/** Optional executable children. Group status is derived from these leaves. */
	substeps?: PlanSubstep[];
}

export interface PlanExecution {
	id: string;
	approvedRevision: number;
	strategy: PlanExecutionStrategy;
	sourceSessionId: string;
	targetSessionId: string;
}

export interface PlanState {
	id: string;
	revision: number;
	phase: PlanPhase;
	title?: string;
	summary?: string;
	steps: PlanStep[];
	execution?: PlanExecution;
}

/** Complete branch-local Plan mode snapshot. */
export interface PlanningState {
	mode: AgentMode;
	plan: PlanState | null;
}

export const RpcAgentModeSchema = stringEnum(["build", "plan"]);
export const RpcPlanStepStatusSchema = stringEnum(["pending", "in_progress", "completed"]);
export const RpcPlanExecutionStrategySchema = stringEnum(["retain_context", "new_session"]);

export const RpcPlanSubstepSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		text: Type.String({ minLength: 1 }),
		status: RpcPlanStepStatusSchema,
		note: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcPlanStepSchema = Type.Union([
	RpcPlanSubstepSchema,
	Type.Object(
		{
			id: Type.String({ minLength: 1 }),
			text: Type.String({ minLength: 1 }),
			status: RpcPlanStepStatusSchema,
			substeps: Type.Array(RpcPlanSubstepSchema, { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export const RpcPlanExecutionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		approvedRevision: Type.Integer({ minimum: 0 }),
		strategy: RpcPlanExecutionStrategySchema,
		sourceSessionId: Type.String({ minLength: 1 }),
		targetSessionId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const rpcPlanStateFields = {
	id: Type.String({ minLength: 1 }),
	revision: Type.Integer({ minimum: 0 }),
	title: Type.Optional(Type.String({ minLength: 1 })),
	summary: Type.Optional(Type.String({ minLength: 1 })),
	steps: Type.Array(RpcPlanStepSchema),
};

export const RpcPlanStateSchema = Type.Unsafe<PlanState>(
	Type.Union([
		Type.Object(
			{
				...rpcPlanStateFields,
				phase: stringEnum(["draft", "ready"]),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				...rpcPlanStateFields,
				phase: stringEnum(["active", "completed", "handed_off"]),
				execution: RpcPlanExecutionSchema,
			},
			{ additionalProperties: false },
		),
	]),
);

export const RpcPlanningStateSchema = Type.Object(
	{
		mode: RpcAgentModeSchema,
		plan: Type.Union([RpcPlanStateSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);
