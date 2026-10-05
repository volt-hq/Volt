import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

/**
 * Slash aliases that invoke one intent, described as their intents are
 * (`intentRegistry.slashCommands()`; a test keeps the two equal).
 */
export const INTENT_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "fast", description: "Request premium low-latency inference capacity for the current session." },
	{ name: "name", description: "Set the current session display name" },
	{ name: "clear", description: "Start a new session" },
	{ name: "compact", description: "Summarize the current session context" },
];

function intentSlashCommand(name: string): BuiltinSlashCommand {
	const command = INTENT_SLASH_COMMANDS.find((candidate) => candidate.name === name);
	if (!command) throw new Error(`No intent has the slash alias /${name}`);
	return command;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "plan", description: "Switch the agent to read-only Plan mode" },
	{ name: "build", description: "Switch the agent to Build mode" },
	{ name: "plan-details", description: "Open the current structured plan" },
	{ name: "plan-close", description: "Close a completed or handed-off plan" },
	{ name: "profile", description: "Show, switch, or create the active settings profile" },
	{ name: "model", description: "Select model (opens selector UI)" },
	intentSlashCommand("fast"),
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import a JSONL snapshot as a new session" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	intentSlashCommand("name"),
	{ name: "session", description: "Show session info and stats" },
	{ name: "usage", description: "Show remaining subscription quota and reset times" },
	{ name: "lsp", description: "Show LSP server status (/lsp restart, /lsp trace [path|off])" },
	{ name: "mcp", description: "Show MCP server status (/mcp connect|disconnect|refresh <server>)" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "debug", description: "Capture diagnostics without interrupting work" },
	{ name: "remote", description: "Manage daemon status, phone pairing, and remote access" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "work", description: "Inspect work: jobs, subagents, reviews, and their output; cancel, open, or resume" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "worktree", description: "Open a new session in a daemon-managed git worktree (/worktree new [name])" },
	{ name: "store", description: "Search, inspect, install, remove, and update extension store packages" },
	{
		name: "extensions",
		description: "Show, enable, or disable extensions, edit their settings, and manage installed packages",
	},
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	intentSlashCommand("clear"),
	intentSlashCommand("compact"),
	{
		name: "review",
		description: "Review code (tools, uncommitted, branch, PR, commit); findings start a fresh session",
	},
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
