/**
 * What a conversation runs with, for clients in the host's trust domain: where
 * its log lives (`conversation_info`), the resources it loaded (`resources`),
 * and its tools (`tools`). These results hold host paths; only local profiles
 * read them.
 */

import { type Static, Type } from "typebox";
import { LogSessionIdSchema } from "./entries.ts";
import { ExtensionIdSchema } from "./extensions.ts";
import { stringEnum } from "./helpers.ts";

const closed = { additionalProperties: false } as const;

/** Where a conversation's log lives, and the project it runs in. */
export const ConversationInfoSchema = Type.Object(
	{
		id: LogSessionIdSchema,
		cwd: Type.String(),
		/** Whether the project at `cwd` is trusted: its `.volt` settings, resources, and packages load. */
		projectTrusted: Type.Boolean(),
		/** The session directory the log is stored in, or would be. */
		sessionDir: Type.String(),
		/** The session store's database file; absent for a log that is not stored. */
		sessionFile: Type.Optional(Type.String()),
		/** Whether the log is stored. */
		persisted: Type.Boolean(),
		/** Whether `sessionDir` is the cwd's default session directory: a resume command names it otherwise. */
		defaultSessionDir: Type.Boolean(),
		/** The session the conversation was started from. */
		parentSessionId: Type.Optional(Type.String()),
	},
	closed,
);
export type ConversationInfo = Static<typeof ConversationInfoSchema>;

/** Where a resource came from: a package or a top-level file, in a user, project, or temporary scope. */
export const ResourceSourceSchema = Type.Object(
	{
		/** `local`, `npm:<package>`, `git:<url>`, or an SDK label. */
		source: Type.String(),
		scope: stringEnum(["user", "project", "temporary"]),
		origin: stringEnum(["package", "top-level"]),
		/** The package root a package resource's path is relative to. */
		baseDir: Type.Optional(Type.String()),
	},
	closed,
);
export type ResourceSource = Static<typeof ResourceSourceSchema>;

/** A skill or prompt template: its name, its file, and where it came from. */
export const NamedResourceSchema = Type.Object(
	{
		name: Type.String(),
		path: Type.String(),
		description: Type.Optional(Type.String()),
		source: Type.Optional(ResourceSourceSchema),
	},
	closed,
);
export type NamedResource = Static<typeof NamedResourceSchema>;

/** A theme; a built-in theme has no file. */
export const ThemeResourceSchema = Type.Object(
	{ name: Type.String(), path: Type.Optional(Type.String()), source: Type.Optional(ResourceSourceSchema) },
	closed,
);

/** A running extension: its manifest id and the module, directory, or package it loaded from. */
export const ExtensionResourceSchema = Type.Object(
	{ id: ExtensionIdSchema, path: Type.String(), source: Type.Optional(ResourceSourceSchema) },
	closed,
);

/**
 * A problem loading resources: a conflict between two resources of one name
 * (`collision`, naming the one that won), or a resource that failed to load
 * or register, such as an extension that failed or a command it could not
 * register.
 */
export const ResourceDiagnosticSchema = Type.Object(
	{
		resource: stringEnum(["skill", "prompt", "theme", "extension"]),
		type: stringEnum(["warning", "error", "collision"]),
		message: Type.String(),
		path: Type.Optional(Type.String()),
		collision: Type.Optional(
			Type.Object(
				{
					name: Type.String(),
					winnerPath: Type.String(),
					loserPath: Type.String(),
					winnerSource: Type.Optional(Type.String()),
					loserSource: Type.Optional(Type.String()),
				},
				closed,
			),
		),
	},
	closed,
);
export type ResourceDiagnostic = Static<typeof ResourceDiagnosticSchema>;

/** Something the conversation's setup tells the user: a model fallback, a `models.json` error, a startup warning. */
export const ResourceNoticeSchema = Type.Object(
	{ level: stringEnum(["info", "warning", "error"]), message: Type.String() },
	closed,
);
export type ResourceNotice = Static<typeof ResourceNoticeSchema>;

/** The resources a conversation loaded, refetched on `changed{resources}`. */
export const ResourcesSchema = Type.Object(
	{
		skills: Type.Array(NamedResourceSchema),
		promptTemplates: Type.Array(NamedResourceSchema),
		themes: Type.Array(ThemeResourceSchema),
		extensions: Type.Array(ExtensionResourceSchema),
		/** The context files (AGENTS.md and the like) the system prompt includes. */
		contextFiles: Type.Array(Type.Object({ path: Type.String() }, closed)),
		diagnostics: Type.Array(ResourceDiagnosticSchema),
		notices: Type.Array(ResourceNoticeSchema),
	},
	closed,
);
export type Resources = Static<typeof ResourcesSchema>;

/** One tool the conversation can offer the model, and whether it does now. */
export const ToolSummarySchema = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
		/** `builtin`, `custom` (an SDK tool), or the scope and source of the extension that registered it. */
		source: Type.String(),
		active: Type.Boolean(),
	},
	closed,
);
export type ToolSummary = Static<typeof ToolSummarySchema>;
