import {
	IROH_REMOTE_ALPN,
	IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS,
	IROH_REMOTE_HANDSHAKE_TYPE,
	IROH_REMOTE_HELLO_TYPE,
	IROH_REMOTE_HELLO_WIRE_SCHEMAS,
	IROH_REMOTE_SESSION_ID_PATTERN_SOURCE,
	type IrohRemoteConversationHandshakeMetadata,
	type IrohRemoteConversationTarget,
	type IrohRemoteHandshakeFailure,
	IrohRemoteHandshakeFailureSchema,
	type IrohRemoteHandshakeResponse,
	type IrohRemoteHandshakeSuccess,
	IrohRemoteHandshakeSuccessSchema,
	type IrohRemoteHello,
	type IrohRemoteHostHandshakeFailureOutcome,
	type IrohRemoteHostHandshakeMetadata,
	type IrohRemoteWorkspaceDiscoveryTarget,
	IrohRemoteWorkspaceDiscoveryTargetSchema,
	type IrohRemoteWorkspaceManagementTarget,
	IrohRemoteWorkspaceManagementTargetSchema,
} from "@hansjm10/volt-protocol/remote-handshake";
import { IrohRemoteWorkspaceNameSchema } from "@hansjm10/volt-protocol/workspace";
import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import {
	IROH_REMOTE_CONVERSATION_STREAMS_FEATURE,
	IROH_REMOTE_MULTI_STREAMS_FEATURE,
	IrohRemoteOutcomeError,
	isIrohRemoteWorkingDirectory,
} from "./protocol.ts";

export type {
	IrohRemoteConversationHandshakeMetadata,
	IrohRemoteConversationSelection,
	IrohRemoteConversationTarget,
	IrohRemoteHandshakeFailure,
	IrohRemoteHandshakeResponse,
	IrohRemoteHandshakeSuccess,
	IrohRemoteHello,
	IrohRemoteHostHandshakeMetadata,
	IrohRemoteWorkspaceDiscoveryTarget,
	IrohRemoteWorkspaceManagementTarget,
} from "@hansjm10/volt-protocol/remote-handshake";

export type IrohRemoteHelloMode =
	| { mode: "conversation"; conversation: IrohRemoteConversationTarget }
	| { mode: "workspaceDiscovery"; workspaceDiscovery: IrohRemoteWorkspaceDiscoveryTarget }
	| { mode: "workspaceManagement"; workspaceManagement: IrohRemoteWorkspaceManagementTarget };

export const IROH_REMOTE_SESSION_ID_PATTERN = new RegExp(IROH_REMOTE_SESSION_ID_PATTERN_SOURCE);

export class IrohRemoteHandshakeError extends Error {
	readonly outcome: IrohRemoteHostHandshakeFailureOutcome;

	constructor(outcome: IrohRemoteHostHandshakeFailureOutcome, message: string) {
		super(message);
		this.name = "IrohRemoteHandshakeError";
		this.outcome = outcome;
	}
}

// ============================================================================
// Compiled contract validators
// ============================================================================

const STREAM_MODES = ["conversation", "workspaceDiscovery", "workspaceManagement"] as const;
type StreamMode = (typeof STREAM_MODES)[number];

function compileHandshakeValidators() {
	return {
		workspaceName: Compile(IrohRemoteWorkspaceNameSchema),
		hello: {
			conversation: Compile(IROH_REMOTE_HELLO_WIRE_SCHEMAS.conversation),
			workspaceDiscovery: Compile(IROH_REMOTE_HELLO_WIRE_SCHEMAS.workspaceDiscovery),
			workspaceManagement: Compile(IROH_REMOTE_HELLO_WIRE_SCHEMAS.workspaceManagement),
		},
		conversationTarget: {
			last: Compile(IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS.last),
			new: Compile(IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS.new),
			session: Compile(IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS.session),
		} as Record<string, Validator>,
		workspaceTarget: {
			workspaceDiscovery: Compile(IrohRemoteWorkspaceDiscoveryTargetSchema),
			workspaceManagement: Compile(IrohRemoteWorkspaceManagementTargetSchema),
		},
		success: Compile(IrohRemoteHandshakeSuccessSchema),
		failure: Compile(IrohRemoteHandshakeFailureSchema),
	};
}

let handshakeValidators: ReturnType<typeof compileHandshakeValidators> | undefined;

/** Compiled on first use, so processes that never see a handshake do not pay for them. */
function getHandshakeValidators(): ReturnType<typeof compileHandshakeValidators> {
	handshakeValidators ??= compileHandshakeValidators();
	return handshakeValidators;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single stream-mode key present, or undefined when none or several are. */
function getSingleStreamMode(value: Record<string, unknown>): StreamMode | undefined {
	const modes = STREAM_MODES.filter((mode) => value[mode] !== undefined);
	return modes.length === 1 ? modes[0] : undefined;
}

/**
 * Phrases the first schema violation as `<label> <field> must <expected>`,
 * reading the expectation from the violated schema's `x-volt-expected`. A
 * field that must be absent is named under `absentLabel`.
 */
function describeSchemaError(validator: Validator, value: unknown, label: string, absentLabel = label): string {
	const error: TLocalizedValidationError | undefined = validator.Errors(value)[0];
	if (error === undefined) {
		return `${label} is invalid`;
	}
	const segments = error.instancePath === "" ? [] : error.instancePath.slice(1).split("/");
	const params = error.params as Record<string, unknown>;
	if (error.keyword === "additionalProperties") {
		const [field] = params.additionalProperties as string[];
		return `${[label, ...segments].join(" ")} has unexpected field ${field}`;
	}
	if (error.keyword === "required") {
		const [field] = params.requiredProperties as string[];
		segments.push(field);
	}
	if (error.keyword === "not") {
		const field = segments.pop();
		return `${[absentLabel, ...segments].join(" ")} must not include ${field}`;
	}
	const expected = findExpectedPhrase(validator.Type(), segments) ?? "be valid";
	return `${[label, ...segments].join(" ")} must ${expected}`;
}

function findExpectedPhrase(schema: TSchema, segments: readonly string[]): string | undefined {
	let node: Record<string, unknown> | undefined = schema as Record<string, unknown>;
	for (const segment of segments) {
		const properties = node?.properties as Record<string, Record<string, unknown>> | undefined;
		if (properties !== undefined && Object.hasOwn(properties, segment)) {
			node = properties[segment];
		} else if (node?.items !== undefined && /^\d+$/.test(segment)) {
			node = node.items as Record<string, unknown>;
		} else {
			return undefined;
		}
	}
	const expected = node?.["x-volt-expected"];
	return typeof expected === "string" ? expected : undefined;
}

// ============================================================================
// Hello
// ============================================================================

export function parseIrohRemoteHelloLine(line: string): IrohRemoteHello {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		throw new IrohRemoteHandshakeError(
			"invalid_conversation_target",
			`Failed to parse Iroh remote handshake: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseIrohRemoteHello(parsed);
}

/**
 * Admit a phone hello against the contract schema for its stream mode. A
 * rejection names the first failing stage in a fixed order: envelope,
 * workspace (`invalid_workspace`), stream mode and target
 * (`invalid_conversation_target`), then the optional client strings.
 */
export function parseIrohRemoteHello(value: unknown): IrohRemoteHello {
	if (!isRecord(value)) {
		throw rejectIrohRemoteHello(value, undefined);
	}
	const mode = getSingleStreamMode(value);
	const validators = getHandshakeValidators().hello;
	// Targets are closed objects, so a shallow copy holds only declared fields.
	if (
		mode === "conversation" &&
		validators.conversation.Check(value) &&
		isWithinWorkingDirectoryBudget(value.conversation)
	) {
		return { ...readHelloEnvelope(value), mode, conversation: { ...value.conversation } };
	}
	if (mode === "workspaceDiscovery" && validators.workspaceDiscovery.Check(value)) {
		return { ...readHelloEnvelope(value), mode, workspaceDiscovery: { ...value.workspaceDiscovery } };
	}
	if (mode === "workspaceManagement" && validators.workspaceManagement.Check(value)) {
		return { ...readHelloEnvelope(value), mode, workspaceManagement: { ...value.workspaceManagement } };
	}
	throw rejectIrohRemoteHello(value, mode);
}

/** The known envelope fields of an admitted hello; unknown top-level fields are dropped. */
function readHelloEnvelope(hello: { workspace: string; secret?: string; clientLabel?: string; clientNodeId?: string }) {
	return {
		type: IROH_REMOTE_HELLO_TYPE,
		protocol: IROH_REMOTE_ALPN,
		workspace: hello.workspace,
		secret: hello.secret,
		clientLabel: hello.clientLabel,
		clientNodeId: hello.clientNodeId,
	} as const;
}

/** The working-directory UTF-16 and UTF-8 budgets JSON Schema cannot express. */
function isWithinWorkingDirectoryBudget(target: { workingDirectory?: string }): boolean {
	return target.workingDirectory === undefined || isIrohRemoteWorkingDirectory(target.workingDirectory);
}

function rejectIrohRemoteHello(value: unknown, mode: StreamMode | undefined): Error {
	if (!isRecord(value)) {
		return new Error("Iroh remote handshake must be an object");
	}
	if (value.type !== IROH_REMOTE_HELLO_TYPE) {
		return new Error("unexpected handshake type");
	}
	if (value.protocol !== IROH_REMOTE_ALPN) {
		return new Error(`unsupported protocol: ${typeof value.protocol === "string" ? value.protocol : "<missing>"}`);
	}
	if (!getHandshakeValidators().workspaceName.Check(value.workspace)) {
		return new IrohRemoteHandshakeError("invalid_workspace", describeWorkspaceName(value.workspace));
	}
	if (mode === undefined) {
		return new IrohRemoteHandshakeError(
			"invalid_conversation_target",
			"Iroh remote hello must include exactly one stream mode",
		);
	}
	const target = value[mode];
	if (!isRecord(target)) {
		return new IrohRemoteHandshakeError("invalid_conversation_target", `handshake ${mode} must be an object`);
	}
	const targetError = describeStreamTarget(mode, target);
	if (targetError !== undefined) {
		return new IrohRemoteHandshakeError("invalid_conversation_target", targetError);
	}
	return new Error(describeSchemaError(getHandshakeValidators().hello[mode], value, "handshake"));
}

function describeWorkspaceName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		return "handshake workspace must be a non-empty string";
	}
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) {
			return "handshake workspace must not contain ASCII control characters";
		}
	}
	return "handshake workspace exceeds maximum length";
}

/** Why a stream target fails its schema, or undefined when it is valid. */
function describeStreamTarget(mode: StreamMode, target: Record<string, unknown>): string | undefined {
	const label = `handshake ${mode}`;
	if (mode !== "conversation") {
		const validator = getHandshakeValidators().workspaceTarget[mode];
		return validator.Check(target) ? undefined : describeSchemaError(validator, target, label);
	}
	const kind = target.target;
	if (typeof kind !== "string" || kind.length === 0) {
		return "handshake conversation target must be a non-empty string";
	}
	const targets = getHandshakeValidators().conversationTarget;
	const validator = Object.hasOwn(targets, kind) ? targets[kind] : undefined;
	if (validator === undefined) {
		return "unsupported conversation target";
	}
	if (!validator.Check(target)) {
		return describeSchemaError(validator, target, label, `${label} ${kind} target`);
	}
	return isWithinWorkingDirectoryBudget(target)
		? undefined
		: "handshake conversation workingDirectory must be a relative POSIX path inside the workspace";
}

export function isIrohRemoteWorkspaceName(value: unknown): value is string {
	return getHandshakeValidators().workspaceName.Check(value);
}

export function isIrohRemoteSessionId(value: unknown): value is string {
	return typeof value === "string" && IROH_REMOTE_SESSION_ID_PATTERN.test(value);
}

// ============================================================================
// Handshake response
// ============================================================================

export function parseIrohRemoteHandshakeResponseLine(line: string): IrohRemoteHandshakeResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		throw new Error(
			`Failed to parse Iroh remote handshake response: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseIrohRemoteHandshakeResponse(parsed);
}

export function parseIrohRemoteHandshakeResponse(value: unknown): IrohRemoteHandshakeResponse {
	if (!isRecord(value)) {
		throw new Error("Iroh remote handshake response must be an object");
	}
	if (value.type !== IROH_REMOTE_HANDSHAKE_TYPE) {
		throw new Error("unexpected handshake response type");
	}
	if (value.success === true) {
		return parseIrohRemoteHandshakeSuccess(value);
	}
	if (value.success === false) {
		const failureValidator = getHandshakeValidators().failure;
		if (!failureValidator.Check(value)) {
			throw new Error(describeSchemaError(failureValidator, value, "handshake response"));
		}
		const failure: IrohRemoteHandshakeFailure = value;
		return {
			type: IROH_REMOTE_HANDSHAKE_TYPE,
			success: false,
			error: failure.error,
			...(failure.outcome === undefined ? {} : { outcome: failure.outcome }),
			...(failure.hostNodeId === undefined ? {} : { hostNodeId: failure.hostNodeId }),
			...(failure.workspace === undefined ? {} : { workspace: failure.workspace }),
			...(failure.sessionId === undefined ? {} : { sessionId: failure.sessionId }),
			...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
		};
	}
	throw new Error("handshake response success must be a boolean");
}

/**
 * Validate a success response against the contract schema, then the
 * cross-field rules the schema cannot state. `features` is advisory: a
 * malformed list reads as empty instead of failing the response.
 */
function parseIrohRemoteHandshakeSuccess(response: Record<string, unknown>): IrohRemoteHandshakeSuccess {
	const features = normalizeAdvisoryFeatures(response.features);
	const candidate = features === undefined ? response : { ...response, features };
	const successValidator = getHandshakeValidators().success;
	if (!successValidator.Check(candidate)) {
		throw new Error(describeSchemaError(successValidator, candidate, "handshake response"));
	}
	const success: IrohRemoteHandshakeSuccess = candidate;
	if (success.conversation !== undefined && !isWithinWorkingDirectoryBudget(success.conversation)) {
		throw new Error(
			"handshake response conversation workingDirectory must be a relative POSIX path inside the workspace",
		);
	}
	const modeMetadata = getHandshakeSuccessMode(success);
	if (modeMetadata !== undefined && success.hostNodeId === undefined) {
		throw new Error("handshake response hostNodeId is required for stream mode success");
	}
	assertRemoteHostMetadataMatchesHandshake(success.remoteHost, success);
	return {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: true,
		workspace: success.workspace,
		clientNodeId: success.clientNodeId,
		...(success.features === undefined ? {} : { features: [...success.features] }),
		...modeMetadata,
		...(success.remoteHost === undefined ? {} : { remoteHost: cloneRemoteHostHandshakeMetadata(success.remoteHost) }),
		child: success.child,
		...(success.hostNodeId === undefined ? {} : { hostNodeId: success.hostNodeId }),
	};
}

function normalizeAdvisoryFeatures(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
		? [...value]
		: [];
}

function getHandshakeSuccessMode(
	response: IrohRemoteHandshakeSuccess,
):
	| Pick<IrohRemoteHandshakeSuccess, "sessionId" | "conversation" | "workspaceDiscovery" | "workspaceManagement">
	| undefined {
	const modes = STREAM_MODES.filter((mode) => response[mode] !== undefined);
	if (modes.length === 0) {
		return undefined;
	}
	if (modes.length !== 1) {
		throw new Error("handshake response success must include exactly one stream mode");
	}
	if (
		!response.features?.includes(IROH_REMOTE_MULTI_STREAMS_FEATURE) ||
		!response.features.includes(IROH_REMOTE_CONVERSATION_STREAMS_FEATURE)
	) {
		throw new Error("handshake response features must include required Iroh remote stream features");
	}
	const [mode] = modes;
	if (mode === "conversation") {
		const conversation = response.conversation as IrohRemoteConversationHandshakeMetadata;
		if (response.sessionId === undefined) {
			throw new Error("handshake response sessionId must be a non-empty string");
		}
		if (conversation.sessionId !== response.sessionId) {
			throw new Error("handshake response conversation sessionId must match top-level sessionId");
		}
		assertConversationTargetSelection(conversation);
		return { sessionId: response.sessionId, conversation: { ...conversation } };
	}
	if (response.sessionId !== undefined) {
		throw new Error(`handshake response ${mode} must not include sessionId`);
	}
	return mode === "workspaceDiscovery"
		? { workspaceDiscovery: { ...(response.workspaceDiscovery as IrohRemoteWorkspaceDiscoveryTarget) } }
		: { workspaceManagement: { ...(response.workspaceManagement as IrohRemoteWorkspaceManagementTarget) } };
}

function assertConversationTargetSelection(conversation: IrohRemoteConversationHandshakeMetadata): void {
	if (conversation.target === "new" && conversation.selection !== "created" && conversation.selection !== "resumed") {
		throw new Error("handshake response new target must use created or resumed selection");
	}
	if (conversation.target === "session" && conversation.selection !== "resumed") {
		throw new Error("handshake response session target must use resumed selection");
	}
}

function assertRemoteHostMetadataMatchesHandshake(
	metadata: IrohRemoteHostHandshakeMetadata | undefined,
	response: { hostNodeId?: string; workspace: string },
): void {
	if (metadata === undefined) {
		return;
	}
	if (metadata.workspace !== response.workspace) {
		throw new Error("handshake response remoteHost workspace must match top-level workspace");
	}
	if (
		metadata.hostNodeId !== undefined &&
		response.hostNodeId !== undefined &&
		metadata.hostNodeId !== response.hostNodeId
	) {
		throw new Error("handshake response remoteHost hostNodeId must match top-level hostNodeId");
	}
}

export function createIrohRemoteHandshakeSuccess(options: {
	workspace: string;
	hostNodeId?: string;
	clientNodeId: string;
	features?: string[];
	sessionId?: string;
	conversation?: IrohRemoteConversationHandshakeMetadata;
	workspaceDiscovery?: IrohRemoteWorkspaceDiscoveryTarget;
	workspaceManagement?: IrohRemoteWorkspaceManagementTarget;
	remoteHost?: IrohRemoteHostHandshakeMetadata;
	child?: string;
}): IrohRemoteHandshakeSuccess {
	const response: IrohRemoteHandshakeSuccess = {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: true,
		workspace: options.workspace,
		...(options.hostNodeId === undefined ? {} : { hostNodeId: options.hostNodeId }),
		clientNodeId: options.clientNodeId,
		...(options.features === undefined ? {} : { features: [...options.features] }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		...(options.conversation === undefined ? {} : { conversation: { ...options.conversation } }),
		...(options.workspaceDiscovery === undefined ? {} : { workspaceDiscovery: { ...options.workspaceDiscovery } }),
		...(options.workspaceManagement === undefined ? {} : { workspaceManagement: { ...options.workspaceManagement } }),
		...(options.remoteHost === undefined ? {} : { remoteHost: cloneRemoteHostHandshakeMetadata(options.remoteHost) }),
		child: options.child,
	};
	return response;
}

export function createIrohRemoteHandshakeFailure(
	error: string,
	options: {
		hostNodeId?: string;
		outcome?: IrohRemoteHostHandshakeFailureOutcome;
		workspace?: string;
		sessionId?: string;
		retryAfterMs?: number;
	} = {},
): IrohRemoteHandshakeFailure {
	return {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: false,
		...(options.outcome === undefined ? {} : { outcome: options.outcome }),
		...(options.hostNodeId === undefined ? {} : { hostNodeId: options.hostNodeId }),
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
		error,
	};
}

export function assertIrohRemoteHandshakeHostIdentity(
	response: IrohRemoteHandshakeResponse,
	expectedHostNodeId: string | undefined,
): void {
	if (expectedHostNodeId === undefined) {
		return;
	}
	const actualHostNodeId = response.hostNodeId;
	if (actualHostNodeId !== expectedHostNodeId) {
		throw new IrohRemoteOutcomeError(
			"host_identity_mismatch",
			`expected ${expectedHostNodeId}, got ${actualHostNodeId ?? "<missing>"}`,
		);
	}
}

function cloneRemoteHostHandshakeMetadata(metadata: IrohRemoteHostHandshakeMetadata): IrohRemoteHostHandshakeMetadata {
	return {
		workspace: metadata.workspace,
		workspaceNames: [...metadata.workspaceNames],
		workspaces: metadata.workspaces.map((workspace) => ({ ...workspace })),
		features: [...metadata.features],
		...(metadata.hostNodeId === undefined ? {} : { hostNodeId: metadata.hostNodeId }),
		...(metadata.relayMode === undefined ? {} : { relayMode: metadata.relayMode }),
		...(metadata.relayUrls === undefined ? {} : { relayUrls: [...metadata.relayUrls] }),
		...(metadata.hostName === undefined ? {} : { hostName: metadata.hostName }),
		...(metadata.userName === undefined ? {} : { userName: metadata.userName }),
		cwd: metadata.cwd,
	};
}
