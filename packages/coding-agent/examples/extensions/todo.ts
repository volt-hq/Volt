/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos, presented with present()
 * - Registers a `/todos` command that shows or hides a panel with the list,
 *   kept current while the agent changes it
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@hansjm10/volt-ai";
import { defineManifest, type ExtensionAPI, type ExtensionContext } from "@hansjm10/volt-coding-agent";
import type { ToolPresentation, UiNode, UiNodeStyledText } from "@hansjm10/volt-protocol";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/** One todo as a styled line: a check, its id, and its text. */
function todoLine(todo: Todo): UiNodeStyledText {
	return [
		todo.done ? { text: "✓ ", token: "success" } : { text: "○ ", token: "muted" },
		{ text: `#${todo.id} `, token: "accent" },
		{ text: todo.text, token: todo.done ? "muted" : "text" },
	];
}

/** The todo list as UI data: progress, then one line per todo. */
function todoList(todos: Todo[]): UiNode {
	if (todos.length === 0) {
		return { type: "text", text: "No todos yet. Ask the agent to add some!", token: "muted" };
	}
	const done = todos.filter((t) => t.done).length;
	return {
		type: "list",
		items: [
			{
				type: "progress",
				key: "progress",
				kind: "determinate",
				value: done,
				max: todos.length,
				label: `${done}/${todos.length} completed`,
			},
			...todos.map((todo): UiNode => ({ type: "text", key: `todo-${todo.id}`, text: todoLine(todo) })),
		],
	};
}

export const manifest = defineManifest({
	id: "todo",
	displayName: "Todo",
	description: "Demonstrates state management via session entries.",
});

export default function (volt: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;
	let panelShown = false;

	/** Show the list in a panel (the sidebar in fullscreen, above the editor elsewhere), or remove it. */
	const showPanel = (ctx: ExtensionContext) => {
		ctx.ui.setPanel(
			"todos",
			panelShown ? { title: "Todos", placement: "sidebar", node: todoList(todos) } : undefined,
		);
	};

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	// Reconstruct state on session events
	volt.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		showPanel(ctx);
	});
	volt.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		showPanel(ctx);
	});

	// Keep the panel current while the agent changes the list
	volt.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "todo" && panelShown) showPanel(ctx);
	});

	// Register the todo tool for the LLM
	volt.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.done = !todo.done;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		present({ args, state, result }): ToolPresentation {
			const title: UiNodeStyledText = [
				{ text: "todo ", bold: true },
				{ text: args.action ?? "…", token: "muted" },
				...(args.text ? [{ text: ` "${args.text}"`, token: "muted" as const }] : []),
				...(args.id !== undefined ? [{ text: ` #${args.id}`, token: "accent" as const }] : []),
			];
			const details = result?.details as TodoDetails | undefined;
			if (state !== "done" || !details) return { title };
			if (details.error) {
				return { title, summary: [{ type: "text", text: `Error: ${details.error}`, token: "error" }] };
			}

			const list = details.todos;
			switch (details.action) {
				case "list": {
					if (list.length === 0) return { title, summary: [{ type: "text", text: "No todos", token: "muted" }] };
					const lines = (todos: Todo[]): UiNode[] =>
						todos.map((todo) => ({ type: "text", key: `todo-${todo.id}`, text: todoLine(todo) }));
					const count: UiNode = { type: "text", key: "count", text: `${list.length} todo(s):`, token: "muted" };
					return {
						title,
						summary: [
							count,
							...lines(list.slice(0, 5)),
							...(list.length > 5
								? [
										{
											type: "text" as const,
											key: "more",
											text: `... ${list.length - 5} more`,
											token: "muted" as const,
										},
									]
								: []),
						],
						...(list.length > 5 ? { body: [count, ...lines(list)] } : {}),
					};
				}
				case "add": {
					const added = list[list.length - 1];
					return {
						title,
						summary: [
							{
								type: "text",
								text: [
									{ text: "✓ Added ", token: "success" },
									{ text: `#${added.id} `, token: "accent" },
									{ text: added.text, token: "muted" },
								],
							},
						],
					};
				}
				case "toggle": {
					const message = (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
					return {
						title,
						summary: [
							{
								type: "text",
								text: [
									{ text: "✓ ", token: "success" },
									{ text: message, token: "muted" },
								],
							},
						],
					};
				}
				case "clear":
					return {
						title,
						summary: [
							{
								type: "text",
								text: [
									{ text: "✓ ", token: "success" },
									{ text: "Cleared all todos", token: "muted" },
								],
							},
						],
					};
			}
		},
	});

	// Register the /todos command for users: it shows or hides the list beside the conversation
	volt.registerCommand("todos", {
		description: "Show or hide the todos on the current branch",
		handler: async (_args, ctx) => {
			panelShown = !panelShown;
			showPanel(ctx);
		},
	});
}
