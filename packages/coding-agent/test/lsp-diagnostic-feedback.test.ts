import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient, type LspDiagnostic, type LspDiagnosticResult } from "../src/core/lsp/client.ts";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import {
	type DiagnosticFeedbackSnapshot,
	LspDiagnosticFeedback,
	MAX_AUTOMATIC_REPORT_BYTES,
	MAX_FEEDBACK_FILES,
	MAX_FEEDBACK_FINGERPRINTS,
} from "../src/core/lsp/diagnostic-feedback.ts";
import { LspManager } from "../src/core/lsp/manager.ts";

const diagnostic: LspDiagnostic = {
	message: "existing problem",
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
	severity: 1,
	code: 1,
	source: "fixture",
};
function snapshot(
	diagnostics = [diagnostic],
	overrides: Partial<DiagnosticFeedbackSnapshot> = {},
): DiagnosticFeedbackSnapshot {
	return { path: "/a.foo", displayPath: "a.foo", diagnostics, freshness: "fresh", ...overrides };
}
function fixture() {
	const feedback = new LspDiagnosticFeedback();
	let sequence = 0;
	return {
		feedback,
		render: (snapshots = [snapshot()], max = 20, server = "fixture\u0000/root") =>
			feedback.render(server, ++sequence, snapshots, 1, max),
	};
}

describe("bounded diagnostic delivery", () => {
	it("reports first observation, suppresses unchanged, reconciles removal and reports recurrence", () => {
		const f = fixture();
		expect(f.render()).toContain("existing problem");
		expect(f.render()).toBe("");
		expect(f.render([snapshot([])])).toContain("no longer reported");
		expect(f.render([snapshot([])])).toBe("");
		expect(f.render()).toContain("existing problem");
	});
	it.each([
		{ message: "changed problem" },
		{ code: "1" },
		{ source: "another" },
		{ severity: undefined },
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
	])("fingerprints the complete finding $message $code $source $range", (change) => {
		const f = fixture();
		f.render();
		const next = { ...diagnostic, ...change };
		// Missing severity is the LSP error default, not a confidence change.
		expect(Boolean(f.render([snapshot([next])]))).toBe(
			change.severity === undefined && "severity" in change ? false : true,
		);
	});
	it("repeats only changed confidence/context, not source transport changes", () => {
		const f = fixture();
		f.render();
		expect(f.render([snapshot(undefined, { freshness: "unverified" })])).toContain("unverified");
		expect(f.render([snapshot(undefined, { freshness: "unverified" })])).toBe("");
		expect(f.render([snapshot(undefined, { freshness: "fresh" })])).toContain("existing problem");
		expect(f.render([snapshot(undefined, { projectContext: "not-detected" })])).toContain("Best-effort");
		expect(f.render([snapshot(undefined, { projectContext: "swiftpm-detected" })])).toContain("existing problem");
	});
	it("does not treat unverified disappearance as resolution, but allows recurrence", () => {
		const f = fixture();
		f.render();
		expect(f.render([snapshot([], { freshness: "unverified" })])).toBe("");
		expect(f.render()).toContain("existing problem");
	});
	it.each(["stale", "unknown"] as const)("ignores %s snapshots without clearing the baseline", (freshness) => {
		const f = fixture();
		f.render();
		expect(f.render([snapshot([], { freshness })])).toBe("");
		expect(f.render()).toBe("");
	});
	it("rejects superseded feedback even when it contains a usable empty snapshot", () => {
		const f = new LspDiagnosticFeedback();
		f.render("root", 2, [snapshot()], 1, 20);
		expect(f.render("root", 1, [snapshot([])], 1, 20)).toBe("");
		expect(f.render("root", 3, [snapshot()], 1, 20)).toBe("");
	});
	it("compares all findings before truncating and only consumes emitted diagnostics", () => {
		const f = fixture();
		const all = [diagnostic, { ...diagnostic, message: "second" }, { ...diagnostic, message: "third" }];
		const first = f.render([snapshot(all)], 1);
		expect(first).toContain("existing problem");
		expect(first).toContain("truncated");
		expect(f.render([snapshot(all)], 1)).toContain("second");
		expect(f.render([snapshot(all)], 1)).toContain("third");
		expect(f.render([snapshot(all)], 1)).toBe("");
	});
	it("applies one count and byte budget to the entire report", () => {
		const f = fixture();
		const snapshots = [
			snapshot(),
			snapshot([{ ...diagnostic, message: "cross problem" }], {
				path: "/b.foo",
				displayPath: "b.foo",
				otherFile: true,
				wasClean: true,
				freshness: "unverified",
			}),
		];
		const first = f.render(snapshots, 1);
		expect(first).not.toContain("cross problem");
		expect(first).toContain("truncated");
		const second = f.render(snapshots, 1);
		expect(second).toContain("cross problem");
		expect(second).toContain("unverified");
		expect(second).not.toContain("Diagnostics (fresh)");
		const huge = snapshot([{ ...diagnostic, message: "界".repeat(5000) }]);
		const bounded = f.render([huge]);
		expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(MAX_AUTOMATIC_REPORT_BYTES);
		expect(bounded).toContain("truncated");
		expect(f.render([huge])).toContain("truncated");
	});
	it("retains the five-other-files cap and pending findings across truncated reports", () => {
		const f = fixture();
		const snapshots = Array.from({ length: 7 }, (_, i) =>
			snapshot(undefined, { path: `/file${i}`, displayPath: `file${i}`, otherFile: true, wasClean: true }),
		);
		expect(f.render(snapshots).match(/existing problem/g)).toHaveLength(5);
		// Still failing, so no longer a clean baseline; only the pending findings remain.
		const stillFailing = snapshots.map((item) => ({ ...item, wasClean: false }));
		expect(f.render(stillFailing).match(/existing problem/g)).toHaveLength(2);
	});
	it("requires clean-to-failing eligibility for other files", () => {
		const f = fixture();
		f.render();
		expect(f.render([snapshot([{ ...diagnostic, message: "new but not newly failing" }], { otherFile: true })])).toBe(
			"",
		);
		// A known-clean baseline resolves earlier deliveries, so recurrence is newly failing.
		expect(f.render([snapshot(undefined, { otherFile: true, wasClean: true })])).toContain(
			"Newly failing in other open files",
		);
		expect(f.render([snapshot([{ ...diagnostic, message: "new cross error" }], { otherFile: true })])).toContain(
			"new cross error",
		);
	});
	it("isolates canonical server/root/file keys and clears only affected entries", () => {
		const f = fixture();
		f.render();
		expect(f.render(undefined, 20, "fixture\u0000/other")).toContain("existing problem");
		f.feedback.forget("fixture\u0000/root", "/a.foo");
		expect(f.render()).toContain("existing problem");
		expect(f.render(undefined, 20, "fixture\u0000/other")).toBe("");
		f.feedback.clear();
		expect(f.render(undefined, 20, "fixture\u0000/other")).toContain("existing problem");
	});
	it("bounds file and fingerprint history; evicted findings may be delivered again", () => {
		const f = fixture();
		f.render();
		for (let i = 0; i < MAX_FEEDBACK_FILES; i++) f.render([snapshot(undefined, { path: `/other${i}` })]);
		expect(f.render()).toContain("existing problem");
		const g = fixture();
		g.render();
		for (let i = 0; i < MAX_FEEDBACK_FINGERPRINTS / 20; i++) {
			g.render([
				snapshot(
					Array.from({ length: 20 }, (_, j) => ({ ...diagnostic, message: `m${j}` })),
					{ path: `/other${i}` },
				),
			]);
		}
		expect(g.render()).toContain("existing problem");
	});
});

const roots: string[] = [];
const managers: LspManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("keeps automatic history across real edits and explicit reads, but clears on closure/restart", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-feedback-")));
	roots.push(root);
	const path = join(root, "a.foo");
	writeFileSync(path, "ERROR value\n");
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			idleShutdownMs: 0,
			servers: {
				fake: {
					command: [process.execPath, join(__dirname, "fixtures/fake-lsp-server.mjs"), "--pull"],
					fileExtensions: [".foo"],
					rootMarkers: [],
				},
			},
		}),
	});
	managers.push(manager);
	const first = await manager.getDiagnostics(path, "ERROR value\n");
	expect(first.text).toContain("found ERROR");
	expect((await manager.fileDiagnostics(path)).text).toContain("found ERROR");
	writeFileSync(path, "ERROR value unrelated\n");
	expect(await manager.getDiagnostics(path, "ERROR value unrelated\n")).toMatchObject({
		text: "",
		outcome: "success",
		diagnosticCount: 1,
		freshness: "fresh",
	});
	const alias = join(root, "alias.foo");
	symlinkSync(path, alias);
	expect((await manager.getDiagnostics(alias, "ERROR value unrelated\n")).text).toBe("");
	rmSync(path);
	const other = join(root, "other.foo");
	writeFileSync(other, "value\n");
	await manager.hover(other, "value"); // Normal refresh closes the deleted document.
	writeFileSync(path, "ERROR value\n");
	expect((await manager.getDiagnostics(path, "ERROR value\n")).text).toContain("found ERROR");
	manager.restart();
	expect((await manager.getDiagnostics(path, "ERROR value\n")).text).toContain("found ERROR");
});

it("a superseded manager collection cannot erase a newer delivery baseline", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-feedback-race-")));
	roots.push(root);
	const path = join(root, "a.foo");
	writeFileSync(path, "ERROR value\n");
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			idleShutdownMs: 0,
			servers: {
				fake: {
					command: [process.execPath, join(__dirname, "fixtures/fake-lsp-server.mjs"), "--pull"],
					fileExtensions: [".foo"],
					rootMarkers: [],
				},
			},
		}),
	});
	managers.push(manager);
	// Establish a real synchronized document, then control only completion ordering at the client boundary.
	await manager.fileDiagnostics(path);
	const original = LspClient.prototype.getDiagnostics;
	let release!: (result: LspDiagnosticResult) => void;
	let started!: () => void;
	const began = new Promise<void>((resolve) => {
		started = resolve;
	});
	let captured!: LspDiagnosticResult;
	vi.spyOn(LspClient.prototype, "getDiagnostics").mockImplementationOnce(async function (this: LspClient, ...args) {
		captured = await original.apply(this, args);
		started();
		return new Promise<LspDiagnosticResult>((resolve) => {
			release = resolve;
		});
	});
	const older = manager.getDiagnostics(path, "ERROR value\n");
	await began;
	expect((await manager.getDiagnostics(path, "ERROR value\n")).text).toContain("found ERROR");
	release({ ...captured, diagnostics: [], diagnosticCount: 0, outcome: "empty" });
	expect((await older).text).toBe("");
	expect((await manager.getDiagnostics(path, "ERROR value\n")).text).toBe("");
});

it("clears automatic delivery state when a failed client is replaced", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-feedback-replace-")));
	roots.push(root);
	const path = join(root, "a.foo");
	writeFileSync(path, "ERROR value\n");
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			settleMs: 1000,
			idleShutdownMs: 0,
			servers: {
				fake: {
					command: [process.execPath, join(__dirname, "fixtures/fake-lsp-server.mjs"), "--exit-on-change"],
					fileExtensions: [".foo"],
					rootMarkers: [],
				},
			},
		}),
	});
	managers.push(manager);
	expect((await manager.getDiagnostics(path, "ERROR value\n")).text).toContain("found ERROR");
	writeFileSync(path, "ERROR changed\n");
	expect((await manager.getDiagnostics(path, "ERROR changed\n")).outcome).toBe("unavailable");
	expect((await manager.getDiagnostics(path, "ERROR changed\n")).text).toContain("found ERROR");
});
