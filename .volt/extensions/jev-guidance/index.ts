import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@hansjm10/volt-coding-agent";
import { adviceText, GuidanceController, type Mode } from "./controller.ts";
import { prWorkerTask } from "./pr-routing.ts";
import { MESSAGE_TYPE } from "./snapshot.ts";

export default function jevGuidance(volt: ExtensionAPI): void {
	const controller = new GuidanceController();
	let revision = 0;
	let nominations = 0;

	function refreshStatus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const last = controller.last;
		const detail =
			last?.kind === "judgment"
				? `${last.choice} ${last.elapsedMs}ms`
				: last?.kind === "error"
					? last.reason
					: "ready";
		const wait = controller.waitMs > 0 ? `; wait ${Math.ceil(controller.waitMs / 1_000)}s` : "";
		ctx.ui.setStatus(
			MESSAGE_TYPE,
			controller.mode === "off" ? undefined : `Jev ${controller.mode}: ${detail}${wait}`,
		);
	}

	function changeMode(mode: Mode, ctx: ExtensionContext): void {
		revision++;
		controller.setMode(mode);
		refreshStatus(ctx);
		if (ctx.mode === "tui" && mode !== "off") {
			ctx.ui.notify(
				`Jev ${mode}: selected session context goes to Vercel/TypeSafe without ZDR. /jev off disables it.`,
				"info",
			);
		}
	}

	volt.registerFlag("jev", {
		type: "string",
		default: "off",
		description: "Local Jev: off, observe, advise, or route (non-ZDR)",
	});
	volt.registerCommand("jev", {
		description:
			"Jev: off | observe | advise | route | status | interval <seconds>. PR model/thinking come from the pr agent definition. Enabled modes upload selected context without ZDR.",
		remoteSafe: false,
		async handler(args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Jev guidance is available only in the local TUI.", "warning");
				return;
			}
			const [action = "status", value, extra] = args.trim().split(/\s+/);
			if (action === "route" && value === undefined) {
				changeMode("route", ctx);
				ctx.ui.notify(
					"PR routing enabled: pr, using the model and thinking level in its agent definition. Only standalone requests for completed, committed changes qualify.",
					"info",
				);
				return;
			}
			if (["off", "observe", "advise"].includes(action) && value === undefined) {
				changeMode(action as Mode, ctx);
				return;
			}
			if (action === "interval" && value !== undefined && extra === undefined) {
				const seconds = Number(value);
				if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 300) {
					controller.intervalMs = seconds * 1_000;
					ctx.ui.notify(`Jev minimum interval: ${seconds}s. Existing cooldowns still apply.`, "info");
					return;
				}
			}
			if ((action === "status" || action === "") && value === undefined) {
				const stats = controller.stats;
				const cost = stats.costSamples
					? `$${stats.costUsd.toFixed(6)} reported across ${stats.costSamples} calls`
					: "cost unavailable";
				ctx.ui.notify(
					`Jev ${controller.mode}; interval ${controller.intervalMs / 1_000}s; wait ${Math.ceil(controller.waitMs / 1_000)}s.\n${stats.evaluations} attempts, ${stats.advised} reminders, ${stats.skipped} skipped, ${stats.errors} errors.\nPR worker pr (model/thinking from its agent definition); ${nominations} route nominations (not proof of completion).\nTokens ${stats.inputTokens} in / ${stats.outputTokens} out; ${cost}.\nLast: ${JSON.stringify(controller.last ?? null)}`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				"Usage: /jev off|observe|advise|route|status, or /jev interval <1–300 seconds>. Configure the PR model in .volt/agents/pr.md.",
				"warning",
			);
		},
	});

	volt.on("session_start", (_event, ctx) => {
		const requested = volt.getFlag("jev");
		changeMode(
			ctx.mode === "tui" && (requested === "observe" || requested === "advise" || requested === "route")
				? requested
				: "off",
			ctx,
		);
	});
	volt.on("session_shutdown", (_event, ctx) => changeMode("off", ctx));
	const invalidate = () => {
		revision++;
		controller.invalidate();
	};
	volt.on("session_tree", invalidate);
	volt.on("session_compact", invalidate);
	volt.on("input", invalidate);

	volt.on("prompt_route", async (event, ctx) => {
		if (ctx.mode !== "tui" || controller.mode !== "route") return;
		// Cheap prefilter only, not an authorization decision. Never classify a truncated current request.
		if (event.prompt.length > 3_000 || !/\b(?:pr|pull[\s-]+request)\b/i.test(event.prompt)) return;
		const worker = event.agents.find((agent) => agent.name === "pr");
		const model = worker?.model;
		if (
			!worker ||
			!model ||
			!ctx.modelRegistry.getAvailable().some((entry) => `${entry.provider}/${entry.id}` === model)
		) {
			ctx.ui.notify(
				"PR routing skipped: load a trusted pr agent with an exact configured provider/model in its definition. The primary model will handle this request.",
				"warning",
			);
			return;
		}
		if (ctx.model && `${ctx.model.provider}/${ctx.model.id}` === model) {
			ctx.ui.notify(
				"PR routing skipped: the pr agent must use a model different from the primary model.",
				"warning",
			);
			return;
		}
		const current = revision;
		const messages = [
			...buildSessionContext(ctx.sessionManager.getBranch()).messages,
			{ role: "user" as const, content: event.prompt, timestamp: Date.now() },
		];
		const outcome = await controller.inspect(
			messages,
			() => ctx.modelRegistry.getApiKeyForProvider("vercel-ai-gateway"),
			event.signal,
		);
		if (current !== revision || event.signal.aborted) return;
		if (outcome.kind !== "skipped") volt.appendEntry(MESSAGE_TYPE, { mode: controller.mode, ...outcome });
		refreshStatus(ctx);
		if (
			outcome.kind !== "judgment" ||
			outcome.choice !== "pr_worker" ||
			!Number.isFinite(outcome.probability) ||
			!((outcome.probability ?? 0) >= 0.95 && (outcome.probability ?? 0) <= 1)
		)
			return;
		nominations++;
		return { agent: worker.name, model, task: prWorkerTask(event.prompt, messages) };
	});

	volt.on("context", async (event, ctx) => {
		if (ctx.mode !== "tui" || controller.mode === "off" || controller.mode === "route") return;
		const current = revision;
		const outcome = await controller.inspect(
			event.messages,
			() => ctx.modelRegistry.getApiKeyForProvider("vercel-ai-gateway"),
			ctx.signal,
			() => !ctx.hasPendingMessages(),
		);
		if (current !== revision) return;
		if (outcome.kind !== "skipped") volt.appendEntry(MESSAGE_TYPE, { mode: controller.mode, ...outcome });
		refreshStatus(ctx);
		if (outcome.kind !== "judgment") return;
		const text = adviceText(outcome);
		if (!text) return;
		ctx.ui.notify(`Jev reminder: ${outcome.choice} (${Math.round((outcome.probability ?? 0) * 100)}%).`, "info");
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: MESSAGE_TYPE,
					content: text,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
}
