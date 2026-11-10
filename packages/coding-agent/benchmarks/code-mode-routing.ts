import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@hansjm10/volt-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	EMPTY_RESPONSE_CODE,
	type Model,
	type Usage,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defineManifest } from "../src/core/extensions/manifest.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../src/core/mcp/output-store.ts";
import type { McpClientConnection } from "../src/core/mcp/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BenchmarkFixture } from "./code-mode-fixtures.ts";

/** The default comparison: three ways of presenting code mode. */
export const ROUTING_MODES = ["hybrid", "code-first", "code-only"] as const;
/** `direct` is the baseline without code mode: no run_code tool and none of its guidance. */
export const ALL_ROUTING_MODES = ["direct", ...ROUTING_MODES] as const;
export type RoutingMode = (typeof ALL_ROUTING_MODES)[number];
/** Twenty requests let the direct route finish a task that reads a dozen results one turn at a time. */
export const CASE_LIMITS = { requests: 20, toolCalls: 200, timeoutMs: 300_000, responseChars: 65_536 };

const CODE_FIRST = `For the fixture's data-retrieval stage, prefer run_code when code can paginate, join, filter, or aggregate results. Discover schemas with mcp first. Run independent calls concurrently with Promise.allSettled and inspect failures. Return only the requested answer fields and necessary evidence, not whole intermediate results. Use direct calls for one lookup or when interpreting a result is necessary to choose the next step. Do not repeat completed calls.`;
const CODE_ONLY = `MCP discovery and cache reading remain direct. MCP tool invocation is programmatic-only in this experiment: call tools.mcp.fixture.<tool>(args) inside run_code, never mcp action=call. Discover tool schemas before writing the script. Emit only the requested answer fields and necessary evidence. Do not repeat completed calls.`;

/** Benchmark-only presentation. The session's grants remain unchanged; a host hook enforces the route. */
export function projectRoutingContext(context: Context, mode: RoutingMode): Context {
	if (mode === "hybrid" || mode === "direct") return context;
	const suffix = mode === "code-first" ? CODE_FIRST : CODE_ONLY;
	return {
		...context,
		systemPrompt: `${context.systemPrompt ?? ""}\n\n${suffix}`,
		tools: context.tools?.map((tool) => {
			if (mode !== "code-only" || tool.name !== "mcp") return tool;
			// Preserve every native schema field except the direct invocation variant.
			const parameters = structuredClone(tool.parameters);
			const action = (parameters as { properties?: { action?: { anyOf?: Array<{ const?: unknown }> } } }).properties?.action;
			if (!Array.isArray(action?.anyOf) || !action.anyOf.some((item: { const?: unknown }) => item.const === "call"))
				throw new Error("The native MCP action schema changed; review the benchmark projection");
			action.anyOf = action.anyOf.filter((item: { const?: unknown }) => item.const !== "call");
			return {
				...tool,
				description: "Discover and inspect MCP tools and read cached results. Invoke MCP tools only through run_code bindings.",
				parameters: Type.Unsafe(parameters),
			};
		}),
	};
}

export interface RoutingRequest {
	index: number;
	reasoning: string;
	contextBytes: number;
	toolSchemaBytes: number;
	systemPromptBytes: number;
	toolResultBytes: number;
	elapsedMs: number;
	stopReason?: AssistantMessage["stopReason"];
	usage?: Usage;
	failure?: string;
}

export interface RoutingCaseResult {
	fixture: string;
	mode: RoutingMode;
	model: string;
	status: "completed" | "failed";
	failure?: string;
	correct: boolean;
	gradeReason?: string;
	answer: string;
	elapsedMs: number;
	requests: RoutingRequest[];
	/** `action` is the MCP gateway action, so discovery and data calls can be told apart. */
	calls: Array<{ tool: string; route: "direct" | "programmatic"; blocked: boolean; action?: string }>;
	dataCalls: Array<{ tool: string; arguments: Record<string, unknown>; resultBytes: number; failed: boolean }>;
	repeatedDataCalls: number;
	scriptFailures: number;
	toolFailures: number;
	transcript: unknown[];
}

export interface RoutingCaseOptions {
	model: Model<Api>;
	streamFn: StreamFn;
	/** Called for every request, before dispatch. Never included in artifacts. */
	getApiKey?: () => string;
	/** Shared run admission/accounting; throw to stop before a provider request starts. */
	admitRequest?: () => void;
	observeUsage?: (usage: Usage) => void;
	signal?: AbortSignal;
	limits?: Partial<typeof CASE_LIMITS>;
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function textOf(message: { content: AssistantMessage["content"] }): string {
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolvePromise, reject) => {
		const abort = () => reject(new Error("cancelled"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function failureMessage(model: Model<Api>, kind: string): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [], timestamp: Date.now(), stopReason: "error",
		error: { kind: "unknown", retryable: false, message: kind },
		usage: { availability: "unavailable", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

/** Real session + real MCP manager + real QuickJS. Only the MCP transport/data and provider are injected. */
export async function runRoutingCase(
	fixture: BenchmarkFixture,
	mode: RoutingMode,
	options: RoutingCaseOptions,
): Promise<RoutingCaseResult> {
	const limits = { ...CASE_LIMITS, ...options.limits };
	const root = await mkdtemp(join(tmpdir(), "volt-routing-"));
	const agentDir = join(root, "agent");
	const result: RoutingCaseResult = {
		fixture: fixture.id, mode, model: `${options.model.provider}/${options.model.id}`,
		status: "failed", correct: false, answer: "", elapsedMs: 0, requests: [], calls: [], dataCalls: [],
		repeatedDataCalls: 0, scriptFailures: 0, toolFailures: 0, transcript: [],
	};
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, options.signal ?? controller.signal]);
	let session: AgentSession | undefined;
	let manager: McpManager | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Set<Promise<void>>();
	const abort = () => { void session?.abort().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	let startedAt = performance.now();
	try {
		signal.throwIfAborted();
		const merged = createEmptyMcpMergedConfig();
		mergeMcpConfigFile(merged, { servers: { fixture: {
			command: "benchmark-in-memory-only", trustedReads: { tools: fixture.tools.map((tool) => tool.name) },
		} } }, sourceForMcpConfigPath(join(agentDir, "mcp.json"), {
			scope: "user", label: "routing-benchmark", precedence: 1, shared: false,
		}));
		const connection: McpClientConnection = {
			getServerVersion: () => ({ name: "routing-fixture", version: "1" }),
			listTools: async () => ({ tools: fixture.tools.map(({ outputSchema, ...tool }) => ({
				...tool,
				inputSchema: { ...tool.inputSchema, type: "object" as const },
				...(outputSchema ? { outputSchema: { ...outputSchema, type: "object" as const } } : {}),
			})) }),
			listResources: async () => ({ resources: [] }),
			readResource: async () => { throw new Error("No resources in this fixture"); },
			listPrompts: async () => ({ prompts: [] }),
			getPrompt: async () => { throw new Error("No prompts in this fixture"); },
			callTool: async ({ name, arguments: args = {} }, request) => {
				request.signal?.throwIfAborted();
				const call = { tool: name, arguments: structuredClone(args), resultBytes: 0, failed: false };
				result.dataCalls.push(call);
				try {
					const value = fixture.call(name, args);
					call.resultBytes = jsonBytes(value);
					return { content: [], structuredContent: value };
				} catch (error) {
					call.failed = true;
					return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Fixture error" }] };
				}
			},
			close: async () => {},
		};
		manager = new McpManager({
			config: finalizeMcpConfig(merged), clientFactory: { connect: async () => connection },
			metadataCache: new McpMetadataCache({ agentDir }), outputStore: new McpOutputStore({ agentDir }),
		});
		await manager.connectServer("fixture");
		const settingsManager = SettingsManager.inMemory({
			codeMode: { enabled: mode !== "direct" }, compaction: { enabled: false }, retry: { enabled: false }, lsp: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			skipMissingPackages: true,
			extensionFactories: [{
				manifest: defineManifest({ id: "routing-benchmark", displayName: "Routing benchmark" }),
				factory: (volt) => {
					volt.on("tool_call", (event) => {
						const route = event.origin?.kind === "code_mode" ? "programmatic" : "direct";
						const blocked = (mode === "code-only" && route === "direct" && event.toolName === "mcp" && event.input.action === "call")
							|| result.calls.length >= limits.toolCalls;
						const action = event.toolName === "mcp" ? event.input.action : undefined;
						result.calls.push({ tool: event.toolName, route, blocked, ...(typeof action === "string" ? { action } : {}) });
						if (blocked) return { block: true, reason: "Benchmark route or tool-call limit: use the advertised tools only" };
						return undefined;
					});
				},
			}],
		});
		await loader.reload();
		if (loader.getExtensions().errors.length) throw new Error("Benchmark extension failed to load");
		const authStorage = AuthStorage.inMemory();
		// Prevent session auth discovery. Only the tracked stream resolves real snapshot credentials.
		authStorage.setRuntimeApiKey(options.model.provider, "benchmark-injected-stream");
		const registry = ModelRegistry.inMemory(authStorage);
		const trackedStream: StreamFn = (model, context, requestOptions) => {
			const output = createAssistantMessageEventStream();
			const task = (async () => {
				const requestStarted = performance.now();
				let record: RoutingRequest | undefined;
				let sequence = 0;
				try {
					signal.throwIfAborted();
					if (result.requests.length >= limits.requests) throw new Error("request-limit");
					const projected = projectRoutingContext(context, mode);
					record = {
						index: result.requests.length + 1, reasoning: requestOptions?.reasoning ?? "off", contextBytes: jsonBytes(projected),
						toolSchemaBytes: jsonBytes(projected.tools ?? []), systemPromptBytes: Buffer.byteLength(projected.systemPrompt ?? ""),
						toolResultBytes: projected.messages.filter((message) => message.role === "toolResult")
							.reduce((sum, message) => sum + jsonBytes(message.content), 0), elapsedMs: 0,
					};
					const apiKey = options.getApiKey?.();
					options.admitRequest?.();
					result.requests.push(record);
					const stream = await abortable(Promise.resolve(options.streamFn(model, projected, {
						...requestOptions, apiKey, signal: AbortSignal.any([signal, requestOptions?.signal ?? signal]),
						maxTokens: 4096, maxRetries: 0, transport: "sse", cacheRetention: "short",
						inferenceSpeed: "standard", requestDiagnostics: false, timeoutMs: limits.timeoutMs,
					})), signal);
					let chars = 0;
					const iterator = stream[Symbol.asyncIterator]();
					for (;;) {
						const next = await abortable(iterator.next(), signal);
						if (next.done) throw new Error("stream-ended");
						const event = next.value;
						sequence = event.seq;
						if (event.type === "text_delta" || event.type === "thinking_delta") chars += event.delta.length;
						if (event.type === "toolcall_delta") chars += event.argsTextDelta.length;
						if (chars > limits.responseChars) throw new Error("response-limit");
						if (event.type === "done" || event.type === "error") {
							const message = event.type === "done" ? event.message : event.error;
							record.stopReason = message.stopReason;
							record.usage = structuredClone(message.usage);
							options.observeUsage?.(message.usage);
							if (event.type === "error") {
								record.failure = `provider-${message.error?.kind ?? "unknown"}`;
								result.failure = record.failure;
								output.push({ ...event, error: { ...message, content: [], error: { kind: message.error?.kind ?? "unknown", retryable: false, message: record.failure } } });
							} else output.push(event);
							return;
						}
						output.push(event);
					}
				} catch (error) {
					const allowed = new Set(["request-limit", "response-limit", "auth-unavailable", "auth-expired", "run-budget"]);
					const failure = signal.aborted ? "cancelled" : error instanceof Error && allowed.has(error.message) ? error.message : "request-failed";
					if (record) record.failure = failure;
					result.failure ??= failure;
					controller.abort();
					output.push({ type: "error", seq: sequence + 1, reason: "error", error: failureMessage(model, failure) });
				} finally {
					if (record) record.elapsedMs = performance.now() - requestStarted;
				}
			})();
			pending.add(task);
			void task.finally(() => pending.delete(task));
			return output;
		};
		const toolNames = mode === "direct" ? ["mcp"] : ["mcp", "run_code"];
		const sessionManager = SessionManager.inMemory(root);
		await sessionManager.logWriter.appendSessionInfo(`Routing benchmark: ${fixture.id}`);
		session = await AgentSession.create({
			cwd: root, agentDir, model: options.model, thinkingLevel: "xhigh", streamFn: trackedStream,
			convertToLlm, modelRegistry: registry, settingsManager, sessionManager, resourceLoader: loader,
			initialActiveToolNames: toolNames, allowedToolNames: toolNames, mcpManager: manager,
		});
		session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.isError) {
				result.toolFailures++;
				if (event.toolName === "run_code") result.scriptFailures++;
			}
		});
		startedAt = performance.now();
		timer = setTimeout(() => { result.failure = "timeout"; controller.abort(); }, limits.timeoutMs);
		await session.prompt(`All task data is synthetic and available only from the MCP server fixture.\n\n${fixture.prompt}`);
		const final = session.messages.findLast((message) => message.role === "assistant");
		if (final?.role === "assistant") {
			result.answer = textOf(final);
			if (!result.failure && final.stopReason === "stop") result.status = "completed";
			// Retries are off here, so the agent loop's empty-reply error ends the case; name it, since it is a
			// model outcome and not a provider failure.
			else result.failure ??= final.error?.providerCode === EMPTY_RESPONSE_CODE ? "empty-reply" : final.stopReason;
		}
		const grade = fixture.grade(result.answer);
		result.correct = result.status === "completed" && grade.correct;
		if (grade.reason) result.gradeReason = grade.reason;
	} catch {
		result.failure ??= signal.aborted ? "cancelled" : "setup-or-execution-failed";
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		controller.abort();
		if (session) {
			await session.abort().catch(() => {});
			result.transcript = session.messages.map((message) => message.role === "assistant" && message.error
				? { ...message, error: { kind: message.error.kind, retryable: false, message: "Provider diagnostic omitted" } }
				: message);
			session.dispose();
			await session.waitForClosed();
		}
		await manager?.dispose();
		await Promise.allSettled(pending);
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		result.elapsedMs = performance.now() - startedAt;
		const uniqueCalls = new Set(result.dataCalls.map((call) => {
			const properties = fixture.tools.find((tool) => tool.name === call.tool)?.inputSchema.properties;
			const normalized: Record<string, unknown> = {};
			if (properties && typeof properties === "object") {
				for (const [name, schema] of Object.entries(properties)) {
					if (schema && typeof schema === "object" && "default" in schema) normalized[name] = schema.default;
				}
			}
			Object.assign(normalized, call.arguments);
			return JSON.stringify([call.tool, Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right))]);
		}));
		result.repeatedDataCalls = result.dataCalls.length - uniqueCalls.size;
	}
	return result;
}
