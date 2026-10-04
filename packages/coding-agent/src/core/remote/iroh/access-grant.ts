import {
	REMOTE_ACCESS_PRESET_CAPABILITIES,
	REMOTE_ACCESS_PRESET_NAMES,
	REMOTE_CAPABILITIES,
	REMOTE_GRANT_SCHEMA_VERSION,
	type RemoteAccessPresetName,
	type RemoteCapability,
	type RemoteGrant,
} from "@hansjm10/volt-protocol/remote-access";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS, normalizeIrohRemoteAllowTools } from "./protocol.ts";

// The protocol's remote-access vocabulary under the names the coding agent exports.
export const IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION = REMOTE_GRANT_SCHEMA_VERSION;
export const IROH_REMOTE_RPC_CAPABILITIES = REMOTE_CAPABILITIES;
export const IROH_REMOTE_ACCESS_PRESET_NAMES = REMOTE_ACCESS_PRESET_NAMES;
export type IrohRemoteRpcCapability = RemoteCapability;
export type IrohRemoteRpcGrant = RemoteGrant;
export type IrohRemoteAccessPresetName = RemoteAccessPresetName;

export interface IrohRemoteAccessPreset {
	readonly name: IrohRemoteAccessPresetName;
	readonly allowedTools: string;
	readonly capabilities: readonly IrohRemoteRpcCapability[];
}

export const IROH_REMOTE_ACCESS_PRESETS: Readonly<Record<IrohRemoteAccessPresetName, IrohRemoteAccessPreset>> =
	Object.freeze({
		coding: Object.freeze({
			name: "coding",
			allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			capabilities: REMOTE_ACCESS_PRESET_CAPABILITIES.coding,
		}),
		review: Object.freeze({
			name: "review",
			allowedTools: "read,grep,find,ls",
			capabilities: REMOTE_ACCESS_PRESET_CAPABILITIES.review,
		}),
		chat: Object.freeze({ name: "chat", allowedTools: "", capabilities: REMOTE_ACCESS_PRESET_CAPABILITIES.chat }),
		full: Object.freeze({
			name: "full",
			allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			capabilities: REMOTE_ACCESS_PRESET_CAPABILITIES.full,
		}),
	});

const CAPABILITY_SET = new Set<string>(IROH_REMOTE_RPC_CAPABILITIES);
const PRESET_NAME_SET = new Set<string>(IROH_REMOTE_ACCESS_PRESET_NAMES);

export function isIrohRemoteAccessPresetName(value: unknown): value is IrohRemoteAccessPresetName {
	return typeof value === "string" && PRESET_NAME_SET.has(value);
}

export function getIrohRemoteAccessPreset(name: IrohRemoteAccessPresetName): IrohRemoteAccessPreset {
	return IROH_REMOTE_ACCESS_PRESETS[name];
}

export function createIrohRemoteRpcGrant(
	capabilities: readonly IrohRemoteRpcCapability[],
	revision = 1,
): IrohRemoteRpcGrant {
	return parseIrohRemoteRpcGrant({
		schemaVersion: IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION,
		revision,
		capabilities: [...capabilities],
	});
}

export function createIrohRemotePresetAccess(
	name: IrohRemoteAccessPresetName,
	revision = 1,
): { allowedTools: string; rpcGrant: IrohRemoteRpcGrant } {
	const preset = getIrohRemoteAccessPreset(name);
	return {
		allowedTools: preset.allowedTools,
		rpcGrant: createIrohRemoteRpcGrant(preset.capabilities, revision),
	};
}

export function createIrohRemoteExplicitAccess(
	allowedTools: readonly string[],
	rpcCapabilities: readonly IrohRemoteRpcCapability[],
	revision = 1,
): { allowedTools: string; rpcGrant: IrohRemoteRpcGrant } {
	return {
		allowedTools: normalizeIrohRemoteAllowTools(allowedTools.join(",")),
		rpcGrant: createIrohRemoteRpcGrant(rpcCapabilities, revision),
	};
}

export function parseIrohRemoteRpcCapabilities(value: unknown, label = "rpc capabilities"): IrohRemoteRpcCapability[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	const capabilities: IrohRemoteRpcCapability[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !CAPABILITY_SET.has(entry)) {
			throw new Error(`${label} contains unknown capability: ${String(entry)}`);
		}
		if (seen.has(entry)) {
			throw new Error(`${label} must not contain duplicates: ${entry}`);
		}
		seen.add(entry);
		capabilities.push(entry as IrohRemoteRpcCapability);
	}
	return capabilities;
}

export function parseIrohRemoteRpcGrant(value: unknown, label = "rpc grant"): IrohRemoteRpcGrant {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const grant = value as Record<string, unknown>;
	if (grant.schemaVersion !== IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION) {
		throw new Error(`${label} schemaVersion must be ${IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION}`);
	}
	if (typeof grant.revision !== "number" || !Number.isSafeInteger(grant.revision) || grant.revision < 1) {
		throw new Error(`${label} revision must be a safe integer greater than or equal to 1`);
	}
	return {
		schemaVersion: IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION,
		revision: grant.revision,
		capabilities: parseIrohRemoteRpcCapabilities(grant.capabilities, `${label} capabilities`),
	};
}

export function cloneIrohRemoteRpcGrant(grant: IrohRemoteRpcGrant): IrohRemoteRpcGrant {
	return { schemaVersion: 1, revision: grant.revision, capabilities: [...grant.capabilities] };
}

export function getIrohRemoteStreamCapability(options: {
	mode: "conversation" | "workspaceDiscovery" | "workspaceManagement";
	purpose?: string;
}): IrohRemoteRpcCapability | undefined {
	if (options.mode === "conversation") return "conversation.observe.v1";
	if (options.mode === "workspaceDiscovery") {
		return options.purpose === "agent_options" ? "model.select.v1" : "conversation.observe.v1";
	}
	// Worktree management is command-sensitive: the stream itself has no wider
	// gate than each parsed command.
	if (options.purpose === "manage_worktrees") return undefined;
	if (options.purpose === "list_workspace_directories") return "conversation.observe.v1";
	if (options.purpose === "unregister_workspace") return "workspace.manage.v1";
	return undefined;
}

export function hasIrohRemoteRpcCapability(grant: IrohRemoteRpcGrant, capability: IrohRemoteRpcCapability): boolean {
	return grant.capabilities.includes(capability);
}
