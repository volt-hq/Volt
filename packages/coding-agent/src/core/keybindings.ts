import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@hansjm10/volt-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.ts";

export interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.debug": true;
	"app.suspend": true;
	"app.mode.toggle": true;
	"app.plan.togglePane": true;
	"app.thinking.cycle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.tools.expand": true;
	"app.thinking.toggle": true;
	"app.session.toggleNamedFilter": true;
	"app.editor.external": true;
	"app.message.followUp": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.work.open": true;
	"app.work.cancel": true;
	"app.work.resume": true;
	"app.work.follow": true;
	"app.voice.toggle": true;
	"app.voice.mute": true;
	"app.voice.interrupt": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.tree.editLabel": true;
	"app.tree.toggleLabelTimestamp": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.models.save": true;
	"app.models.enableAll": true;
	"app.models.clearAll": true;
	"app.models.toggleProvider": true;
	"app.models.reorderUp": true;
	"app.models.reorderDown": true;
	"app.reviewTools.toggle": true;
	"app.questions.back": true;
	"app.questions.skip": true;
	"app.questions.notes": true;
	"app.questions.pageUp": true;
	"app.questions.pageDown": true;
	"app.tree.filter.default": true;
	"app.tree.filter.noTools": true;
	"app.tree.filter.userOnly": true;
	"app.tree.filter.labeledOnly": true;
	"app.tree.filter.all": true;
	"app.tree.filter.cycleForward": true;
	"app.tree.filter.cycleBackward": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@hansjm10/volt-tui" {
	interface Keybindings extends AppKeybindings {}
}

export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.debug": { defaultKeys: "f12", description: "Capture diagnostics without interrupting work" },
	"app.suspend": {
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: "Suspend to background",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+ctrl+t",
		description: "Cycle thinking level",
	},
	"app.mode.toggle": {
		defaultKeys: "shift+tab",
		description: "Toggle Build and Plan mode",
	},
	"app.plan.togglePane": {
		defaultKeys: "alt+p",
		description: "Switch focus between conversation and plan pane",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking blocks",
	},
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.followUp": {
		defaultKeys: "alt+enter",
		description: "Queue follow-up message",
	},
	"app.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Restore queued messages",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
		description: "Paste image from clipboard",
	},
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.work.open": { defaultKeys: "alt+j", description: "Open or close the work inspector" },
	"app.work.cancel": { defaultKeys: "ctrl+k", description: "Cancel the selected work (with confirmation)" },
	"app.work.resume": { defaultKeys: "ctrl+r", description: "Resume the selected suspended work" },
	"app.work.follow": { defaultKeys: "end", description: "Follow the latest work output" },
	"app.voice.toggle": { defaultKeys: [], description: "Start or stop voice" },
	"app.voice.mute": { defaultKeys: "alt+m", description: "Mute or unmute the voice microphone" },
	"app.voice.interrupt": { defaultKeys: "alt+s", description: "Stop what voice is saying" },
	"app.tree.foldOrUp": {
		defaultKeys: ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": {
		defaultKeys: "shift+l",
		description: "Edit tree label",
	},
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort mode",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	"app.models.save": {
		defaultKeys: "ctrl+s",
		description: "Save model selection",
	},
	"app.models.enableAll": {
		defaultKeys: "ctrl+a",
		description: "Enable all models",
	},
	"app.models.clearAll": {
		defaultKeys: "ctrl+x",
		description: "Clear all models",
	},
	"app.models.toggleProvider": {
		defaultKeys: "ctrl+p",
		description: "Toggle all models for provider",
	},
	"app.models.reorderUp": {
		defaultKeys: "alt+up",
		description: "Move model up in order",
	},
	"app.models.reorderDown": {
		defaultKeys: "alt+down",
		description: "Move model down in order",
	},
	"app.reviewTools.toggle": {
		defaultKeys: "space",
		description: "Toggle review tool selection",
	},
	"app.questions.back": {
		defaultKeys: "shift+tab",
		description: "Return to choices or the previous question, preserving drafts",
	},
	"app.questions.skip": {
		defaultKeys: "ctrl+s",
		description: "Skip the question request without providing answers",
	},
	"app.questions.notes": {
		defaultKeys: "ctrl+n",
		description: "Add notes to the highlighted answer",
	},
	"app.questions.pageUp": {
		defaultKeys: "ctrl+pageUp",
		description: "Scroll a long question or answer review up",
	},
	"app.questions.pageDown": {
		defaultKeys: "ctrl+pageDown",
		description: "Scroll a long question or answer review down",
	},
	"app.tree.filter.default": {
		defaultKeys: "ctrl+d",
		description: "Tree filter: default view",
	},
	"app.tree.filter.noTools": {
		defaultKeys: "ctrl+t",
		description: "Tree filter: hide tool results",
	},
	"app.tree.filter.userOnly": {
		defaultKeys: "ctrl+u",
		description: "Tree filter: user messages only",
	},
	"app.tree.filter.labeledOnly": {
		defaultKeys: "ctrl+l",
		description: "Tree filter: labeled entries only",
	},
	"app.tree.filter.all": {
		defaultKeys: "ctrl+a",
		description: "Tree filter: show all entries",
	},
	"app.tree.filter.cycleForward": {
		defaultKeys: "ctrl+o",
		description: "Tree filter: cycle forward",
	},
	"app.tree.filter.cycleBackward": {
		defaultKeys: "shift+ctrl+o",
		description: "Tree filter: cycle backward",
	},
} as const satisfies KeybindingDefinitions;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (!isRecord(value)) return {};

	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (typeof binding === "string") {
			config[key] = binding as KeyId;
			continue;
		}
		if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as KeyId[];
		}
	}
	return config;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export class KeybindingsManager extends TuiKeybindingsManager {
	private configPath: string | undefined;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.configPath = configPath;
	}

	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.loadFromFile(configPath);
		return new KeybindingsManager(userBindings, configPath);
	}

	reload(): void {
		if (!this.configPath) return;
		this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		const rawConfig = loadRawConfig(path);
		if (!rawConfig) return {};
		return toKeybindingsConfig(rawConfig);
	}
}

export type { Keybinding, KeyId, KeybindingsConfig };
