/**
 * A single-file extension whose `project_trust` handler answers as a test
 * set it for the project: yes, no, undecided, yes remembered, or yes once
 * the user confirms its own question. It records each call. The state is on
 * `globalThis` (its module may load more than once in a process), so a test
 * sets and reads what a daemon's in-process worker uses.
 */

import type { ExtensionAPI, ProjectTrustEventResult } from "../../src/core/extensions/types.ts";

export const manifest = {
	id: "project-trust-hook",
	displayName: "Project trust hook",
} as const;

/**
 * How the handler answers for a project: `remember` is yes, saved; `confirm` is yes once the user confirms,
 * and `confirm-briefly` the same with a 300 ms timeout on its question.
 */
export type ProjectTrustHookAnswer = "yes" | "no" | "undecided" | "remember" | "confirm" | "confirm-briefly";

export interface ProjectTrustHookState {
	/** By the project's path as the event names it; undecided when unset. */
	readonly answers: Map<string, ProjectTrustHookAnswer>;
	readonly calls: Array<{ readonly cwd: string; readonly hasUI: boolean }>;
}

const STATE = Symbol.for("volt.test.projectTrustHook");

export function projectTrustHook(): ProjectTrustHookState {
	const global = globalThis as { [STATE]?: ProjectTrustHookState };
	global[STATE] ??= { answers: new Map(), calls: [] };
	return global[STATE];
}

export default function projectTrustExtension(volt: ExtensionAPI): void {
	volt.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
		const state = projectTrustHook();
		state.calls.push({ cwd: event.cwd, hasUI: ctx.hasUI });
		switch (state.answers.get(event.cwd) ?? "undecided") {
			case "yes":
				return { trusted: "yes" };
			case "no":
				return { trusted: "no" };
			case "remember":
				return { trusted: "yes", remember: true };
			case "confirm":
				return (await ctx.ui.confirm("Trust this project?", event.cwd))
					? { trusted: "yes" }
					: { trusted: "undecided" };
			case "confirm-briefly":
				return (await ctx.ui.confirm("Trust this project?", event.cwd, { timeout: 300 }))
					? { trusted: "yes" }
					: { trusted: "undecided" };
			case "undecided":
				return { trusted: "undecided" };
		}
	});
}
