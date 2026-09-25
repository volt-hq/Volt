import { execFileSync } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlRequest, ControlResponse } from "../../../src/daemon/control-protocol.ts";
import { type ControlServer, startControlServer } from "../../../src/daemon/control-server.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../../../src/daemon/paths.ts";
import {
	createRemoteControlBackend,
	type RemoteControlBackend,
} from "../../../src/modes/interactive/components/remote-control-center.ts";
import { createHarness, type Harness } from "../harness.ts";

type Status = Extract<ControlResponse, { type: "status_result" }>;

describe("#418 explicit current-directory registration", () => {
	let harness: Harness;
	let server: ControlServer;
	let backend: RemoteControlBackend;
	let parent: Status["workspaces"][number];
	let child: string;
	let status: Status;
	let initialLeases: Status["leases"];
	let requests: ControlRequest[];
	let override: ((request: ControlRequest) => ControlResponse | undefined) | undefined;

	beforeEach(async () => {
		harness = await createHarness();
		const root = await realpath(harness.tempDir);
		parent = { name: "parent", path: join(root, "parent"), allowedTools: ["read"] };
		child = join(parent.path, "child");
		await mkdir(child, { recursive: true });
		initialLeases = [
			{
				workspaceName: "parent",
				sessionId: harness.session.sessionId,
				state: "tui-owned",
				streamCount: 1,
				relayCount: 1,
			},
		];
		status = {
			type: "status_result",
			id: "status",
			version: "test",
			protocolVersion: 1,
			pid: process.pid,
			startedAtMs: 0,
			leases: structuredClone(initialLeases),
			phoneConnections: 1,
			remoteTransport: { state: "ready" },
			workspaces: [structuredClone(parent)],
			clients: [],
			keepAwake: { enabled: false, state: "disabled" },
		};
		requests = [];
		override = undefined;
		const paths = getDaemonPaths(root);
		ensureDaemonDirs(paths);
		server = await startControlServer({
			socketPath: paths.socketPath,
			version: "test",
			handlers: {
				onRequest(connection, request) {
					requests.push(request);
					const response = override?.(request);
					if (response) {
						connection.send(response);
						return;
					}
					if (request.type === "status") {
						connection.send({ ...status, id: request.id });
					} else if (request.type === "worktree_resolve") {
						connection.send({
							type: "error",
							id: request.id,
							code: "not_found",
							message: "not a managed worktree",
						});
					} else if (request.type === "workspace_register") {
						// Mirror the daemon's name-based upsert: accidentally choosing a
						// parent's name would overwrite its path and fail preservation checks.
						const existing = status.workspaces.find((workspace) => workspace.name === request.name);
						if (existing) existing.path = request.path;
						else status.workspaces.push({ name: request.name, path: request.path });
						connection.send({ type: "ok", id: request.id });
					} else {
						connection.send({ type: "error", id: request.id, code: "unexpected", message: request.type });
					}
				},
			},
		});
		backend = createRemoteControlBackend(root);
	});

	afterEach(async () => {
		await backend?.close();
		await server?.close();
		await harness?.cleanupAsync();
		expect(status.workspaces.find((workspace) => workspace.name === parent.name)).toEqual(parent);
		expect(status.leases).toEqual(initialLeases);
		expect(
			requests.every((request) => ["status", "worktree_resolve", "workspace_register"].includes(request.type)),
		).toBe(true);
	});

	it("only reads status when the management backend is opened/refreshed", async () => {
		await backend.load();
		await backend.load();
		expect(status.workspaces).toEqual([parent]);
		expect(requests.every((request) => request.type === "status")).toBe(true);
	});

	it.each([false, true])(
		"registers the exact child beneath an existing parent (nested repo: %s)",
		async (repository) => {
			if (repository) execFileSync("git", ["init", "--quiet", child]);
			await expect(backend.registerCurrentWorkspace(child)).resolves.toEqual({ name: "child", path: child });
			expect(status.workspaces).toEqual([parent, { name: "child", path: child }]);
			expect(requests.filter((request) => request.type === "workspace_register")).toMatchObject([
				{ name: "child", path: child },
			]);
		},
	);

	it("reuses an exact registration without overwriting its name or policy", async () => {
		const existing = { name: "custom-child", path: child, allowedTools: ["read", "bash"] };
		status.workspaces.push(existing);
		await expect(backend.registerCurrentWorkspace(child)).resolves.toEqual({ name: existing.name, path: child });
		expect(status.workspaces).toEqual([parent, existing]);
		expect(requests.some((request) => request.type === "workspace_register")).toBe(false);
	});

	it("canonicalizes symlinks and makes repeat registration a no-op", async () => {
		const alias = join(parent.path, "alias");
		await symlink(child, alias, process.platform === "win32" ? "junction" : "dir");
		const expected = { name: "child", path: child };
		await expect(backend.registerCurrentWorkspace(alias)).resolves.toEqual(expected);
		await expect(backend.registerCurrentWorkspace(child)).resolves.toEqual(expected);
		await expect(backend.registerCurrentWorkspace(alias)).resolves.toEqual(expected);
		expect(status.workspaces).toEqual([parent, expected]);
		expect(requests.filter((request) => request.type === "workspace_register")).toHaveLength(1);
	});

	it.each(["child", "CHILD", "café"])("avoids occupied names and normalized aliases: %s", async (occupied) => {
		if (occupied === "café") {
			child = join(parent.path, "cafe\u0301");
			await mkdir(child);
		}
		const existing = { name: occupied, path: join(parent.path, "elsewhere"), allowedTools: ["read"] };
		status.workspaces.push(existing, { name: `${occupied}-2`, path: join(parent.path, "another") });
		const registered = await backend.registerCurrentWorkspace(child);
		expect(registered.name.normalize("NFC").toLowerCase()).toBe(`${occupied.toLowerCase()}-3`);
		expect(registered.path).toBe(await realpath(child));
		expect(status.workspaces[1]).toEqual(existing);
	});

	it.skipIf(process.platform === "win32")("uses a safe name when the basename is invalid", async () => {
		child = join(parent.path, "invalid\nname");
		await mkdir(child);
		await expect(backend.registerCurrentWorkspace(child)).resolves.toEqual({ name: "workspace", path: child });
	});

	it.each(["", "src"])("refuses a managed worktree root or subdirectory: %s", async (subdirectory) => {
		const target = join(child, subdirectory);
		await mkdir(target, { recursive: true });
		override = (request) =>
			request.type === "worktree_resolve"
				? {
						type: "worktree_resolve_result",
						id: request.id,
						workspaceName: "parent",
						workspacePath: parent.path,
						worktreeId: "managed",
						worktreePath: child,
					}
				: undefined;
		await expect(backend.registerCurrentWorkspace(target)).rejects.toThrow("Use parent workspace parent");
		expect(requests.some((request) => request.type === "workspace_register")).toBe(false);
		expect(status.workspaces).toEqual([parent]);
	});

	it.each(["missing", "file"])("rejects invalid paths before sending control requests: %s", async (kind) => {
		const target = join(parent.path, kind);
		if (kind === "file") await writeFile(target, "not a directory");
		await expect(backend.registerCurrentWorkspace(target)).rejects.toThrow();
		expect(requests).toEqual([]);
	});

	it.each(["worktree_resolve", "status", "workspace_register"] as const)(
		"surfaces %s errors without reporting success",
		async (type) => {
			// Connect first so a status failure tests registration, not the daemon probe.
			await backend.load();
			requests.length = 0;
			override = (request) =>
				request.type === type
					? { type: "error", id: request.id, code: "unavailable", message: "test failure" }
					: undefined;
			await expect(backend.registerCurrentWorkspace(child)).rejects.toThrow("test failure");
			expect(status.workspaces).toEqual([parent]);
			if (type !== "workspace_register")
				expect(requests.some((request) => request.type === "workspace_register")).toBe(false);
		},
	);

	it.each(["worktree_resolve", "status", "workspace_register"] as const)(
		"rejects unexpected %s responses",
		async (type) => {
			await backend.load();
			override = (request) =>
				request.type === type ? { type: "clients_result", id: request.id, clients: [] } : undefined;
			await expect(backend.registerCurrentWorkspace(child)).rejects.toThrow("unexpected clients_result response");
			expect(status.workspaces).toEqual([parent]);
		},
	);
});
