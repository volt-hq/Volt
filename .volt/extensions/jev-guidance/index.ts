import type { ExtensionAPI, ExtensionContext } from "@hansjm10/volt-coding-agent";
import { adviceText, GuidanceController, type Mode } from "./controller.ts";
import { MESSAGE_TYPE } from "./snapshot.ts";

export default function jevGuidance(volt: ExtensionAPI): void {
	const controller = new GuidanceController();
	let revision = 0;

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
		description: "Local Jev guidance: off, observe, or advise (non-ZDR)",
	});
	volt.registerCommand("jev", {
		description:
			"Jev guidance: off | observe | advise | status | interval <seconds>. Observe/advise upload selected context without ZDR.",
		remoteSafe: false,
		async handler(args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Jev guidance is available only in the local TUI.", "warning");
				return;
			}
			const [action = "status", value, extra] = args.trim().split(/\s+/);
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
					`Jev ${controller.mode}; interval ${controller.intervalMs / 1_000}s; wait ${Math.ceil(controller.waitMs / 1_000)}s.\n${stats.evaluations} attempts, ${stats.advised} reminders, ${stats.skipped} skipped, ${stats.errors} errors.\nTokens ${stats.inputTokens} in / ${stats.outputTokens} out; ${cost}.\nLast: ${JSON.stringify(controller.last ?? null)}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /jev off|observe|advise|status or /jev interval <1–300 seconds>", "warning");
		},
	});

	volt.on("session_start", (_event, ctx) => {
		const requested = volt.getFlag("jev");
		changeMode(ctx.mode === "tui" && (requested === "observe" || requested === "advise") ? requested : "off", ctx);
	});
	volt.on("session_shutdown", (_event, ctx) => changeMode("off", ctx));
	const invalidate = () => {
		revision++;
		controller.invalidate();
	};
	volt.on("session_tree", invalidate);
	volt.on("session_compact", invalidate);
	volt.on("input", invalidate);

	volt.on("context", async (event, ctx) => {
		if (ctx.mode !== "tui" || controller.mode === "off") return;
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
