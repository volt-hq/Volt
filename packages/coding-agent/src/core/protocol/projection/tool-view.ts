/**
 * The transcript view of tool calls, shared by every transcript projection:
 * bounded per-tool arguments, one-line summaries, subagent and background job
 * details, and the bounded text helpers they use.
 */

import { SUBAGENT_REGISTRY_TOOL_NAME } from "../../subagents/tool-names.ts";

export const TOOL_SUMMARY_LIMIT = 1_000;
export const TOOL_COMMAND_LIMIT = 500;
const TOOL_ARGUMENT_STRING_LIMIT = 500;
const TOOL_ARGUMENT_KEYS_LIMIT = 12;
export const MUTATION_PREVIEW_LIMIT = 4_000;
const SUBAGENT_AGENT_LIMIT = 200;
const SUBAGENT_ID_LIMIT = 200;
const SUBAGENT_TASK_LIMIT = 1_000;
const SUBAGENT_ERROR_LIMIT = 1_000;
const SUBAGENT_OUTPUT_LIMIT = 1_000;
const SUBAGENT_ACTIVITY_LIMIT = 300;
const SUBAGENT_TREE_DEPTH_LIMIT = 5;
const SUBAGENT_ARRAY_ITEM_LIMIT = 64;
const SUBAGENT_GLOBAL_NODE_LIMIT = 128;
const SUBAGENT_NUMERIC_DETAIL_KEYS = ["startedAt", "durationMs", "toolCalls", "tokens"] as const;

interface SubagentProjectionBudget {
	remainingNodes: number;
}

export interface BoundedTextProjection {
	text: string;
	truncated: boolean;
}

export function projectToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
		return projectSubagentArgs(args);
	}
	if (!args) {
		return undefined;
	}

	const projected: Record<string, unknown> = {};
	switch (toolName) {
		case "bash":
			copyStringArg(args, projected, "command", TOOL_COMMAND_LIMIT);
			copyNumberArg(args, projected, "timeout");
			copyBooleanArg(args, projected, "background");
			break;
		case "jobs":
			copyStringArg(args, projected, "action");
			copyStringArg(args, projected, "id");
			copyStringArrayArg(args, projected, "ids");
			copyStringArg(args, projected, "mode");
			copyNumberArg(args, projected, "timeoutMs");
			break;
		case "read":
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "file_path");
			copyNumberArg(args, projected, "offset");
			copyNumberArg(args, projected, "limit");
			break;
		case "edit":
		case "write":
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "file_path");
			break;
		case "grep":
			copyStringArg(args, projected, "pattern");
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "glob");
			copyStringArg(args, projected, "include");
			copyStringArg(args, projected, "exclude");
			copyBooleanArg(args, projected, "ignoreCase");
			copyBooleanArg(args, projected, "literal");
			copyNumberArg(args, projected, "context");
			break;
		case "find":
			copyStringArg(args, projected, "query");
			copyStringArg(args, projected, "pattern");
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "glob");
			copyStringArg(args, projected, "name");
			copyNumberArg(args, projected, "limit");
			break;
		case "ls":
			copyStringArg(args, projected, "path");
			copyNumberArg(args, projected, "limit");
			break;
		case "lsp":
			copyStringArg(args, projected, "action");
			copyStringArg(args, projected, "symbol");
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "file_path");
			copyNumberArg(args, projected, "line");
			break;
		case "web_search":
			copyStringArg(args, projected, "query");
			copyStringArrayArg(args, projected, "domains");
			copyNumberArg(args, projected, "limit");
			copyNumberArg(args, projected, "recencyDays");
			break;
		case "web_fetch":
			copyStringArg(args, projected, "url");
			copyNumberArg(args, projected, "maxBytes");
			break;
		default:
			break;
	}

	return Object.keys(projected).length > 0 ? projected : undefined;
}

function copyStringArg(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	limit = TOOL_ARGUMENT_STRING_LIMIT,
): void {
	const value = getStringArg(from, key);
	if (value) {
		to[key] = boundText(value, limit);
	}
}

function copyNumberArg(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = getFiniteNumber(from, key);
	if (value !== undefined) {
		to[key] = value;
	}
}

function copyBooleanArg(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = from[key];
	if (typeof value === "boolean") {
		to[key] = value;
	}
}

function copyStringArrayArg(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = from[key];
	if (!Array.isArray(value)) {
		return;
	}
	const strings = value
		.map((item) => (typeof item === "string" ? boundText(item, TOOL_ARGUMENT_STRING_LIMIT) : undefined))
		.filter((item): item is string => item !== undefined && item.trim().length > 0)
		.slice(0, TOOL_ARGUMENT_KEYS_LIMIT);
	if (strings.length > 0) {
		to[key] = strings;
	}
}

function projectSubagentArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const budget: SubagentProjectionBudget = { remainingNodes: SUBAGENT_GLOBAL_NODE_LIMIT };
	const agent = getStringArg(args, "agent");
	if (agent) {
		projected.agent = boundSummary(agent, SUBAGENT_AGENT_LIMIT);
	}
	const task = getStringArg(args, "task");
	if (task) {
		projected.task = boundText(task, SUBAGENT_TASK_LIMIT);
	}
	const tasks = projectSubagentInputArray(args.tasks, budget);
	if (tasks) {
		projected.tasks = tasks;
	}
	const chain = projectSubagentInputArray(args.chain, budget);
	if (chain) {
		projected.chain = chain;
	}
	copyBooleanArg(args, projected, "background");
	copyBooleanArg(args, projected, "list");
	copyNumberArg(args, projected, "cursor");
	copyStringArg(args, projected, "follow", SUBAGENT_ID_LIMIT);
	copyStringArg(args, projected, "resume", SUBAGENT_ID_LIMIT);
	// The one-time confirm token is consumed by the call and omitted here, as
	// in the daemon and iroh projections.
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentInputArray(
	value: unknown,
	budget: SubagentProjectionBudget,
): Record<string, string>[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected: Record<string, string>[] = [];
	for (
		let index = 0;
		index < value.length && index < SUBAGENT_ARRAY_ITEM_LIMIT && budget.remainingNodes > 0;
		index++
	) {
		budget.remainingNodes--;
		const item = value[index];
		if (!isRecord(item)) continue;
		const agent = getStringArg(item, "agent");
		const task = getStringArg(item, "task");
		if (!agent || !task) continue;
		projected.push({
			agent: boundSummary(agent, SUBAGENT_AGENT_LIMIT),
			task: boundText(task, SUBAGENT_TASK_LIMIT),
		});
	}
	return projected.length > 0 ? projected : undefined;
}

export function projectSubagentDetails(
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const budget: SubagentProjectionBudget = { remainingNodes: SUBAGENT_GLOBAL_NODE_LIMIT };
	copyBoundedString(details, projected, "mode", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(details, projected, "status", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(details, projected, "subagentId", SUBAGENT_ID_LIMIT);
	copyBoundedString(details, projected, "sessionId", SUBAGENT_ID_LIMIT);
	for (const key of SUBAGENT_NUMERIC_DETAIL_KEYS) {
		const numberValue = getFiniteNumber(details, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	copyBoundedString(details, projected, "currentActivity", SUBAGENT_ACTIVITY_LIMIT);
	const summary = projectSubagentSummary(details.summary);
	if (summary) {
		projected.summary = summary;
	}
	const childSessions = projectSubagentDetailArray(details.childSessions, budget);
	if (childSessions) {
		projected.childSessions = childSessions;
	}
	const agent = projectSubagentAgent(details.agent);
	if (agent) {
		projected.agent = agent;
	}
	const output = projectSubagentOutput(details.output);
	if (output) {
		projected.output = output;
	}
	const error = projectSubagentError(details.error);
	if (error) {
		projected.error = error;
	}
	const children = projectSubagentDetailArray(details.children, budget);
	if (children) {
		projected.children = children;
	}
	const tasks = projectSubagentDetailArray(details.tasks, budget);
	if (tasks) {
		projected.tasks = tasks;
	}
	const steps = projectSubagentDetailArray(details.steps, budget);
	if (steps) {
		projected.steps = steps;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentSummary(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, number> = {};
	for (const key of [
		"total",
		"completed",
		"failed",
		"aborted",
		"running",
		"maxTasks",
		"maxConcurrency",
		"stoppedAt",
		"returned",
		"nextCursor",
		"omittedTasks",
	]) {
		const numberValue = getFiniteNumber(value, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentDetailArray(
	value: unknown,
	budget: SubagentProjectionBudget,
	depth = 0,
): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value) || depth >= SUBAGENT_TREE_DEPTH_LIMIT) {
		return undefined;
	}
	const projected: Record<string, unknown>[] = [];
	for (
		let index = 0;
		index < value.length && index < SUBAGENT_ARRAY_ITEM_LIMIT && budget.remainingNodes > 0;
		index++
	) {
		budget.remainingNodes--;
		const item = value[index];
		if (!isRecord(item)) continue;
		const task = projectSubagentTaskDetails(item, budget, depth);
		if (task) projected.push(task);
	}
	return projected.length > 0 ? projected : undefined;
}

function projectSubagentTaskDetails(
	item: Record<string, unknown>,
	budget: SubagentProjectionBudget,
	depth = 0,
): Record<string, unknown> | undefined {
	const projected: Record<string, unknown> = {};
	const index = getFiniteNumber(item, "index");
	if (index !== undefined) {
		projected.index = index;
	}
	copyBoundedString(item, projected, "subagentId", SUBAGENT_ID_LIMIT);
	copyBoundedString(item, projected, "sessionId", SUBAGENT_ID_LIMIT);
	const agent = projectSubagentAgent(item.agent);
	if (agent) {
		projected.agent = agent;
	}
	copyBoundedString(item, projected, "status", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(item, projected, "task", SUBAGENT_TASK_LIMIT);
	for (const key of SUBAGENT_NUMERIC_DETAIL_KEYS) {
		const numberValue = getFiniteNumber(item, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	copyBoundedString(item, projected, "currentActivity", SUBAGENT_ACTIVITY_LIMIT);
	const error = projectSubagentError(item.error);
	if (error) {
		projected.error = error;
	}
	const children = projectSubagentDetailArray(item.children, budget, depth + 1);
	if (children) {
		projected.children = children;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentAgent(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, string> = {};
	const name = getStringArg(value, "name");
	if (name) {
		projected.name = boundSummary(name, SUBAGENT_AGENT_LIMIT);
	}
	const source = getStringArg(value, "source");
	if (source) {
		projected.source = boundSummary(source, SUBAGENT_AGENT_LIMIT);
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentOutput(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const text = getStringArg(value, "text");
	if (text) {
		projected.text = boundText(text, SUBAGENT_OUTPUT_LIMIT);
	}
	for (const key of ["bytes", "omittedBytes", "maxBytes"]) {
		const numberValue = getFiniteNumber(value, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	const truncated = value.truncated;
	if (typeof truncated === "boolean") {
		projected.truncated = truncated;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentError(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const message = getStringArg(value, "message");
	return message ? { message: boundText(message, SUBAGENT_ERROR_LIMIT) } : undefined;
}

function copyBoundedString(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	limit: number,
): void {
	const value = getStringArg(from, key);
	if (value) {
		to[key] = boundText(value, limit);
	}
}

function getFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function summarizeToolResult(
	toolName: string,
	status: "completed" | "failed",
	args: Record<string, unknown> | undefined,
	path: string | undefined,
): BoundedTextProjection {
	const statusText = status === "failed" ? "failed" : "completed";
	const target = path ? ` ${path}` : "";
	if (toolName === "read") {
		return boundSummaryWithMetadata(`Read${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "edit") {
		return boundSummaryWithMetadata(`Edited${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "write") {
		return boundSummaryWithMetadata(`Wrote${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "bash") {
		const command = getStringArg(args, "command");
		const boundedCommand = command ? boundSummaryWithMetadata(command, TOOL_COMMAND_LIMIT) : undefined;
		const summary = boundSummaryWithMetadata(
			boundedCommand ? `Ran command: ${boundedCommand.text} (${statusText})` : `Ran command (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
		return { text: summary.text, truncated: summary.truncated || boundedCommand?.truncated === true };
	}
	if (toolName === "web_search") {
		const query = getStringArg(args, "query");
		const boundedQuery = query ? boundSummaryWithMetadata(query, TOOL_COMMAND_LIMIT) : undefined;
		const summary = boundSummaryWithMetadata(
			boundedQuery ? `Searched web for ${boundedQuery.text} (${statusText})` : `Searched web (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
		return { text: summary.text, truncated: summary.truncated || boundedQuery?.truncated === true };
	}
	if (toolName === "web_fetch") {
		const url = getStringArg(args, "url");
		const boundedUrl = url ? boundSummaryWithMetadata(url, TOOL_COMMAND_LIMIT) : undefined;
		const summary = boundSummaryWithMetadata(
			boundedUrl ? `Fetched ${boundedUrl.text} (${statusText})` : `Fetched URL (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
		return { text: summary.text, truncated: summary.truncated || boundedUrl?.truncated === true };
	}
	if (toolName === "grep") {
		const pattern = getStringArg(args, "pattern");
		const patternText = pattern ? ` for ${pattern}` : "";
		return boundSummaryWithMetadata(
			`Searched${target || " workspace"}${patternText} (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	if (toolName === "find") {
		const query = getStringArg(args, "query") ?? getStringArg(args, "pattern");
		const queryText = query ? ` for ${query}` : "";
		return boundSummaryWithMetadata(`Found files${target}${queryText} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "ls") {
		return boundSummaryWithMetadata(`Listed${target || " directory"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "lsp") {
		const action = getStringArg(args, "action");
		return boundSummaryWithMetadata(
			action ? `Ran lsp ${action}${target} (${statusText})` : `Ran lsp${target} (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	return boundSummaryWithMetadata(`${toolName} ${statusText}`, TOOL_SUMMARY_LIMIT);
}

export function getToolPath(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	return getStringArg(args, "path") ?? getStringArg(args, "file_path") ?? getStringArg(args, `${toolName}Path`);
}

export function getStringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function getBoundedString(
	record: Record<string, unknown> | undefined,
	key: string,
	limit: number,
): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? boundText(value, limit) : undefined;
}

export function boundSummaryWithMetadata(text: string, limit: number): BoundedTextProjection {
	return boundTextWithMetadata(text.replace(/\s+/g, " ").trim(), limit);
}

function boundSummary(text: string, limit: number): string {
	return boundSummaryWithMetadata(text, limit).text;
}

export function boundTextWithMetadata(text: string, limit: number): BoundedTextProjection {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, Math.max(0, limit - 16)).trimEnd()}\n[truncated]`,
		truncated: true,
	};
}

export function boundText(text: string, limit: number): string {
	return boundTextWithMetadata(text, limit).text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
