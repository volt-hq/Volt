/**
 * The session's Plan/Build state machine ({@link SessionPlanning}): the plan
 * state the runtime follows (each committed planning snapshot), transitions
 * run one at a time, the plan checkpoint a draft or active plan delivers to
 * the model, and the ready-plan step a user delivery takes: the first
 * user-bearing delivery while a plan is ready returns it to draft in the
 * delivery's own batch. Also the runtime-only Plan research evidence the
 * `submit_plan` gate reads.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentTool,
	Conversation,
	ConversationDelivery,
	ConversationPreparedDelivery,
} from "@hansjm10/volt-agent-core";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { BackgroundJobManager } from "../background-jobs.ts";
import type { CustomMessage } from "../messages.ts";
import { type OperationGrantProfile, RESEARCH_OPERATION_GRANT_PROFILE } from "../operation-authorization.ts";
import {
	type AgentMode,
	assertPlanRevision,
	branchPlanningState,
	clonePlanningState,
	clonePlanState,
	derivePlanStepStatus,
	formatPlanCheckpoint,
	getPlanLeafSteps,
	PLAN_CHECKPOINT_CUSTOM_TYPE,
	type PlanExecution,
	type PlanItem,
	type PlanningState,
	type PlanState,
	type PlanStepStatus,
	parsePlanningState,
} from "../planning.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import { canonicalizePlanSteps, type PlanStepInput, planStepsSemanticallyEqual } from "../tools/planning.ts";
import type { SessionClientInputs } from "./client-inputs.ts";
import type { SessionToolRuntime } from "./tool-runtime.ts";

export interface SessionPlanningHost {
	readonly sessionManager: SessionManager;
	readonly backgroundJobs: BackgroundJobManager;
	conversation(): Conversation<AgentTool>;
	sessionWriter(): SessionWriter;
	tools(): SessionToolRuntime;
	clientInputs(): SessionClientInputs;
	isDisposed(): boolean;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** Rejects once the session is disposed. */
	assertNotDisposed(): void;
	/** A turn holds the conversation, a prompt's reservation included. */
	turnActive(): boolean;
	/** The branch generation: changes exactly when the active branch switches. */
	generation(): number;
	/** Whether the session is a review finding discussion. */
	isReviewDiscussion(): boolean;
	/** Track work that must settle before the session's resources close. */
	trackAncillaryWork<T>(work: Promise<T>): Promise<T>;
	emit(event: AgentSessionEvent): void;
}

export class SessionPlanning {
	private readonly host: SessionPlanningHost;
	private state: PlanningState;
	private transitionQueue: Promise<void> = Promise.resolve();
	private transitionInFlight = false;
	/** Conversation generation whose successful read currently satisfies the Plan research gate. */
	private researchGeneration: number | undefined;
	/** The ready plan a delivery claimed for its transition to draft, and the input that owns the claim. */
	private readyPlanClaim: { planKey: string; owner: string | undefined } | undefined;

	constructor(host: SessionPlanningHost) {
		this.host = host;
		this.state = branchPlanningState(host.sessionManager.getConversationState().planning);
	}

	/** The plan state the runtime follows: the active branch's committed planning snapshot. */
	get current(): PlanningState {
		return this.state;
	}

	get mode(): AgentMode {
		this.host.assertNotDisposed();
		return this.state.mode;
	}

	get planningState(): PlanningState {
		this.host.assertNotDisposed();
		return branchPlanningState(this.host.sessionManager.getConversationState().planning);
	}

	/** The capability profile Plan mode restricts tools to, or undefined in Build mode. */
	operationGrantProfile(): OperationGrantProfile | undefined {
		return this.state.mode === "plan" ? RESEARCH_OPERATION_GRANT_PROFILE : undefined;
	}

	/** Whether a successful read in the current branch generation satisfies the Plan research gate. */
	hasResearch(): boolean {
		return this.researchGeneration === this.host.generation();
	}

	/** A successful read satisfied the Plan research gate in the current branch generation. */
	recordResearch(): void {
		this.researchGeneration = this.host.generation();
	}

	/** Research evidence belongs to the branch it was gathered on. */
	clearResearch(): void {
		this.researchGeneration = undefined;
	}

	/**
	 * The active branch moved: the runtime follows its plan state, and
	 * observers learn a changed one.
	 */
	restoreFromBranch(): void {
		const previousPlanningState = clonePlanningState(this.state);
		this.state = branchPlanningState(this.host.sessionManager.getConversationState().planning);
		this.host.tools().syncPlanningRuntime();
		if (JSON.stringify(previousPlanningState) !== JSON.stringify(this.state)) {
			this.host.emit({ type: "planning_state_changed", planning: this.planningState });
		}
	}

	/**
	 * The first user-bearing delivery while a plan is ready returns the plan to
	 * draft: its planning snapshot and checkpoint commit in the delivery's batch.
	 */
	prepareDelivery(delivery: ConversationDelivery): ConversationPreparedDelivery | undefined {
		if (!delivery.messages.some((message) => message.role === "user")) return undefined;
		const readyPlan = this.state.plan;
		if (readyPlan?.phase !== "ready") return undefined;
		const planKey = `${readyPlan.id}:${readyPlan.revision}`;
		const owner = delivery.clientMessageId;
		const claim = this.readyPlanClaim;
		if (claim?.planKey === planKey && claim.owner !== owner && this.readyPlanClaimLive(claim.owner)) {
			return undefined;
		}
		this.readyPlanClaim = { planKey, owner };
		const nextPlanningState = parsePlanningState({
			mode: "plan",
			plan: { ...readyPlan, revision: readyPlan.revision + 1, phase: "draft" },
		});
		const checkpoint = this.createCheckpointMessage(nextPlanningState);
		return {
			messages: checkpoint ? [checkpoint, ...delivery.messages] : [...delivery.messages],
			entries: [{ type: "planning_state_change", payload: { planning: nextPlanningState } }],
		};
	}

	/** Whether the input that claimed a ready-plan transition may still deliver it. */
	private readyPlanClaimLive(owner: string | undefined): boolean {
		if (owner === undefined) return true;
		const state = this.host.conversation().state.clientInputs.inputs.get(owner)?.state;
		return state === "accepted" || state === "started";
	}

	/** A planning snapshot committed: it becomes the runtime's plan state. */
	onCommitted(planning: PlanningState): void {
		if (this.host.isDisposed() || isDeepStrictEqual(planning, this.state)) return;
		if (this.state.mode !== "plan" || this.researchGeneration !== this.host.generation()) {
			this.researchGeneration = undefined;
		}
		this.state = clonePlanningState(planning);
		this.host.tools().syncPlanningRuntime();
		this.host.emit({ type: "planning_state_changed", planning: clonePlanningState(this.state) });
	}

	private needsCheckpoint(state: PlanningState): boolean {
		return state.plan !== null && (state.mode === "plan" || state.plan.phase === "active");
	}

	/** The plan checkpoint the model sees for a planning state, or undefined when it needs none. */
	createCheckpointMessage(state: PlanningState): CustomMessage | undefined {
		if (!this.needsCheckpoint(state)) return undefined;
		const content = formatPlanCheckpoint(state);
		if (!content) return undefined;
		return {
			role: "custom",
			customType: PLAN_CHECKPOINT_CUSTOM_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		};
	}

	private async deliverCheckpoint(state: PlanningState): Promise<void> {
		const message = this.createCheckpointMessage(state);
		if (!message) return;
		if (this.host.turnActive()) {
			await this.host.clientInputs().trackQueueAdmission(this.host.conversation().queueMessages("steer", [message]));
			return;
		}
		await this.host
			.sessionWriter()
			.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		this.host.emit({ type: "message_start", message });
		this.host.emit({ type: "message_end", message });
	}

	/**
	 * Commit a Plan mode snapshot. Runs inside a planning transition; the
	 * committed snapshot becomes the runtime's plan state and is published as
	 * it commits.
	 */
	private async commit(next: PlanningState): Promise<PlanningState> {
		this.host.assertActive();
		const parsed = parsePlanningState(next);
		if (parsed.mode === "plan" && this.host.backgroundJobs.hasActive) {
			throw new Error("Cannot enter Plan mode while background jobs are active; abort or wait for them to finish");
		}
		await this.host.sessionWriter().appendPlanningState(parsed);
		this.host.assertActive();
		return clonePlanningState(this.state);
	}

	private draftFromExecutedPlan(plan: PlanState): PlanState {
		const cloned = clonePlanState(plan);
		return {
			id: cloned.id,
			revision: cloned.revision + 1,
			phase: "draft",
			...(cloned.title ? { title: cloned.title } : {}),
			...(cloned.summary ? { summary: cloned.summary } : {}),
			steps: cloned.steps,
		};
	}

	/**
	 * Planning transitions run one at a time. They may suspend at an await (MCP
	 * restoration, the planning commit) while the event loop keeps running, so
	 * they re-validate planning state after every await before committing, and
	 * a plan mutation called while one is suspended mid-flight is refused.
	 */
	private enqueue<T>(transition: () => Promise<T>): Promise<T> {
		this.host.assertActive();
		const result = this.transitionQueue.then(async () => {
			this.host.assertActive();
			this.transitionInFlight = true;
			try {
				return await transition();
			} finally {
				this.transitionInFlight = false;
			}
		});
		const tracked = this.host.trackAncillaryWork(result);
		this.transitionQueue = tracked.then(
			() => undefined,
			() => undefined,
		);
		return tracked;
	}

	private assertNoTransitionInFlight(action: string): void {
		this.host.assertActive();
		if (this.transitionInFlight) {
			throw new Error(`${action} is unavailable while a planning transition is in progress; retry once it settles`);
		}
	}

	setAgentMode(mode: AgentMode): Promise<PlanningState> {
		return this.enqueue(() => this.applyAgentMode(mode));
	}

	private async applyAgentMode(mode: AgentMode): Promise<PlanningState> {
		if (mode === "build" && this.state.mode === "plan") {
			await this.host.tools().prepareUnrestrictedMcpForBuild();
		}
		if (mode === this.state.mode) {
			return this.planningState;
		}
		const plan = this.state.plan;
		if (mode === "plan") {
			this.researchGeneration = undefined;
		}
		if (mode === "plan" && plan?.phase === "active") {
			const next = await this.commit({ mode, plan: this.draftFromExecutedPlan(plan) });
			await this.deliverCheckpoint(next);
			return next;
		}
		if (mode === "plan" && (plan?.phase === "completed" || plan?.phase === "handed_off")) {
			return this.commit({ mode, plan: null });
		}
		const next = await this.commit({ ...clonePlanningState(this.state), mode });
		if (mode === "plan" && next.plan?.phase === "draft") {
			await this.deliverCheckpoint(next);
		}
		return next;
	}

	toggleAgentMode(): Promise<PlanningState> {
		return this.enqueue(() => this.applyAgentMode(this.mode === "plan" ? "build" : "plan"));
	}

	/** Commit a draft plan update; resolves after the new revision commits. */
	async updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: PlanStepInput[];
	}): Promise<PlanState> {
		this.assertNoTransitionInFlight("update_plan");
		return this.enqueue(() => this.applyPlanUpdate(input));
	}

	private async applyPlanUpdate(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: PlanStepInput[];
	}): Promise<PlanState> {
		if (this.state.mode !== "plan") {
			throw new Error("update_plan is available only in Plan mode");
		}
		const previous = this.state.plan;
		if (previous) {
			if (previous.phase !== "draft") {
				throw new Error("Only a draft plan can be updated");
			}
			if (input.planId === undefined || input.expectedRevision === undefined) {
				throw new Error("Updating an existing plan requires planId and expectedRevision");
			}
			assertPlanRevision(this.state, input.planId, input.expectedRevision);
		} else if (input.planId !== undefined || input.expectedRevision !== undefined) {
			throw new Error("A new plan must not provide planId or expectedRevision");
		}
		const title = input.title?.trim() || previous?.title;
		const summary = input.summary?.trim() || previous?.summary;
		const steps = canonicalizePlanSteps(input.steps, previous ?? undefined);
		if (
			previous &&
			previous.title === title &&
			previous.summary === summary &&
			// Ids are deliberately ignored: identical content and progress in the
			// same hierarchy is the same checklist, so id-less resends cannot churn.
			planStepsSemanticallyEqual(previous.steps, steps)
		) {
			throw new Error("Plan update made no changes; continue research or submit the current draft");
		}
		const plan: PlanState = {
			id: previous?.id ?? randomUUID(),
			revision: (previous?.revision ?? 0) + 1,
			phase: "draft",
			...(title ? { title } : {}),
			...(summary ? { summary } : {}),
			steps,
		};
		await this.commit({ mode: "plan", plan });
		return clonePlanState(plan);
	}

	/** Commit approved plan progress; resolves after the new revision commits. */
	async updatePlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): Promise<PlanState> {
		this.assertNoTransitionInFlight("update_plan_progress");
		return this.enqueue(() => this.applyPlanProgress(input));
	}

	private async applyPlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): Promise<PlanState> {
		if (this.state.mode !== "build" || this.state.plan?.phase !== "active") {
			throw new Error("update_plan_progress is available only during approved plan execution");
		}
		assertPlanRevision(this.state, input.planId, input.expectedRevision);
		if (input.updates.length === 0) {
			throw new Error("At least one plan progress update is required");
		}
		const updates = new Map<string, { status: PlanStepStatus; note?: string }>();
		const executableIds = new Set(getPlanLeafSteps(this.state.plan).map((step) => step.id));
		const groupIds = new Set(
			this.state.plan.steps.filter((step) => step.substeps !== undefined).map((step) => step.id),
		);
		for (const update of input.updates) {
			const id = update.id.trim();
			if (groupIds.has(id)) {
				throw new Error(`Plan progress cannot update group outcome id: ${id}`);
			}
			if (!id || !executableIds.has(id)) {
				throw new Error(`Plan progress references an unknown executable leaf id: ${update.id}`);
			}
			if (updates.has(id)) {
				throw new Error(`Plan progress duplicates executable leaf id: ${id}`);
			}
			updates.set(id, {
				status: update.status,
				...(update.note === undefined ? {} : { note: update.note }),
			});
		}
		const applyUpdate = (step: PlanItem): PlanItem => {
			const update = updates.get(step.id);
			if (!update) return { ...step };
			const note = update.note === undefined ? step.note : update.note.trim() || undefined;
			return {
				id: step.id,
				text: step.text,
				status: update.status,
				...(note ? { note } : {}),
			};
		};
		const steps: PlanState["steps"] = this.state.plan.steps.map((step) => {
			if (!step.substeps) return applyUpdate(step);
			const substeps = step.substeps.map(applyUpdate);
			return { id: step.id, text: step.text, status: derivePlanStepStatus(substeps), substeps };
		});
		if (planStepsSemanticallyEqual(this.state.plan.steps, steps)) {
			throw new Error("Plan progress update made no changes");
		}
		const plan: PlanState = {
			...this.state.plan,
			revision: this.state.plan.revision + 1,
			phase: getPlanLeafSteps({ steps }).every((step) => step.status === "completed") ? "completed" : "active",
			steps,
		};
		await this.commit({ mode: "build", plan });
		return clonePlanState(plan);
	}

	/** Return approved execution to a draft; resolves after the draft commits. */
	async requestReplan(input: { planId: string; expectedRevision: number; reason: string }): Promise<PlanningState> {
		this.assertNoTransitionInFlight("request_replan");
		return this.enqueue(async () => this.applyReplan(input));
	}

	private async applyReplan(input: {
		planId: string;
		expectedRevision: number;
		reason: string;
	}): Promise<PlanningState> {
		if (this.state.mode !== "build" || this.state.plan?.phase !== "active") {
			throw new Error("request_replan is available only during approved plan execution");
		}
		assertPlanRevision(this.state, input.planId, input.expectedRevision);
		if (!input.reason.trim()) {
			throw new Error("request_replan requires implementation evidence");
		}
		this.researchGeneration = undefined;
		return this.commit({
			mode: "plan",
			plan: this.draftFromExecutedPlan(this.state.plan),
		});
	}

	/** Submit a draft plan for approval; resolves after the ready plan commits. */
	async submitPlan(input: {
		planId: string;
		expectedRevision: number;
		title: string;
		summary: string;
	}): Promise<PlanState> {
		this.assertNoTransitionInFlight("submit_plan");
		return this.enqueue(() => this.applySubmit(input));
	}

	private async applySubmit(input: {
		planId: string;
		expectedRevision: number;
		title: string;
		summary: string;
	}): Promise<PlanState> {
		if (this.state.mode !== "plan") {
			throw new Error("submit_plan is available only in Plan mode");
		}
		assertPlanRevision(this.state, input.planId, input.expectedRevision);
		if (this.state.plan.phase !== "draft") {
			throw new Error("Only a draft plan can be submitted");
		}
		if (this.state.plan.steps.length === 0) {
			throw new Error("A plan must contain at least one checklist step");
		}
		if (!input.title.trim() || !input.summary.trim()) {
			throw new Error("A submitted plan requires a non-empty title and summary");
		}
		const plan: PlanState = {
			...this.state.plan,
			revision: this.state.plan.revision + 1,
			phase: "ready",
			title: input.title.trim(),
			summary: input.summary.trim(),
		};
		await this.commit({ mode: "plan", plan });
		return clonePlanState(plan);
	}

	/** Return a ready plan to a draft; resolves after the draft commits. */
	async changePlan(planId: string, expectedRevision: number): Promise<PlanningState> {
		this.assertNoTransitionInFlight("changePlan");
		return this.enqueue(() => this.changeReadyPlanToDraft(planId, expectedRevision, true));
	}

	private async changeReadyPlanToDraft(
		planId: string,
		expectedRevision: number,
		deliverCheckpoint: boolean,
	): Promise<PlanningState> {
		assertPlanRevision(this.state, planId, expectedRevision);
		if (this.state.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be changed");
		}
		// Only same-generation Plan feedback can reuse the successful read that
		// supported the ready plan. Build entry and branch navigation fail closed.
		if (this.state.mode !== "plan" || this.researchGeneration !== this.host.generation()) {
			this.researchGeneration = undefined;
		}
		const next = await this.commit({
			mode: "plan",
			plan: {
				...this.state.plan,
				revision: this.state.plan.revision + 1,
				phase: "draft",
			},
		});
		if (deliverCheckpoint) {
			await this.deliverCheckpoint(next);
		}
		return next;
	}

	/** Discard the plan; resolves after the cleared planning state commits. */
	async discardPlan(planId: string, expectedRevision: number): Promise<PlanningState> {
		this.assertNoTransitionInFlight("discardPlan");
		return this.enqueue(async () => {
			assertPlanRevision(this.state, planId, expectedRevision);
			this.researchGeneration = undefined;
			return this.commit({ mode: this.state.mode, plan: null });
		});
	}

	activatePlan(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		return this.enqueue(() => this.applyActivation(planId, expectedRevision, execution));
	}

	private async applyActivation(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		if (this.host.isReviewDiscussion() && execution.strategy !== "retain_context") {
			throw new Error("Finding discussions execute plans in the current context; reset through the source review");
		}
		let currentPlan = this.state.plan;
		if (
			currentPlan?.id === planId &&
			currentPlan.execution?.approvedRevision === expectedRevision &&
			currentPlan.execution.strategy === execution.strategy
		) {
			return { planning: this.planningState, activated: false };
		}
		assertPlanRevision(this.state, planId, expectedRevision);
		if (this.state.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		if (this.state.mode === "plan") {
			await this.host.tools().prepareUnrestrictedMcpForBuild();
		}
		currentPlan = this.state.plan;
		if (
			currentPlan?.id === planId &&
			currentPlan.execution?.approvedRevision === expectedRevision &&
			currentPlan.execution.strategy === execution.strategy
		) {
			return { planning: this.planningState, activated: false };
		}
		assertPlanRevision(this.state, planId, expectedRevision);
		if (this.state.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		return {
			planning: await this.commit({
				mode: "build",
				plan: {
					...this.state.plan,
					revision: this.state.plan.revision + 1,
					phase: "active",
					execution,
				},
			}),
			activated: true,
		};
	}

	markPlanHandedOff(planId: string, expectedRevision: number, execution: PlanExecution): Promise<PlanningState> {
		return this.enqueue(() => this.applyHandoff(planId, expectedRevision, execution));
	}

	private async applyHandoff(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<PlanningState> {
		if (this.host.isReviewDiscussion()) {
			throw new Error(
				"Finding discussions cannot hand off their source-linked identity; execute in the current context",
			);
		}
		assertPlanRevision(this.state, planId, expectedRevision);
		if (this.state.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be handed off");
		}
		if (this.state.mode === "plan") {
			await this.host.tools().prepareUnrestrictedMcpForBuild();
			assertPlanRevision(this.state, planId, expectedRevision);
			if (this.state.plan.phase !== "ready") {
				throw new Error("Only a ready plan can be handed off");
			}
		}
		return this.commit({
			mode: "build",
			plan: {
				...this.state.plan,
				revision: this.state.plan.revision + 1,
				phase: "handed_off",
				execution,
			},
		});
	}
}
