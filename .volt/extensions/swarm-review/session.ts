import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createExtensionRuntime,
	getAgentDir,
	type ResourceLoader,
	SessionManager,
	type ToolDefinition,
} from "@hansjm10/volt-coding-agent";
import { createRepositoryTools, REPOSITORY_TOOL_NAMES } from "./tools.ts";
import type { PassState, SwarmSetup } from "./types.ts";
import { SwarmCancelled, sessionUsage } from "./util.ts";

function isolatedResourceLoader(
	systemPrompt: string,
	agentsFiles: Array<{ path: string; content: string }>,
): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getSubagents: () => ({ definitions: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function lastAssistantError(session: AgentSession): string | undefined {
	const last = session.messages.findLast((message) => message.role === "assistant");
	return last?.role === "assistant" && last.stopReason === "error"
		? (last.errorMessage ?? "Model request failed.")
		: undefined;
}

/** External controls for a running pass, used for straggler handling. */
export interface PassControl {
	/** Ask the model to stop investigating and report (once). */
	wrapUp(): void;
	/** Abort the current turn and require the report in a report-only repair turn. */
	finish(): void;
}

export interface PassOptions {
	label: string;
	model: Model<Api>;
	thinking: ModelThinkingLevel;
	systemPrompt: string;
	/** Created with defineTool(), whose result is assignable to the generic definition type. */
	reportTool: ToolDefinition;
	hasReport: () => boolean;
	prompt: string;
	wrapUpMessage: string;
	repairMessage: string;
	turns: { wrapUp: number; max: number };
	state: PassState;
	/** Repository inspection tools (default true). */
	inspect?: boolean;
	/** Built-in tools to enable in addition, such as bash for --exec verifiers. */
	extraTools?: string[];
	onEvent?: (event: AgentSessionEvent) => void;
	bindControl?: (control: PassControl) => void;
}

/** Runs one isolated, extension-free agent session until its report tool is called. Throws on failure. */
export async function runPass(setup: SwarmSetup, pass: PassOptions): Promise<void> {
	const sessionManager = SessionManager.inMemory(setup.target.checkout);
	// A named session skips the automatic naming request.
	sessionManager.appendSessionInfo(pass.label);
	const inspect = pass.inspect ?? true;
	const { session } = await createAgentSession({
		cwd: setup.target.checkout,
		agentDir: getAgentDir(),
		authStorage: setup.modelRegistry.authStorage,
		modelRegistry: setup.modelRegistry,
		settingsManager: setup.settingsManager,
		model: pass.model,
		thinkingLevel: pass.thinking,
		sessionManager,
		resourceLoader: isolatedResourceLoader(pass.systemPrompt, setup.contextFiles),
		customTools: [...(inspect ? createRepositoryTools(setup.target) : []), pass.reportTool],
		tools: [...(inspect ? REPOSITORY_TOOL_NAMES : []), ...(pass.extraTools ?? []), pass.reportTool.name],
		disableMcp: true,
	});
	let limitsActive = true;
	let wrapUpSent = false;
	let forced = false;
	let aborting: Promise<void> | undefined;
	const wrapUp = (): void => {
		if (wrapUpSent || !limitsActive) return;
		wrapUpSent = true;
		void session.steer(pass.wrapUpMessage).catch(() => undefined);
	};
	const finish = (): void => {
		if (!limitsActive) return;
		forced = true;
		aborting = session.abort().catch(() => undefined);
	};
	pass.bindControl?.({ wrapUp, finish });
	pass.state.startedAt = Date.now();
	const unsubscribe = session.subscribe(
		(event) => {
			if (event.type === "tool_execution_start") pass.state.toolCalls++;
			if (event.type === "turn_end" && limitsActive) {
				pass.state.turns++;
				if (pass.state.turns >= pass.turns.wrapUp) wrapUp();
				if (pass.state.turns >= pass.turns.max) finish();
			}
			pass.onEvent?.(event);
			setup.onProgress();
		},
		{ monitorGitContext: false },
	);
	const onAbort = (): void => {
		void session.abort();
	};
	setup.signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (setup.signal.aborted) throw new SwarmCancelled();
		await session.prompt(pass.prompt, { expandPromptTemplates: false });
		if (setup.signal.aborted) throw new SwarmCancelled();
		if (pass.hasReport()) return;
		const failure = lastAssistantError(session);
		if (failure && !forced) throw new Error(failure);
		// One repair turn with only the report tool available. A forced abort returns from prompt() before its
		// cleanup settles, so wait for it; prompting a still-busy session throws.
		limitsActive = false;
		await aborting;
		await session.waitForIdle();
		session.setActiveToolsByName([pass.reportTool.name]);
		await session.prompt(pass.repairMessage, { expandPromptTemplates: false });
		if (setup.signal.aborted) throw new SwarmCancelled();
		if (!pass.hasReport()) {
			throw new Error(lastAssistantError(session) ?? `Did not call ${pass.reportTool.name}.`);
		}
	} finally {
		limitsActive = false;
		pass.state.finishedAt = Date.now();
		pass.state.usage = sessionUsage(session);
		unsubscribe();
		setup.signal.removeEventListener("abort", onAbort);
		session.dispose();
		await session.waitForClosed();
	}
}
