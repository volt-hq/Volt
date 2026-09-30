import type { AgentSession } from "@hansjm10/volt-coding-agent";
import type { UsageTotals } from "./types.ts";

export class SwarmCancelled extends Error {
	constructor() {
		super("Swarm review cancelled");
	}
}

export function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
}

export function lineRange(start: number, end: number | undefined): string {
	return end !== undefined && end > start ? `${start}-${end}` : String(start);
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(target: UsageTotals, value: UsageTotals): void {
	target.input += value.input;
	target.output += value.output;
	target.cacheRead += value.cacheRead;
	target.cacheWrite += value.cacheWrite;
	target.cost += value.cost;
}

export function sessionUsage(session: AgentSession): UsageTotals {
	const totals = emptyUsage();
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		addUsage(totals, {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			cost: message.usage.cost.total,
		});
	}
	return totals;
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export function formatCost(value: number): string {
	return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function usageText(usage: UsageTotals): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const cached = prompt > 0 ? `, ${Math.round((usage.cacheRead / prompt) * 100)}% cached` : "";
	return `${formatCost(usage.cost)} (${formatTokens(prompt)} in${cached}, ${formatTokens(usage.output)} out)`;
}

/** Runs tasks with bounded concurrency. Tasks must not throw. */
export async function runPool(
	count: number,
	concurrency: number,
	task: (index: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.min(count, concurrency) }, async () => {
		while (next < count) await task(next++);
	});
	await Promise.all(lanes);
}
