/** Opt-in Ahead of Model Work experiment. See README.md for the expanded data export and budgets. */
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionWorkContribution,
	ExtensionWorkStatus,
	ExtensionWorkTaskHandle,
	JsonValue,
} from "@hansjm10/volt-coding-agent";
import { AHEAD_AUDIT_TYPE, type AheadAudit, type AheadEvaluationAudit, auditText } from "./audit.ts";
import { evaluateAhead, type JevResult, type JevTransportOptions } from "./client.ts";
import { MAX_AHEAD_CYCLES, MAX_AHEAD_EVALUATIONS, MAX_AHEAD_NATIVE_OPERATIONS } from "./limits.ts";
import {
	type AheadCycle,
	type AheadPath,
	type AheadRead,
	type AheadStage,
	type AheadState,
	alreadyRead,
	boundedText,
	foregroundReadRange,
	observedPaths,
	PATH_PRIORITY,
	prepareAhead,
	workspacePath,
} from "./pipeline.ts";
import { AheadResources } from "./resources.ts";

const FLAG = "jev-ahead-of-model";

export interface AheadReport {
	cycles: AheadCycle[];
	evaluations: Array<{ cycle: number; stage: AheadStage; attempt: number; questions: number; result: JevResult }>;
	boundaries: Array<{
		attemptId: string;
		cause: string;
		waitMs: number;
		observation?: {
			at: string;
			observedAt: string;
			cycle?: number;
			evaluations: number;
			contributions: ExtensionWorkStatus["contributions"];
		};
	}>;
	coalescedToolResults: number;
	duplicateToolResults: number;
	native: {
		preparation: number;
		validationReservations: number;
		cacheHits: number;
		remaining: number;
		blockedReason?: string;
	};
	retired: Array<{ key: string; candidate: string; at: string; reason: "foreground_read" | "offer_limit" }>;
	status: string;
}

export interface AheadOptions extends JevTransportOptions {
	/** Explicit consent to export bounded recent conversation, tool text, source and skill excerpts. False prohibits enabling. */
	enabled?: boolean;
	/** Runtime diagnostics only; no prompt or source bodies. Exceptions and rejected promises are contained. */
	onReport?: (report: AheadReport) => void;
}

interface Scope {
	id: string;
	ctx: ExtensionContext;
	report: AheadReport;
	tools: AheadState["tools"];
	paths: AheadPath[];
	reads: AheadRead[];
	offered: AheadRead[];
	offerCounts: Map<AheadCycle["publications"][number], number>;
	expired: Set<AheadCycle["publications"][number]>;
	resources: AheadResources;
	resourceSignature: string;
	mutatingTools: Set<string>;
	toolInputs: Map<string, { path?: string; searchRoot?: string; offset: number; limit?: number; query?: string }>;
	seenTools: Set<string>;
	activePublications: Map<string, AheadCycle["publications"][number]>;
	pending: boolean;
	turnReady: boolean;
	stopped: boolean;
	startedAt: string;
	auditState: "collecting" | "appended" | "failed";
	auditEvaluations: AheadEvaluationAudit[];
	auditPublications: AheadAudit["publications"];
	publishedCycle?: number;
	handle?: ExtensionWorkTaskHandle;
	projection?: { cutoff: number; promise: Promise<void>; release: () => void };
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: unknown) =>
			part !== null &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}

function taskState(scope: Scope): AheadState {
	const snapshot = scope.ctx.work!.snapshot;
	const rawRequest = snapshot.inputs.map((input) => input.text).join("\n");
	const request = boundedText(rawRequest, 8192);
	const window = scope.ctx.sessionManager.getBranchWindow({ maxEntries: 16 });
	const recent: AheadState["recent"] = [];
	let remaining = 8192;
	let truncated = (window?.hasEarlier ?? true) || request.length !== rawRequest.length;
	for (const entry of [...(window?.entries ?? [])].reverse()) {
		if (entry.type === "compaction") break;
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant" && entry.message.role !== "toolResult")
			continue;
		const raw = textContent(entry.message.content);
		if (!raw) continue;
		if (entry.message.role === "toolResult" && scope.tools.some((tool) => tool.text === boundedText(raw, 2048)))
			continue;
		const text = boundedText(raw, Math.min(remaining, 2048));
		truncated ||= text.length !== raw.length;
		recent.unshift({ role: entry.message.role, text });
		remaining -= Buffer.byteLength(text);
		if (recent.length === 8 || remaining === 0) {
			truncated = true;
			break;
		}
	}
	return {
		request,
		recent,
		tools: structuredClone(scope.tools),
		paths: structuredClone(scope.paths),
		reads: structuredClone(scope.reads),
		offered: structuredClone(scope.offered),
		truncated,
	};
}

export function createJevAheadOfModel(options: AheadOptions = {}): ExtensionFactory {
	return (volt: ExtensionAPI) => {
		let enabled: boolean | undefined;
		let generation = 0;
		let commandOpen = false;
		let scope: Scope | undefined;
		const isEnabled = () => options.enabled !== false && (enabled ?? options.enabled ?? volt.getFlag(FLAG) === true);

		function observe(current: Scope): void {
			if (scope !== current) return;
			current.report.native = {
				preparation: current.resources.operations,
				validationReservations: current.resources.validationReservations,
				cacheHits: current.resources.cacheHits,
				remaining: current.resources.remaining,
				blockedReason: current.resources.blockedReason,
			};
			try {
				void Promise.resolve(options.onReport?.(structuredClone(current.report))).catch(() => {});
			} catch {
				/* Diagnostics never control preparation. */
			}
		}

		function status(ctx: ExtensionContext): void {
			if (ctx.mode === "tui")
				ctx.ui.setStatus(
					FLAG,
					isEnabled()
						? `Ahead: ${scope?.report.status ?? "on"} · ${scope?.report.evaluations.length ?? 0} Jev calls`
						: "Ahead: off",
				);
		}

		function stop(reason?: AheadAudit["reason"]): void {
			if (!scope) return;
			const current = scope;
			// Custom entries move the canonical cursor. Seal once, only outside request collection.
			// Never wait for an uncooperative transport or append its late results to another branch.
			if (reason && current.auditState === "collecting") {
				observe(current);
				current.auditState = "failed";
				try {
					const snapshot = current.ctx.work!.snapshot;
					const audit: AheadAudit = {
						requestId: current.id,
						sessionId: current.ctx.sessionManager.getSessionId(),
						branchId: snapshot.branchId,
						runtimeId: snapshot.runtimeId,
						startedAt: current.startedAt,
						sealedAt: new Date().toISOString(),
						reason,
						interrupted: current.handle !== undefined,
						evaluations: current.auditEvaluations,
						publications: current.auditPublications,
						report: current.report,
					};
					try {
						audit.finalContributions = volt.getWorkStatus().contributions;
					} catch {
						/* Host admission remains unobserved. */
					}
					// Drop undefined optional properties and detach the immutable audit from live callbacks.
					volt.appendEntry(AHEAD_AUDIT_TYPE, JSON.parse(JSON.stringify(audit)) as Record<string, JsonValue>);
					current.auditState = "appended";
				} catch {
					try {
						current.ctx.ui.notify("Ahead audit could not be appended to the session.", "warning");
					} catch {
						/* A failing diagnostic UI must not prevent task cancellation. */
					}
				}
			}
			scope.stopped = true;
			scope.pending = false;
			scope.projection?.release();
			scope.projection = undefined;
			scope.handle?.cancel();
		}

		function reset(ctx: ExtensionContext): void {
			stop();
			generation++;
			scope = undefined;
			enabled = undefined;
			status(ctx);
		}

		function reportText(): string {
			if (!scope) return "No Ahead of Model Work report. Enable with /ahead on, then submit a request.";
			const report = scope.report;
			const lines = [
				`Ahead of Model Work: ${report.status}`,
				`${report.cycles.length}/${MAX_AHEAD_CYCLES} preparation cycles; ${report.evaluations.length}/${MAX_AHEAD_EVALUATIONS} Jev evaluations; ${report.coalescedToolResults} tool results coalesced; ${report.duplicateToolResults} duplicates skipped; ${report.retired.length} excerpts retired.`,
				`Native work: ${report.native.preparation} preparation attempts; ${report.native.validationReservations} validation reservations; ${report.native.cacheHits} cache hits; ${report.native.remaining} preparation operations remaining${report.native.blockedReason ? ` (${report.native.blockedReason})` : ""}.`,
			];
			for (const cycle of report.cycles) {
				lines.push(
					`Cycle ${cycle.number}: ${cycle.trigger}; ${cycle.status}; task phase ${cycle.phase ?? "unclassified"}`,
				);
				for (const call of report.evaluations.filter((item) => item.cycle === cycle.number)) {
					const result = call.result;
					lines.push(
						`  ${call.stage}: attempt ${call.attempt}; ${call.questions} questions; ${result.status}${result.status === "ok" ? "" : ` (${result.reason})`}; ${Math.round(result.elapsedMs)} ms; HTTP ${result.httpStatus ?? "unobserved"}; input tokens ${result.inputTokens ?? "unknown"}; cost ${result.cost ?? "unknown"}`,
					);
					if (result.status === "ok")
						for (const [id, answer] of Object.entries(result.answers)) {
							lines.push(
								`    ${id}: ${answer.type === "boolean" ? answer.probability : answer.type === "score" ? answer.score.toFixed(2) : `${answer.choice}; ${JSON.stringify(answer.probabilities)}`}`,
							);
						}
				}
				for (const candidate of cycle.selection)
					lines.push(
						`  ${candidate.selected ? "read" : "omit"} ${JSON.stringify(candidate.candidate)}: ${candidate.score.toFixed(2)}`,
					);
				for (const operation of cycle.operations)
					lines.push(
						`  ${operation.service} ${JSON.stringify(operation.candidate)}: ${operation.status}${operation.cached ? " (cached)" : ""}${operation.reason ? ` (${operation.reason})` : ""}${operation.truncated ? " (partial)" : ""}`,
					);
				for (const publication of cycle.publications)
					lines.push(
						`  publish ${publication.key} ${JSON.stringify(publication.candidate)}: ${publication.status}`,
					);
			}
			for (const boundary of report.boundaries)
				lines.push(
					`Boundary ${boundary.cause}; wait ${boundary.waitMs} ms; ${
						boundary.observation
							? `${boundary.observation.at}: ${boundary.observation.evaluations} evaluations; ${boundary.observation.contributions.map((item) => `${item.key}=${item.status}${item.reason ? ` (${item.reason})` : ""}`).join(", ") || "no contributions"}`
							: "admission unobserved"
					}`,
				);
			lines.push(
				"Runtime-only report. Host admission observations are not final-payload receipts. Task usefulness and reasoning savings are unmeasured.",
				`Audit: ${scope.auditState}. Use /ahead history after the request ends.`,
			);
			return lines.join("\n");
		}

		function releaseProjection(at: string): void {
			if (!scope?.projection) return;
			const boundary = scope.report.boundaries.at(-1);
			try {
				const contributions = volt.getWorkStatus().contributions;
				// The host hides an extension's own operation events. Reserve one validation
				// per offered excerpt at each boundary, including omissions. This is an upper
				// bound, not a claim that every validation executed.
				scope.resources.validationReservations += contributions.length;
				for (const contribution of contributions) {
					if (contribution.status === "ready") continue;
					const item = scope.activePublications.get(contribution.key);
					if (!item) continue;
					const count = (scope.offerCounts.get(item) ?? 0) + 1;
					scope.offerCounts.set(item, count);
					if (count === 1) {
						scope.offered.push({
							path: item.candidate,
							startLine: item.startLine,
							endLine: item.reachesEnd ? Number.MAX_SAFE_INTEGER : item.endLine,
						});
					}
					if (count >= 2) scope.expired.add(item);
				}
				if (boundary)
					boundary.observation = {
						at,
						observedAt: new Date().toISOString(),
						cycle: scope.publishedCycle,
						evaluations: scope.report.evaluations.length,
						contributions,
					};
			} catch {
				/* Missing diagnostics remain unobserved. */
			}
			scope.projection.release();
			scope.projection = undefined;
			observe(scope);
		}

		function retire(
			current: Scope,
			items: AheadCycle["publications"],
			reason: AheadReport["retired"][number]["reason"],
		): Promise<unknown> | undefined {
			if (!items.length || current.stopped || !current.ctx.work) return;
			const admission = current.ctx.work.tasks.start(
				{ key: "ahead-retire", label: "Retire prepared evidence", timeoutMs: 1000 },
				async (task) => {
					for (const item of items) {
						// A newer cycle may have reused the same contribution key.
						if (current.activePublications.get(item.key) !== item) continue;
						task.context.remove(item.key);
						current.activePublications.delete(item.key);
						current.expired.delete(item);
						current.offerCounts.delete(item);
						current.report.retired.push({
							key: item.key,
							candidate: item.candidate,
							at: new Date().toISOString(),
							reason,
						});
					}
				},
			);
			return admission.status === "started" ? admission.task.wait() : undefined;
		}

		async function afterOutput(at: string): Promise<void> {
			releaseProjection(at);
			// Collection diagnostics precede provider dispatch. Removing a contribution there
			// would revoke its payload lease; wait until actual provider output instead.
			if (scope) await retire(scope, [...scope.expired], "offer_limit");
		}

		function start(current: Scope, trigger: AheadCycle["trigger"]): boolean {
			if (
				scope !== current ||
				current.stopped ||
				!isEnabled() ||
				!current.ctx.work ||
				current.ctx.work.snapshot.scopeId !== current.id
			)
				return false;
			if (current.handle) return false;
			if (current.resources.blockedReason || current.resources.remaining < 8) {
				current.pending = false;
				current.report.status = "native budget reached";
				return false;
			}
			const signature = JSON.stringify([current.ctx.work.snapshot.services, current.ctx.work.snapshot.skills]);
			if (signature !== current.resourceSignature) {
				current.resources.invalidate();
				current.offered = [];
				current.resourceSignature = signature;
			}
			if (
				current.report.cycles.length >= MAX_AHEAD_CYCLES ||
				current.auditEvaluations.length >= MAX_AHEAD_EVALUATIONS
			) {
				current.pending = false;
				current.report.status =
					current.auditEvaluations.length >= MAX_AHEAD_EVALUATIONS
						? "evaluation budget reached"
						: "cycle budget reached";
				return false;
			}
			const cycle: AheadCycle = {
				number: current.report.cycles.length + 1,
				trigger,
				status: "starting",
				operations: [],
				selection: [],
				publications: [],
			};
			const state = taskState(current);
			let retryAvailable = true;
			const admission = current.ctx.work.tasks.start(
				{ key: `ahead-${cycle.number}`, label: "Ahead of Model Work with Jev", timeoutMs: 12_000 },
				async (task) => {
					try {
						await prepareAhead(
							task,
							state,
							cycle,
							async (stage, input, questions) => {
								for (let attempt = 1; ; attempt++) {
									if (current.auditEvaluations.length >= MAX_AHEAD_EVALUATIONS)
										return { status: "unavailable", reason: "budget", elapsedMs: 0, requestBytes: 0 };
									const call: AheadEvaluationAudit = {
										cycle: cycle.number,
										stage,
										attempt,
										startedAt: new Date().toISOString(),
										questions: Object.keys(questions).length,
									};
									current.auditEvaluations.push(call);
									const result = await evaluateAhead(
										input,
										questions,
										() => current.ctx.modelRegistry.getApiKeyForProvider("vercel-ai-gateway"),
										task.signal,
										{
											...options,
											fetch: (url, init) => {
												call.dispatchedAt = new Date().toISOString();
												return (options.fetch ?? globalThis.fetch)(url, init);
											},
										},
										(body) => {
											call.requestBody = body;
										},
									);
									call.finishedAt = new Date().toISOString();
									call.result = result;
									current.report.evaluations.push({
										cycle: cycle.number,
										stage,
										attempt,
										questions: Object.keys(questions).length,
										result,
									});
									observe(current);
									if (
										!retryAvailable ||
										result.status !== "unavailable" ||
										result.reason !== "http" ||
										![502, 503, 504].includes(result.httpStatus ?? 0) ||
										current.auditEvaluations.length >= MAX_AHEAD_EVALUATIONS
									)
										return result;
									retryAvailable = false;
									await delay(500, undefined, { signal: task.signal });
								}
							},
							async (contributions: ExtensionWorkContribution[]) => {
								const publications: AheadAudit["publications"] = contributions.map((contribution) => ({
									cycle: cycle.number,
									contribution,
								}));
								current.auditPublications.push(...publications);
								// Never replace a packet while the host may be validating the prior version.
								while (
									current.projection &&
									performance.now() >= current.projection.cutoff &&
									!task.signal.aborted
								) {
									const projection = current.projection;
									const abort = () => projection.release();
									if (task.signal.aborted) break;
									task.signal.addEventListener("abort", abort, { once: true });
									try {
										await projection.promise;
									} finally {
										task.signal.removeEventListener("abort", abort);
									}
								}
								if (task.signal.aborted || scope !== current || current.stopped) return;
								if (!contributions.length) return;
								current.publishedCycle = cycle.number;
								for (let i = 0; i < 6; i++) task.context.remove(`ahead-${i}`);
								current.activePublications.clear();
								current.offerCounts.clear();
								current.expired.clear();
								for (const publication of publications) {
									const { contribution } = publication;
									const reported = cycle.publications.find((item) => item.key === contribution.key);
									if (
										reported &&
										alreadyRead(current.reads, reported.candidate, reported.startLine, reported.endLine)
									) {
										reported.status = "already read";
										publication.omittedReason = "foreground_read";
										continue;
									}
									const result = task.context.put(contribution);
									publication.result = result;
									publication.publishedAt = new Date().toISOString();
									if (reported) reported.status = result.status;
									if (reported && result.status === "accepted")
										current.activePublications.set(reported.key, reported);
								}
							},
							current.resources,
						);
						if (current.resources.blockedReason) cycle.status = "native budget reached";
					} catch {
						cycle.status = task.signal.aborted ? "cancelled" : "preparation failed";
					}
				},
			);
			if (admission.status !== "started") {
				current.report.status = `preparation ${admission.status}`;
				return false;
			}
			current.report.cycles.push(cycle);
			current.pending = false;
			current.turnReady = false;
			current.handle = admission.task;
			current.report.status = "preparing";
			status(current.ctx);
			// Registered in observer lineage, not inside a managed task. A pending foreground
			// observation can start the next bounded cycle after the preceding task drains.
			void admission.task
				.wait()
				.then(() => {
					current.handle = undefined;
					current.report.status = cycle.status;
					observe(current);
					if (scope !== current) return;
					status(current.ctx);
					if (current.pending && current.turnReady) start(current, "tools");
				})
				.catch(() => {});
			return true;
		}

		volt.registerFlag(FLAG, {
			type: "boolean",
			default: false,
			description:
				"Enable Jev Ahead of Model Work, exporting bounded conversation, tool text, source and skill excerpts",
		});
		volt.on("session_start", (_event, ctx) => reset(ctx));
		volt.on("session_tree", (_event, ctx) => reset(ctx));
		volt.on("session_shutdown", (_event, ctx) => {
			stop("session_shutdown");
			generation++;
			scope = undefined;
			if (ctx.mode === "tui") ctx.ui.setStatus(FLAG, undefined);
		});
		volt.on("before_agent_start", () => stop("superseded"));
		volt.on("agent_end", () => stop("agent_end"));
		volt.on("before_provider_request", () => releaseProjection("before_provider_request"));
		volt.on("after_provider_response", () => afterOutput("provider_response"));
		// Some SDK providers have no payload hook. Actual assistant output also proves
		// collection has finished, without creating or waiting for another model request.
		volt.on("message_update", (event) => {
			if (event.message.role === "assistant") return afterOutput("model_output");
		});
		volt.on("request_boundary", (event, ctx) => {
			if (!isEnabled() || !ctx.work) return;
			if (event.first) {
				stop();
				scope = {
					id: ctx.work.snapshot.scopeId,
					ctx,
					pending: false,
					turnReady: false,
					stopped: false,
					startedAt: new Date().toISOString(),
					auditState: "collecting",
					auditEvaluations: [],
					auditPublications: [],
					tools: [],
					paths: [],
					reads: [],
					offered: [],
					offerCounts: new Map(),
					expired: new Set(),
					resources: new AheadResources(),
					resourceSignature: "",
					mutatingTools: new Set(),
					toolInputs: new Map(),
					seenTools: new Set(),
					activePublications: new Map(),
					report: {
						cycles: [],
						evaluations: [],
						boundaries: [],
						coalescedToolResults: 0,
						duplicateToolResults: 0,
						native: {
							preparation: 0,
							validationReservations: 0,
							cacheHits: 0,
							remaining: MAX_AHEAD_NATIVE_OPERATIONS,
						},
						retired: [],
						status: "starting",
					},
				};
			}
			if (!scope || scope.stopped || scope.id !== ctx.work.snapshot.scopeId) return;
			scope.ctx = ctx;
			scope.turnReady = event.cause !== "retry" && scope.pending;
			scope.projection?.release();
			let release!: () => void;
			const promise = new Promise<void>((done) => {
				release = done;
			});
			const cutoff = performance.now() + (event.first ? event.waitAvailableMs : 0);
			scope.projection = { cutoff, promise, release };
			const boundary: AheadReport["boundaries"][number] = {
				attemptId: event.attemptId,
				cause: event.cause,
				waitMs: 0,
			};
			scope.report.boundaries.push(boundary);
			if (scope.report.boundaries.length > 64) scope.report.boundaries.shift();
			if (event.first && start(scope, "request")) boundary.waitMs = ctx.work.context.requestWait(1000);
			else if (event.cause !== "retry" && scope.pending && scope.turnReady) start(scope, "tools");
			observe(scope);
		});
		volt.on("tool_execution_start", (event, ctx) => {
			if (!isEnabled() || !scope || scope.stopped) return;
			if (
				!["read", "find", "grep"].includes(event.toolName) &&
				!(event.toolName === "lsp" && !["rename", "fix"].includes(String(event.args.action)))
			) {
				scope.resources.invalidate();
				scope.offered = [];
				scope.mutatingTools.add(event.toolCallId);
			}
			const path = typeof event.args.path === "string" ? workspacePath(ctx.cwd, event.args.path) : undefined;
			const directory = typeof event.args.path === "string" ? event.args.path : ".";
			const searchRoot = ["find", "grep"].includes(event.toolName)
				? path
					? dirname(path)
					: workspacePath(ctx.cwd, resolve(ctx.cwd, directory, "__ahead_path__.ts"))
				: undefined;
			if (!path && !searchRoot) return;
			scope.toolInputs.set(event.toolCallId, {
				path,
				searchRoot: searchRoot && !path ? dirname(searchRoot) : searchRoot,
				offset:
					typeof (event.args.offset ?? event.args.line) === "number" &&
					Number.isSafeInteger(event.args.offset ?? event.args.line) &&
					Number(event.args.offset ?? event.args.line) > 0
						? Number(event.args.offset ?? event.args.line)
						: 1,
				query:
					typeof event.args.pattern === "string"
						? boundedText(event.args.pattern, 256)
						: typeof event.args.symbol === "string"
							? boundedText(event.args.symbol, 256)
							: undefined,
				limit:
					typeof event.args.limit === "number" && Number.isSafeInteger(event.args.limit) && event.args.limit > 0
						? event.args.limit
						: undefined,
			});
			if (scope.toolInputs.size > 64) scope.toolInputs.delete(scope.toolInputs.keys().next().value!);
		});
		volt.on("tool_execution_end", async (event, ctx) => {
			if (!isEnabled() || !scope || scope.stopped || !ctx.work || ctx.work.snapshot.scopeId !== scope.id) return;
			scope.ctx = ctx;
			// Mutations may overlap background observations. Clear again after completion so
			// results captured during a mutation cannot seed the following cycle's cache.
			if (scope.mutatingTools.delete(event.toolCallId)) {
				scope.resources.invalidate();
				scope.offered = [];
			}
			const input = scope.toolInputs.get(event.toolCallId);
			scope.toolInputs.delete(event.toolCallId);
			const raw = textContent(event.result.content);
			if (input?.path && !event.isError) {
				if (event.toolName === "read") {
					const range = foregroundReadRange(input.path, input.offset, input.limit, raw, event.result.details);
					if (range) scope.reads.push(range);
					if (scope.reads.length > 64) scope.reads.shift();
				} else if (["edit", "write"].includes(event.toolName))
					scope.reads = scope.reads.filter((item) => item.path !== input.path);
			}
			const current = scope;
			const consumed = [...current.activePublications.values()].filter((item) =>
				alreadyRead(current.reads, item.candidate, item.startLine, item.endLine),
			);
			await retire(current, consumed, "foreground_read");
			if (scope !== current || current.stopped) return;
			const observed: AheadPath[] = event.isError
				? []
				: [
						...(input?.path && event.toolName !== "grep"
							? [{ path: input.path, line: input.offset, origin: "tool" as const }]
							: []),
						...(event.toolName === "read" && !input?.path
							? []
							: observedPaths(
									input?.searchRoot ? resolve(ctx.cwd, input.searchRoot) : ctx.cwd,
									boundedText(raw, 8192),
									event.toolName === "read" ? input?.path : undefined,
								)
						).flatMap((item) => {
							const path = workspacePath(ctx.cwd, resolve(ctx.cwd, input?.searchRoot ?? ".", item.path));
							return path
								? [{ ...item, path, origin: event.toolName === "grep" ? ("tool" as const) : item.origin }]
								: [];
						}),
					];
			const paths = new Map<string, AheadPath>();
			for (const item of [...observed, ...scope.paths])
				if (
					!paths.has(item.path) ||
					PATH_PRIORITY[item.origin] > PATH_PRIORITY[paths.get(item.path)!.origin] ||
					(PATH_PRIORITY[item.origin] === PATH_PRIORITY[paths.get(item.path)!.origin] &&
						paths.get(item.path)!.line === 1 &&
						item.line > 1)
				)
					paths.set(item.path, item);
			scope.paths = [...paths.values()]
				.sort((a, b) => PATH_PRIORITY[b.origin] - PATH_PRIORITY[a.origin])
				.slice(0, 64);
			const observation = {
				name: boundedText(event.toolName, 80),
				isError: event.isError,
				text: boundedText(raw, 2048),
				...(input?.path ? { path: input.path } : {}),
				...(input?.query ? { query: input.query } : {}),
			};
			const fingerprint = createHash("sha256")
				.update(JSON.stringify({ observation, input, observed }))
				.digest("hex");
			if (scope.seenTools.has(fingerprint) && !["edit", "write"].includes(event.toolName)) {
				scope.report.duplicateToolResults++;
				return;
			}
			scope.seenTools.add(fingerprint);
			if (scope.seenTools.size > 128) scope.seenTools.delete(scope.seenTools.values().next().value!);
			scope.tools.push(observation);
			if (scope.tools.length > 4) scope.tools.shift();
			if (scope.pending) scope.report.coalescedToolResults++;
			scope.pending = true;
		});
		volt.registerCommand("ahead", {
			description: "Control Jev Ahead of Model Work (on/off/status/report/history/audit)",
			getArgumentCompletions: (prefix) =>
				["on", "off", "status", "report", "history", "audit"]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const action = args.trim() || "status";
				if (action === "history" || action === "audit" || action.startsWith("audit ")) {
					ctx.ui.notify(
						auditText(ctx, action === "history" ? undefined : action.slice(5).trim() || "latest"),
						"info",
					);
					return;
				}
				if (action === "report") {
					ctx.ui.notify(reportText(), "info");
					return;
				}
				if (action === "status") {
					ctx.ui.notify(
						`Ahead: ${isEnabled() ? "on" : "off"}. Up to ${MAX_AHEAD_CYCLES} cycles / ${MAX_AHEAD_EVALUATIONS} evaluations per request. Shared wait ${ctx.getPreparationWait().waitMs} ms. ${options.zeroDataRetention ? "ZDR required." : "ZDR off."} Use /ahead report for decisions.`,
						"info",
					);
					return;
				}
				if (action !== "on" && action !== "off") {
					ctx.ui.notify("Usage: /ahead [on|off|status|report|history|audit [entry-id]]", "warning");
					return;
				}
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Use the explicit CLI flag or SDK enabled option outside the local TUI.", "warning");
					return;
				}
				if (commandOpen) return;
				commandOpen = true;
				const opened = generation;
				try {
					await ctx.waitForIdle();
					if (opened !== generation) return;
					if (action === "on" && !isEnabled()) {
						if (options.enabled === false) {
							ctx.ui.notify("Ahead is disabled by the SDK host.", "warning");
							return;
						}
						const consent = await ctx.ui.confirm(
							"Enable Ahead of Model Work with Jev?",
							`Send bounded recent conversation, tool output, repository paths, source excerpts, and skill instructions to Vercel AI Gateway / TypeSafe AI. Content is not redacted and may contain secrets. Up to ${MAX_AHEAD_EVALUATIONS} evaluations per user request may incur cost. ${
								options.zeroDataRetention ? "Zero Data Retention is required." : "Zero Data Retention is off."
							} Exact evaluation inputs, results and selected excerpts are saved locally in the session audit. This choice lasts until reload, tree navigation, or session replacement.`,
						);
						if (!consent || opened !== generation) return;
						if (ctx.getPreparationWait().waitMs === 0) await ctx.requestPreparationWait(1000);
						await ctx.waitForIdle();
						if (opened !== generation) return;
					}
					enabled = action === "on";
					if (!enabled) stop("disabled");
					status(ctx);
					ctx.ui.notify(`Ahead: ${enabled ? "on" : "off"}. Runtime only.`, "info");
				} finally {
					commandOpen = false;
				}
			},
		});
	};
}

export default createJevAheadOfModel();
