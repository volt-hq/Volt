/** Opt-in Ahead of Model Work experiment. See README.md for the expanded data export and budgets. */
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionWorkContribution,
	ExtensionWorkStatus,
	ExtensionWorkTaskHandle,
} from "@hansjm10/volt-coding-agent";
import { evaluateAhead, type JevResult, type JevTransportOptions } from "./client.ts";
import { type AheadCycle, type AheadStage, type AheadState, boundedText, prepareAhead } from "./pipeline.ts";

const FLAG = "jev-ahead-of-model";
const MAX_CYCLES = 3;

export interface AheadReport {
	cycles: AheadCycle[];
	evaluations: Array<{ cycle: number; stage: AheadStage; questions: number; result: JevResult }>;
	boundaries: Array<{
		cause: string;
		waitMs: number;
		observation?: { at: string; evaluations: number; contributions: ExtensionWorkStatus["contributions"] };
	}>;
	coalescedToolResults: number;
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
	pending: boolean;
	stopped: boolean;
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
		const text = boundedText(raw, Math.min(remaining, 2048));
		truncated ||= text.length !== raw.length;
		recent.unshift({ role: entry.message.role, text });
		remaining -= Buffer.byteLength(text);
		if (recent.length === 8 || remaining === 0) {
			truncated = true;
			break;
		}
	}
	return { request, recent, tools: structuredClone(scope.tools), truncated };
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

		function stop(): void {
			if (!scope) return;
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
				`${report.cycles.length}/${MAX_CYCLES} preparation cycles; ${report.evaluations.length}/12 Jev evaluations; ${report.coalescedToolResults} tool results coalesced.`,
			];
			for (const cycle of report.cycles) {
				lines.push(
					`Cycle ${cycle.number}: ${cycle.trigger}; ${cycle.status}; task phase ${cycle.phase ?? "unclassified"}`,
				);
				for (const call of report.evaluations.filter((item) => item.cycle === cycle.number)) {
					const result = call.result;
					lines.push(
						`  ${call.stage}: ${call.questions} questions; ${result.status}${result.status === "ok" ? "" : ` (${result.reason})`}; ${Math.round(result.elapsedMs)} ms; HTTP ${result.httpStatus ?? "unobserved"}; input tokens ${result.inputTokens ?? "unknown"}; cost ${result.cost ?? "unknown"}`,
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
						`  ${operation.service} ${JSON.stringify(operation.candidate)}: ${operation.status}${operation.truncated ? " (partial)" : ""}`,
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
			);
			return lines.join("\n");
		}

		function releaseProjection(at: string): void {
			if (!scope?.projection) return;
			const boundary = scope.report.boundaries.at(-1);
			try {
				if (boundary)
					boundary.observation = {
						at,
						evaluations: scope.report.evaluations.length,
						contributions: volt.getWorkStatus().contributions,
					};
			} catch {
				/* Missing diagnostics remain unobserved. */
			}
			scope.projection.release();
			scope.projection = undefined;
			observe(scope);
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
			if (current.report.cycles.length >= MAX_CYCLES) {
				current.pending = false;
				current.report.status = "cycle budget reached";
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
			const admission = current.ctx.work.tasks.start(
				{ key: `ahead-${cycle.number}`, label: "Ahead of Model Work with Jev", timeoutMs: 8000 },
				async (task) => {
					try {
						await prepareAhead(
							task,
							state,
							cycle,
							async (stage, input, questions) => {
								const result = await evaluateAhead(
									input,
									questions,
									() => current.ctx.modelRegistry.getApiKeyForProvider("vercel-ai-gateway"),
									task.signal,
									options,
								);
								current.report.evaluations.push({
									cycle: cycle.number,
									stage,
									questions: Object.keys(questions).length,
									result,
								});
								observe(current);
								return result;
							},
							async (contributions: ExtensionWorkContribution[]) => {
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
								for (let i = 0; i < 6; i++) task.context.remove(`ahead-${i}`);
								for (const contribution of contributions) {
									const result = task.context.put(contribution);
									const publication = cycle.publications.find((item) => item.key === contribution.key);
									if (publication) publication.status = result.status;
								}
							},
						);
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
					if (current.pending) start(current, "tools");
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
			stop();
			generation++;
			scope = undefined;
			if (ctx.mode === "tui") ctx.ui.setStatus(FLAG, undefined);
		});
		volt.on("agent_end", () => stop());
		volt.on("before_provider_request", () => releaseProjection("before_provider_request"));
		volt.on("after_provider_response", () => releaseProjection("provider_response"));
		// Some SDK providers have no payload hook. Actual assistant output also proves
		// collection has finished, without creating or waiting for another model request.
		volt.on("message_update", (event) => {
			if (event.message.role === "assistant") releaseProjection("model_output");
		});
		volt.on("request_boundary", (event, ctx) => {
			if (!isEnabled() || !ctx.work) return;
			if (event.first) {
				stop();
				scope = {
					id: ctx.work.snapshot.scopeId,
					ctx,
					pending: false,
					stopped: false,
					tools: [],
					report: { cycles: [], evaluations: [], boundaries: [], coalescedToolResults: 0, status: "starting" },
				};
			}
			if (!scope || scope.stopped || scope.id !== ctx.work.snapshot.scopeId) return;
			scope.ctx = ctx;
			scope.projection?.release();
			let release!: () => void;
			const promise = new Promise<void>((done) => {
				release = done;
			});
			const cutoff = performance.now() + (event.first ? event.waitAvailableMs : 0);
			scope.projection = { cutoff, promise, release };
			const boundary: AheadReport["boundaries"][number] = { cause: event.cause, waitMs: 0 };
			scope.report.boundaries.push(boundary);
			if (scope.report.boundaries.length > 8) scope.report.boundaries.shift();
			if (event.first && start(scope, "request")) boundary.waitMs = ctx.work.context.requestWait(1000);
			else if (event.cause !== "retry" && scope.pending) start(scope, "tools");
			observe(scope);
		});
		volt.on("tool_execution_end", (event, ctx) => {
			if (!isEnabled() || !scope || scope.stopped || !ctx.work || ctx.work.snapshot.scopeId !== scope.id) return;
			scope.ctx = ctx;
			scope.tools.push({
				name: boundedText(event.toolName, 80),
				isError: event.isError,
				text: boundedText(textContent(event.result.content), 2048),
			});
			if (scope.tools.length > 4) scope.tools.shift();
			if (scope.pending) scope.report.coalescedToolResults++;
			scope.pending = true;
			start(scope, "tools");
		});
		volt.registerCommand("ahead", {
			description: "Control Jev Ahead of Model Work (on/off/status/report)",
			getArgumentCompletions: (prefix) =>
				["on", "off", "status", "report"]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const action = args.trim() || "status";
				if (action === "report") {
					ctx.ui.notify(reportText(), "info");
					return;
				}
				if (action === "status") {
					ctx.ui.notify(
						`Ahead: ${isEnabled() ? "on" : "off"}. Up to 3 cycles / 12 evaluations per request. Shared wait ${ctx.getPreparationWait().waitMs} ms. ${options.zeroDataRetention ? "ZDR required." : "ZDR off."} Use /ahead report for decisions.`,
						"info",
					);
					return;
				}
				if (action !== "on" && action !== "off") {
					ctx.ui.notify("Usage: /ahead [on|off|status|report]", "warning");
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
							`Send bounded recent conversation, tool output, repository paths, source excerpts, and skill instructions to Vercel AI Gateway / TypeSafe AI. Content is not redacted and may contain secrets. Up to 12 evaluations per user request may incur cost. ${
								options.zeroDataRetention ? "Zero Data Retention is required." : "Zero Data Retention is off."
							} This choice lasts until reload, tree navigation, or session replacement.`,
						);
						if (!consent || opened !== generation) return;
						if (ctx.getPreparationWait().waitMs === 0) await ctx.requestPreparationWait(1000);
						await ctx.waitForIdle();
						if (opened !== generation) return;
					}
					enabled = action === "on";
					if (!enabled) stop();
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
