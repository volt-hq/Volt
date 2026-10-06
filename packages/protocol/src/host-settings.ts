/**
 * The host's own settings, model scope, language servers, diagnostics, and
 * provider credentials, as clients read and change them.
 *
 * Settings belong to the side that reads them: the settings the host reads
 * change through `set_settings` (a closed set of keys) and the other host
 * intents, and each client writes its own display settings. Credentials are
 * never settings: they change only through `auth.login` and `auth.logout`,
 * whose prompts reach only the client that invoked them (`provider_auth` and
 * `input{secret}` host requests).
 */

import { type Static, Type } from "typebox";
import { ClientModelRefSchema } from "./client-fold.ts";
import { stringEnum } from "./helpers.ts";
import { RpcThinkingLevelSchema } from "./primitives.ts";

const closed = { additionalProperties: false } as const;

/** The built-in system prompt personalities. */
export const RpcPersonalitySchema = stringEnum(["default", "pragmatic", "simplified-technical"]);

/** How provider requests travel: `auto` lets each provider choose. */
export const RpcTransportSchema = stringEnum(["sse", "websocket", "websocket-cached", "auto"]);

/** Longest prompt-cache keepalive idle window `set_settings` accepts, in minutes. */
export const PROMPT_CACHE_KEEPALIVE_MAX_MINUTES = 1_440;

/** Longest HTTP idle timeout `set_settings` accepts, in milliseconds. */
export const HTTP_IDLE_TIMEOUT_MAX_MS = 86_400_000;

/** A model reference, `provider/modelId`. */
const modelReference = Type.String({ minLength: 3, maxLength: 512, pattern: "^[^/\\s]+/\\S+$" });

/**
 * The settings the host reads that `set_settings` changes, each optional. They
 * save where the host keeps them: globally, in the active settings profile
 * for the keys a profile holds.
 */
export const HostSettingsValuesSchema = Type.Object(
	{
		personality: Type.Optional(RpcPersonalitySchema),
		transport: Type.Optional(RpcTransportSchema),
		/** The model reviews discover findings with; null uses the conversation's model. */
		reviewModel: Type.Optional(Type.Union([modelReference, Type.Null()])),
		/** `off`, or minutes to keep refreshing a prompt cache after work finishes (0: only while working). */
		promptCacheKeepAlive: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Number({ minimum: 0, maximum: PROMPT_CACHE_KEEPALIVE_MAX_MINUTES })]),
		),
		imageAutoResize: Type.Optional(Type.Boolean()),
		blockImages: Type.Optional(Type.Boolean()),
		/** HTTP header and body idle timeout; 0 disables it. */
		httpIdleTimeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: HTTP_IDLE_TIMEOUT_MAX_MS })),
		enableInstallTelemetry: Type.Optional(Type.Boolean()),
	},
	{ ...closed, minProperties: 1 },
);
export type HostSettingsValues = Static<typeof HostSettingsValuesSchema>;

/** A model of a cycle scope, with the thinking level the scope gives it. */
export const ScopedModelSchema = Type.Object(
	{ ...ClientModelRefSchema.properties, thinkingLevel: Type.Optional(RpcThinkingLevelSchema) },
	closed,
);
export type ScopedModel = Static<typeof ScopedModelSchema>;

// ============================================================================
// Language servers
// ============================================================================

/** One configured language server, as the host's LSP manager reports it. */
export const LspServerStatusSchema = Type.Object(
	{
		name: Type.String(),
		/** The session's project directory: the command and trace base. */
		workspaceRoot: Type.String(),
		/** The project root the server was initialized with, possibly outside `workspaceRoot`. */
		root: Type.String(),
		alive: Type.Boolean(),
		openDocuments: Type.Integer({ minimum: 0 }),
		/** Milliseconds since the server was last used. */
		idleMs: Type.Number({ minimum: 0 }),
		resolvedExecutable: Type.Optional(Type.String()),
		unresolvedCommand: Type.Optional(Type.String()),
		launchSource: stringEnum(["absolute", "project-relative", "path", "toolchain"]),
		attempts: Type.Integer({ minimum: 0 }),
		lastError: Type.Optional(Type.String()),
		state: Type.Optional(
			stringEnum(["unused", "disabled", "starting", "ready", "degraded", "failed", "blocked", "idle"]),
		),
		version: Type.Optional(Type.String()),
		serverInfo: Type.Optional(Type.Object({ name: Type.String(), version: Type.Optional(Type.String()) }, closed)),
		capabilities: Type.Optional(Type.Array(Type.String())),
		lastSuccess: Type.Optional(Type.String()),
		lastFailure: Type.Optional(Type.String()),
		requestError: Type.Optional(Type.String()),
		startupStderr: Type.Optional(Type.String()),
		breaker: Type.Optional(stringEnum(["closed", "open"])),
		operations: Type.Optional(Type.Integer({ minimum: 0 })),
		failures: Type.Optional(Type.Integer({ minimum: 0 })),
		totalDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
		lastDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
		coverage: Type.Optional(Type.String()),
		projectContext: Type.Optional(
			stringEnum(["build-server-detected", "swiftpm-detected", "not-detected", "unknown"]),
		),
	},
	closed,
);

/** The conversation's language servers: a snapshot, which starts and installs nothing. */
export const LspStatusSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		workspaceRoot: Type.Optional(Type.String()),
		servers: Type.Array(LspServerStatusSchema),
		/** Where protocol traffic is traced, while tracing is on. */
		traceFile: Type.Optional(Type.String()),
	},
	closed,
);

// ============================================================================
// Provider credentials
// ============================================================================

/** How `auth.login` signs in: a provider subscription (OAuth), or an API key the user enters. */
export const ProviderAuthMethodSchema = stringEnum(["oauth", "api_key"]);
export type ProviderAuthMethod = Static<typeof ProviderAuthMethodSchema>;

/**
 * Where a provider's credentials come from: `stored` by a login, a `runtime`
 * key given at startup, the `environment`, a `fallback` resolver, or
 * `models.json` (a key, or a command that prints one).
 */
export const ProviderAuthSourceSchema = stringEnum([
	"stored",
	"runtime",
	"environment",
	"fallback",
	"models_json_key",
	"models_json_command",
]);

/** A provider a client may sign in to or out of; never its credentials. */
export const AuthProviderSchema = Type.Object(
	{
		id: Type.String(),
		/** The provider's display name. */
		name: Type.String(),
		/** Whether `auth.login` signs in with the provider's subscription. */
		oauth: Type.Boolean(),
		/** Whether `auth.login` takes an API key for it. */
		apiKey: Type.Boolean(),
		/** Whether requests to it are authenticated now. */
		configured: Type.Boolean(),
		source: Type.Optional(ProviderAuthSourceSchema),
		/** What names the source, such as the environment variable; never a secret. */
		label: Type.Optional(Type.String()),
		/** How stored credentials sign in; only stored ones `auth.logout` removes. */
		stored: Type.Optional(ProviderAuthMethodSchema),
	},
	closed,
);
export type AuthProvider = Static<typeof AuthProviderSchema>;
