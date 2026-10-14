/**
 * The extension inventory: what a conversation in a workspace would load, evaluated without one, and told to
 * clients through the same views the live `extensions` and `review.engines` queries use.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	remoteExtensionInventoryView,
	remoteExtensionSummary,
	remoteReviewEngineView,
	reviewEngineView,
} from "../src/core/extensions/inventory.ts";
import { queryRegistry } from "../src/core/protocol/queries/index.ts";
import { createIrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import { ReviewEngineRegistry, validateReviewEngine } from "../src/core/review-engine.ts";
import { evaluateExtensionInventory } from "../src/daemon/worker/extension-inventory.ts";

const ENGINES_EXTENSION = `export const manifest = { id: "engines", displayName: "Engines", description: "Registers engines." };
export default function (volt) {
	volt.registerReviewEngine("phone", {
		label: "Phone",
		description: "A paired device may start it.",
		cost: "Slower.",
		targets: ["pr", "uncommitted"],
		remoteSafe: true,
		parameters: { type: "object", properties: { passes: { type: "integer", default: 1 }, exec: { type: "boolean" } } },
		localOnly: ["exec"],
		async run() {},
	});
	volt.registerReviewEngine("desk", {
		label: "Desk",
		description: "Only at the host.",
		targets: ["uncommitted"],
		remoteSafe: false,
		async run() {},
	});
	volt.registerReviewEngine("tuned", {
		label: "Tuned",
		description: "Needs its depth.",
		targets: ["commit"],
		remoteSafe: true,
		parameters: {
			type: "object",
			properties: { depth: { type: "integer", minimum: 1 }, workdir: { type: "string" } },
			required: ["depth", "workdir"],
		},
		localOnly: ["workdir"],
		async run() {},
	});
}
`;

function engineDeclarations() {
	const run = async () => {};
	return [
		validateReviewEngine({
			id: "ext:engines/phone",
			label: "Phone",
			description: "A paired device may start it.",
			targets: ["pr"],
			remoteSafe: true,
			parameters: { type: "object", properties: { passes: { type: "integer" }, exec: { type: "boolean" } } },
			localOnly: ["exec"],
			run,
		}),
		validateReviewEngine({
			id: "ext:engines/desk",
			label: "Desk",
			description: "Only at the host.",
			targets: ["uncommitted"],
			remoteSafe: false,
			run,
		}),
		validateReviewEngine({
			id: "ext:engines/tuned",
			label: "Tuned",
			description: "Needs its depth.",
			targets: ["commit"],
			remoteSafe: true,
			parameters: {
				type: "object",
				properties: { depth: { type: "integer" }, workdir: { type: "string" } },
				required: ["depth", "workdir"],
			},
			localOnly: ["workdir"],
			run,
		}),
	];
}

describe("extension inventory views", () => {
	test("the inventory's remote view tells a remote client exactly what the live review.engines query does", async () => {
		const registry = new ReviewEngineRegistry();
		for (const engine of engineDeclarations()) registry.register(engine);
		const live = await queryRegistry.run(
			{
				target: { session: { reviewEngines: registry } } as never,
				services: {},
				profile: { name: "remote", grant: createIrohRemoteRpcGrant(REMOTE_CAPABILITIES) },
			},
			"review.engines",
			{},
		);
		const local = registry.list().map(reviewEngineView);
		const inventory = remoteExtensionInventoryView({ projectTrusted: true, extensions: [], reviewEngines: local });
		expect(inventory.reviewEngines).toEqual(live.engines);
		expect(live.engines.map((engine) => engine.id)).toEqual(["ext:engines/phone", "ext:engines/tuned"]);
		// A local-only parameter is not mentioned, in the parameters or beside them.
		expect(JSON.stringify(live)).not.toContain("exec");
		expect(JSON.stringify(live)).not.toContain("workdir");
		expect(live.engines[1]?.parameters).toEqual({
			type: "object",
			properties: { depth: { type: "integer" } },
			required: ["depth"],
		});
	});

	test("the local view keeps what the host may know, and the remote view drops it", () => {
		const [phone, desk] = engineDeclarations().map(reviewEngineView);
		expect(phone).toMatchObject({
			id: "ext:engines/phone",
			name: "phone",
			extension: "engines",
			localOnly: ["exec"],
		});
		expect(Object.keys(phone?.parameters?.properties ?? {})).toEqual(["passes", "exec"]);
		expect(desk && remoteReviewEngineView(desk)).toBeUndefined();
		const summary = {
			id: "engines",
			displayName: "Engines",
			version: "local",
			scope: "user" as const,
			enabled: true,
			state: "active" as const,
			permissions: [],
			permissionsAcknowledged: true,
			hasSettings: false,
			fingerprint: "local:abc",
		};
		expect(remoteExtensionSummary(summary)).not.toHaveProperty("fingerprint");
		expect(remoteExtensionInventoryView({ projectTrusted: false, extensions: [summary], reviewEngines: [] })).toEqual(
			{ projectTrusted: false, extensions: [remoteExtensionSummary(summary)], reviewEngines: [] },
		);
	});
});

describe("evaluateExtensionInventory", () => {
	let tempDir: string;
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-extension-inventory-"));
		root = join(tempDir, "workspace");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(join(root, ".volt", "extensions"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("lists what a conversation would load: every extension, its state, and the engines active ones register", async () => {
		writeFileSync(join(agentDir, "extensions", "engines.ts"), ENGINES_EXTENSION);
		writeFileSync(
			join(agentDir, "extensions", "quiet.ts"),
			`export const manifest = { id: "quiet", displayName: "Quiet" };
export default function (volt) {
	volt.registerReviewEngine("never", { label: "Never", description: "Disabled.", targets: ["pr"], remoteSafe: true, async run() {} });
}
`,
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: { quiet: { enabled: false } } }));

		const inventory = await evaluateExtensionInventory({ root, agentDir, projectTrusted: true });

		expect(inventory.projectTrusted).toBe(true);
		const byId = new Map(inventory.extensions.map((extension) => [extension.id, extension]));
		expect(byId.get("engines")).toMatchObject({
			state: "active",
			enabled: true,
			scope: "user",
			displayName: "Engines",
		});
		expect(byId.get("engines")?.fingerprint).toEqual(expect.any(String));
		expect(byId.get("quiet")).toMatchObject({ state: "disabled", enabled: false });
		// A disabled extension's factory never ran, so its engine is not offered.
		expect(inventory.reviewEngines.map((engine) => engine.id)).toEqual([
			"ext:engines/phone",
			"ext:engines/desk",
			"ext:engines/tuned",
		]);
		expect(inventory.reviewEngines[0]).toMatchObject({
			cost: "Slower.",
			targets: ["pr", "uncommitted"],
			localOnly: ["exec"],
		});

		const remote = remoteExtensionInventoryView(inventory);
		expect(remote.reviewEngines.map((engine) => engine.id)).toEqual(["ext:engines/phone", "ext:engines/tuned"]);
		expect(JSON.stringify(remote)).not.toContain("fingerprint");
	});

	test("leaves an untrusted project's own extensions out", async () => {
		writeFileSync(join(root, ".volt", "extensions", "project.ts"), ENGINES_EXTENSION);

		const untrusted = await evaluateExtensionInventory({ root, agentDir, projectTrusted: false });
		expect(untrusted.projectTrusted).toBe(false);
		expect(untrusted.extensions).toEqual([]);
		expect(untrusted.reviewEngines).toEqual([]);

		const trusted = await evaluateExtensionInventory({ root, agentDir, projectTrusted: true });
		expect(trusted.extensions.map((extension) => [extension.id, extension.scope])).toEqual([["engines", "project"]]);
		expect(trusted.reviewEngines).toHaveLength(3);
	});

	test("leaves out a configured package that is missing, without installing it", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@volt-test/not-installed@1.0.0"] }),
		);

		const inventory = await evaluateExtensionInventory({ root, agentDir, projectTrusted: true });

		expect(inventory.extensions).toEqual([]);
		expect(existsSync(join(agentDir, "npm"))).toBe(false);
		expect(existsSync(join(agentDir, "packages"))).toBe(false);
	});
});
