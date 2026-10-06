/**
 * What a conversation runs with (local profiles only: every answer names
 * host paths): where its log lives, the resources it loaded and what loading
 * them reported, and its tools.
 */

import { join } from "node:path";
import type { NamedResource, ResourceDiagnostic, ResourceNotice, ResourceSource } from "@hansjm10/volt-protocol";
import type { ResourceDiagnostic as LoadedResourceDiagnostic } from "../../diagnostics.ts";
import {
	ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
	modelsJsonErrorText,
	usesAnthropicSubscription,
} from "../../host/host-notices.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "../../session-store/types.ts";
import type { SourceInfo } from "../../source-info.ts";
import { targetOf } from "../intents/conversation.ts";
import { defineQuery } from "./types.ts";

const observe = ["conversation.observe.v1"] as const;

function resourceSource(info: SourceInfo | undefined): { source?: ResourceSource } {
	if (info === undefined) return {};
	return {
		source: {
			source: info.source,
			scope: info.scope,
			origin: info.origin,
			...(info.baseDir === undefined ? {} : { baseDir: info.baseDir }),
		},
	};
}

function diagnosticsOf(
	resource: ResourceDiagnostic["resource"],
	diagnostics: readonly LoadedResourceDiagnostic[],
): ResourceDiagnostic[] {
	return diagnostics.map((diagnostic) => ({
		resource,
		type: diagnostic.type,
		message: diagnostic.message,
		...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
		...(diagnostic.collision === undefined
			? {}
			: {
					collision: {
						name: diagnostic.collision.name,
						winnerPath: diagnostic.collision.winnerPath,
						loserPath: diagnostic.collision.loserPath,
						...(diagnostic.collision.winnerSource === undefined
							? {}
							: { winnerSource: diagnostic.collision.winnerSource }),
						...(diagnostic.collision.loserSource === undefined
							? {}
							: { loserSource: diagnostic.collision.loserSource }),
					},
				}),
	}));
}

/** A tool's origin as a picker shows it: `builtin`, `custom` for an SDK tool, or `<scope>:<source>`. */
function toolSource(info: SourceInfo): string {
	const source = info.source.trim();
	if (source === "builtin") return "builtin";
	if (source === "sdk") return "custom";
	const prefix = info.scope === "user" ? "user" : info.scope === "project" ? "project" : "temporary";
	return source ? `${prefix}:${source}` : prefix;
}

export const conversationInfoQuery = defineQuery({
	name: "conversation_info",
	scope: "conversation",
	remote: "unsafe",
	requires: observe,
	async run(ctx) {
		const { session, conversation } = targetOf(ctx);
		const manager = session.sessionManager;
		const sessionDir = manager.getSessionDir();
		const persisted = manager.isPersisted();
		const parent = manager.getHeader()?.parentSession;
		return {
			id: conversation.id,
			cwd: conversation.cwd,
			sessionDir,
			...(persisted && sessionDir ? { sessionFile: join(sessionDir, SESSION_STORE_DATABASE_FILENAME) } : {}),
			persisted,
			defaultSessionDir: manager.usesDefaultSessionDir(),
			...(parent === undefined ? {} : { parentSessionId: parent.sessionId }),
		};
	},
});

export const resourcesQuery = defineQuery({
	name: "resources",
	scope: "conversation",
	remote: "unsafe",
	requires: observe,
	async run(ctx) {
		const { session, conversation } = targetOf(ctx);
		const loader = session.resourceLoader;
		const skills = loader.getSkills();
		const prompts = loader.getPrompts();
		const themes = loader.getThemes();
		const extensions = loader.getExtensions();
		const named = (name: string, path: string, description: string, info: SourceInfo): NamedResource => ({
			name,
			path,
			...(description ? { description } : {}),
			...resourceSource(info),
		});
		const notices: ResourceNotice[] = [];
		if (conversation.modelFallbackMessage) {
			notices.push({ level: "warning", message: conversation.modelFallbackMessage });
		}
		for (const diagnostic of conversation.diagnostics) {
			notices.push({ level: diagnostic.type, message: diagnostic.message });
		}
		const modelsError = session.modelRegistry.getError();
		if (modelsError !== undefined) notices.push({ level: "error", message: modelsJsonErrorText(modelsError) });
		if (await usesAnthropicSubscription(session, session.model)) {
			notices.push({ level: "warning", message: ANTHROPIC_SUBSCRIPTION_AUTH_WARNING });
		}
		return {
			skills: skills.skills.map((skill) => named(skill.name, skill.filePath, skill.description, skill.sourceInfo)),
			promptTemplates: session.promptTemplates.map((template) =>
				named(template.name, template.filePath, template.description, template.sourceInfo),
			),
			themes: themes.themes.flatMap((theme) =>
				theme.name === undefined
					? []
					: [
							{
								name: theme.name,
								...(theme.sourcePath === undefined ? {} : { path: theme.sourcePath }),
								...resourceSource(theme.sourceInfo),
							},
						],
			),
			extensions: extensions.extensions.map((extension) => ({
				id: extension.id,
				path: extension.path,
				...resourceSource(extension.sourceInfo),
			})),
			contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path })),
			diagnostics: [
				...diagnosticsOf("skill", skills.diagnostics),
				...diagnosticsOf("prompt", prompts.diagnostics),
				...diagnosticsOf("theme", themes.diagnostics),
				...diagnosticsOf(
					"extension",
					extensions.errors.map((error) => ({ type: "error" as const, message: error.error, path: error.path })),
				),
				...diagnosticsOf("extension", session.extensionRunner.getCommandDiagnostics()),
			],
			notices,
		};
	},
});

export const toolsQuery = defineQuery({
	name: "tools",
	scope: "conversation",
	remote: "unsafe",
	requires: observe,
	async run(ctx) {
		const { session } = targetOf(ctx);
		const active = new Set(session.getActiveToolNames());
		return {
			tools: session.getAllTools().map((tool) => ({
				name: tool.name,
				description: tool.description,
				source: toolSource(tool.sourceInfo),
				active: active.has(tool.name),
			})),
		};
	},
});
