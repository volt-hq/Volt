/**
 * Synthetic live Jev demonstration; the main provider is scripted and free.
 * From the repository root:
 * JITI_TSCONFIG_PATHS=./tsconfig.json node node_modules/jiti/lib/jiti-cli.mjs packages/coding-agent/examples/sdk/14-jev-ahead-of-model.ts --live
 * --live consents to exporting the synthetic fixture and making up to 60 Jev calls.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	loadSkillsFromDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@hansjm10/volt-coding-agent";
import { AHEAD_AUDIT_TYPE } from "../extensions/jev-ahead-of-model/audit.ts";
import { type AheadReport, createJevAheadOfModel } from "../extensions/jev-ahead-of-model/index.ts";

if (process.argv.length !== 3 || !["--live", "--disabled"].includes(process.argv[2])) {
	console.error(
		"Pass --live for real Jev on synthetic data, or --disabled for the scripted baseline. See the extension README.",
	);
	process.exitCode = 1;
} else {
	const enabled = process.argv[2] === "--live";
	const gatewayKey = enabled
		? await ModelRegistry.create(AuthStorage.create()).getApiKeyForProvider("vercel-ai-gateway")
		: undefined;
	if (enabled && !gatewayKey) {
		console.error("No Vercel AI Gateway credential. Use Volt /login or AI_GATEWAY_API_KEY.");
		process.exitCode = 1;
	} else {
		const root = await mkdtemp(join(tmpdir(), "volt-ahead-demo-"));
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		const faux = registerFauxProvider();
		try {
			await mkdir(join(cwd, "src"), { recursive: true });
			await mkdir(join(agentDir, "skills", "session-debugging"), { recursive: true });
			await writeFile(
				join(cwd, "src", "session.ts"),
				"// The resume path must restore the saved branch before reading messages.\nexport function resume(saved: { branch: string; messages: string[] }) {\n  return { branch: 'main', messages: saved.messages };\n}\n",
			);
			await writeFile(join(cwd, "src", "colors.ts"), "export const color = 'blue';\n");
			await writeFile(
				join(cwd, "src", "checkpoint.txt"),
				"Observed: resume opens main although the saved branch is feature-a.\n",
			);
			await writeFile(
				join(agentDir, "skills", "session-debugging", "SKILL.md"),
				"---\nname: session-debugging\ndescription: Investigate session resume and branch restoration bugs.\n---\nTrace the saved branch identifier into resume. Compare expected restoration with the returned branch. Explain the root cause before editing.\n",
			);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("faux", "synthetic");
			if (gatewayKey) authStorage.setRuntimeApiKey("vercel-ai-gateway", gatewayKey);
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			let report: AheadReport | undefined;
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Synthetic demonstration. Investigate the session restoration fixture.",
				skillsOverride: () => loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "user" }),
				extensionFactories: [
					createJevAheadOfModel({
						enabled,
						onReport: (value) => {
							report = value;
						},
					}),
				],
			});
			await resourceLoader.reload();
			const sessionManager = await SessionManager.create(cwd, join(agentDir, "sessions"));
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				settingsManager,
				resourceLoader,
				modelRegistry: ModelRegistry.inMemory(authStorage),
				model: faux.getModel(),
				sessionManager,
				tools: ["read", "find", "grep"],
				disableMcp: true,
				extensionWorkLimits: { firstRequestWaitMs: 1000 },
			});
			const started = performance.now();
			const projections: Array<{ turn: number; atMs: number; preparedExcerpts: number; hasResumeSource: boolean }> =
				[];
			const observe = (context: Context) => {
				const text = context.messages
					.map((message) =>
						typeof message.content === "string"
							? message.content
							: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
					)
					.join("\n");
				projections.push({
					turn: projections.length + 1,
					atMs: Math.round(performance.now() - started),
					preparedExcerpts: text.split("Ahead of Model Work:").length - 1,
					hasResumeSource: text.includes("export function resume"),
				});
			};
			// Fixed 2.5-second scripted turns let background work overlap. This delay
			// is part of this demonstration only, never part of the extension.
			const checkpoint = async (context: Context) => {
				observe(context);
				await delay(2500);
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/checkpoint.txt" })], {
					stopReason: "toolUse",
				});
			};
			faux.setResponses([
				checkpoint,
				checkpoint,
				checkpoint,
				(context) => {
					observe(context);
					return fauxAssistantMessage("Synthetic workflow finished. This is not a model-quality evaluation.");
				},
			]);
			let savedAudits: ReturnType<SessionManager["getEntries"]> = [];
			try {
				await session.bindExtensions({});
				await session.prompt(
					"Investigate why resume restores the wrong branch. Explain the cause without editing files.",
				);
				savedAudits = sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === AHEAD_AUDIT_TYPE);
			} finally {
				session.dispose();
				await session.waitForClosed();
			}
			const reopened = await SessionManager.open(sessionManager.getSessionRef()!);
			let auditRoundTrip = false;
			try {
				const restored = reopened
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === AHEAD_AUDIT_TYPE);
				auditRoundTrip = isDeepStrictEqual(savedAudits, restored) && restored.length === (enabled ? 1 : 0);
			} finally {
				await reopened.closePersistence();
			}
			console.log(
				JSON.stringify(
					{
						mode: enabled ? "live-jev" : "disabled",
						scriptedMainCalls: faux.state.callCount,
						elapsedMs: Math.round(performance.now() - started),
						projections,
						cycles: report?.cycles,
						evaluations: report?.evaluations,
						boundaries: report?.boundaries,
						audit: { sqliteRoundTrip: auditRoundTrip, requests: savedAudits.length },
						limitation:
							"Synthetic source and fixed main turns; measures wiring and availability, not reasoning savings or task quality.",
					},
					null,
					2,
				),
			);
			if (
				!auditRoundTrip ||
				(enabled &&
					(!report?.evaluations.some((call) => call.result.status === "ok") ||
						!projections.some((projection) => projection.hasResumeSource)))
			)
				process.exitCode = 1;
		} finally {
			faux.unregister();
			await rm(root, { recursive: true, force: true });
		}
	}
}
