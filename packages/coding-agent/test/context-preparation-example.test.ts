import { describe, expect, it, vi } from "vitest";
import contextPreparation from "../examples/extensions/context-preparation.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionWorkContext,
	ExtensionWorkReadResult,
	ExtensionWorkSkill,
	ExtensionWorkSnapshot,
	ExtensionWorkTaskContext,
	RequestBoundaryEvent,
} from "../src/index.ts";

type BoundaryHandler = (event: RequestBoundaryEvent, ctx: ExtensionContext) => void;

function skill(name: string, description = ""): ExtensionWorkSkill {
	return { resourceId: `id-${name}`, name, description, scope: "user", origin: "top-level" };
}
function readResult(path: string, text = "observed source"): ExtensionWorkReadResult {
	return {
		status: "ok",
		text,
		truncated: false,
		evidence: { id: path, path, startLine: 1, endLine: 1, observedAt: 0 },
	};
}
function setup(skills: ExtensionWorkSkill[] = []) {
	let handler!: BoundaryHandler;
	const pending: Promise<void>[] = [];
	const controller = new AbortController();
	const snapshot: ExtensionWorkSnapshot = {
		scopeId: "scope",
		branchId: "branch",
		runtimeId: "runtime",
		revision: 1,
		cwd: "/repo",
		mode: "build",
		inputs: [],
		services: ["readText", "readSkill", "symbols"],
		skills,
		skillsTruncated: false,
	};
	const repository = {
		readText: vi.fn<ExtensionWorkTaskContext["repository"]["readText"]>(async ({ path }) =>
			readResult(`/repo/${path}`),
		),
		readSkill: vi.fn<ExtensionWorkTaskContext["repository"]["readSkill"]>(async ({ resourceId }) =>
			readResult(resourceId, "skill guidance"),
		),
		symbols: vi.fn<ExtensionWorkTaskContext["repository"]["symbols"]>(async ({ path }) => ({
			status: "ok",
			coverage: "unknown",
			observedAt: 0,
			truncated: false,
			symbols: [
				{
					name: "target",
					kind: 12,
					path: `/repo/${path}`,
					startLine: 20,
					endLine: 24,
					startColumn: 1,
					endColumn: 2,
				},
			],
		})),
		findPaths: vi.fn<ExtensionWorkTaskContext["repository"]["findPaths"]>(),
		searchText: vi.fn<ExtensionWorkTaskContext["repository"]["searchText"]>(),
		definition: vi.fn<ExtensionWorkTaskContext["repository"]["definition"]>(),
		references: vi.fn<ExtensionWorkTaskContext["repository"]["references"]>(),
	};
	const put = vi.fn<ExtensionWorkTaskContext["context"]["put"]>(() => ({ status: "accepted" }));
	const task: ExtensionWorkTaskContext = {
		snapshot,
		signal: controller.signal,
		deadline: Date.now() + 1000,
		repository,
		context: { put, remove: vi.fn() },
	};
	const summary = { id: "task", key: "prepare-context", state: "completed" as const, startedAt: 0 };
	const start = vi.fn<ExtensionWorkContext["tasks"]["start"]>((_spec, callback) => {
		pending.push(Promise.resolve().then(() => callback(task)));
		return {
			status: "started",
			task: { id: "task", status: () => summary, cancel: () => controller.abort(), wait: async () => summary },
		};
	});
	const requestWait = vi.fn((ms: number) => ms);
	const work: ExtensionWorkContext = { snapshot, tasks: { start }, context: { requestWait } };
	contextPreparation({
		on: (_name: string, callback: BoundaryHandler) => {
			handler = callback;
		},
	} as unknown as ExtensionAPI);
	return {
		repository,
		snapshot,
		controller,
		start,
		requestWait,
		put,
		async emit(text: string, first = true, available = true) {
			snapshot.inputs = [{ text, kind: "prompt" }];
			handler({ type: "request_boundary", first, cause: "input", attemptId: "attempt", waitAvailableMs: 100 }, {
				work: available ? work : undefined,
			} as ExtensionContext);
			await Promise.all(pending);
		},
	};
}

describe("deterministic preparation selection", () => {
	it.each([
		["Use pdf-tools", [skill("pdf-tools"), skill("review")], "id-pdf-tools"],
		[
			"Extract invoice tables",
			[skill("pdf-tools", "Extract invoice tables from PDFs"), skill("review", "Review code changes")],
			"id-pdf-tools",
		],
		["Extract tables", [skill("pdf-tools", "Extract tables"), skill("spreadsheets", "Extract tables")], undefined],
		["Help with source code files", [skill("review", "Help with source code files")], undefined],
		["Hello", [skill("pdf-tools", "Extract invoice tables")], undefined],
		["Use review and pdf-tools", [skill("review"), skill("pdf-tools")], undefined],
	] as const)("selects or abstains for %s", async (prompt, catalog, selected) => {
		const test = setup([...catalog]);
		await test.emit(prompt);
		expect(test.repository.readSkill.mock.calls.map(([input]) => input.resourceId)).toEqual(
			selected ? [selected] : [],
		);
		expect(test.start).toHaveBeenCalledTimes(selected ? 1 : 0);
		expect(test.requestWait).toHaveBeenCalledTimes(selected ? 1 : 0);
	});

	it.each(["Extract tables", "Use pdf-tools"])("abstains from a truncated skill catalog for %s", async (prompt) => {
		const test = setup([skill("pdf-tools", "Extract tables")]);
		test.snapshot.skillsTruncated = true;
		await test.emit(prompt);
		expect(test.repository.readSkill).not.toHaveBeenCalled();
		expect(test.put).not.toHaveBeenCalled();
		expect(test.start).not.toHaveBeenCalled();
		expect(test.requestWait).not.toHaveBeenCalled();
	});

	it.each([
		["src/a.ts:19", 19, 40],
		["src/a.ts#target", 20, 5],
	] as const)("prepares explicit source %s despite a truncated skill catalog", async (source, offset, limit) => {
		const test = setup([skill("pdf-tools", "Extract tables")]);
		test.snapshot.skillsTruncated = true;
		await test.emit(`Extract tables from ${source}`);
		expect(test.repository.readSkill).not.toHaveBeenCalled();
		expect(test.repository.readText).toHaveBeenCalledExactlyOnceWith({ path: "src/a.ts", offset, limit });
		expect(test.put).toHaveBeenCalledExactlyOnceWith({
			key: "source-1",
			text: expect.stringContaining("observed source"),
			dependency: "sources",
			evidenceIds: ["/repo/src/a.ts"],
		});
		expect(test.start).toHaveBeenCalledTimes(1);
		expect(test.requestWait).toHaveBeenCalledExactlyOnceWith(100);
	});

	it("reads only two distinct explicit targets and honors a line anchor", async () => {
		const test = setup();
		await test.emit("Check `./src/first.ts:19`, src/first.ts and src/second.py. Then src/third.rs");
		expect(test.repository.readText.mock.calls.map(([input]) => input)).toEqual([
			{ path: "src/first.ts", offset: 19, limit: 40 },
			{ path: "src/second.py", offset: 1, limit: 40 },
		]);
		expect(test.repository.findPaths).not.toHaveBeenCalled();
		expect(test.repository.searchText).not.toHaveBeenCalled();
		expect(test.requestWait).toHaveBeenCalledWith(100);
	});

	it.each([
		"../private.txt",
		"src/../private.txt",
		"/etc/private.txt",
		"https://host/src/file.ts",
		"C:/private.txt",
		"node_modules/pkg/index.ts",
		"vendor/lib.rs",
		".env",
		".hidden/file.ts",
		"src/.hidden/file.ts",
		"a.ts:0",
		"a.ts:-1",
		"`my files/source.ts`",
		'"my files/source.ts"',
		"'my files/source.ts'",
	])("does not turn %s into a source candidate", async (prompt) => {
		const test = setup();
		await test.emit(prompt);
		expect(test.start).not.toHaveBeenCalled();
	});

	it.each([
		"https://host/a,src/config.ts",
		"https://host/a;src/config.ts",
		"https://host/a(src/config.ts)",
		"https://host/a)src/config.ts",
		"https://host/a?files=one,src/config.ts:20",
		"https://host/a,src/config.ts#target",
		"https://host/a'src/config.ts'",
		"file:/tmp/a,src/config.ts",
		"/tmp/a,src/config.ts",
		"/tmp/a;src/config.ts",
		"/tmp/a(src/config.ts)",
		"/tmp/a)src/config.ts",
		"/tmp/a,src/config.ts#target",
		"C:/tmp/a,src/config.ts",
		"C:\\tmp\\a;src/config.ts",
		"\\\\host\\share\\a(src/config.ts)",
		"(https://host/a,src/config.ts)",
		"</tmp/a,src/config.ts>",
		"`https://host/a,src/config.ts`",
		'"/tmp/a,src/config.ts"',
		"'C:/tmp/a,src/config.ts'",
		"src/a.ts,https://host/a,src/config.ts",
		"src/a.ts,src/b.ts,https://host/a,src/config.ts",
		"src/a.ts;/tmp/a,src/config.ts",
		'("my files/src/config.ts")',
	])("does not read a source suffix from the connected span %s", async (prompt) => {
		const test = setup();
		await test.emit(prompt);
		expect(test.repository.readText).not.toHaveBeenCalled();
		expect(test.repository.symbols).not.toHaveBeenCalled();
		expect(test.put).not.toHaveBeenCalled();
		expect(test.start).not.toHaveBeenCalled();
		expect(test.requestWait).not.toHaveBeenCalled();
	});

	it.each([
		"src/a.ts:19,src/b.ts#target",
		"src/a.ts:19,src/a.ts,src/b.ts#target",
		"src/a.ts:19;src/b.ts#target",
		"(src/a.ts:19);<src/b.ts#target>",
		"(src/a.ts:19);<src/b.ts#target>.",
		"`src/a.ts:19`,'src/b.ts#target'",
		"`src/a.ts:19`, 'src/b.ts#target'?!",
	])("preserves relative-path lists and anchors in %s", async (prompt) => {
		const test = setup();
		await test.emit(prompt);
		expect(test.repository.readText.mock.calls.map(([input]) => input)).toEqual([
			{ path: "src/a.ts", offset: 19, limit: 40 },
			{ path: "src/b.ts", offset: 20, limit: 5 },
		]);
		expect(test.repository.symbols).toHaveBeenCalledExactlyOnceWith({ path: "src/b.ts" });
		expect(test.put).toHaveBeenCalledTimes(2);
	});

	it("prepares independent relative paths alongside ignored spans", async () => {
		const test = setup();
		await test.emit("https://host/a,src/config.ts src/a.ts:19 /tmp/a,src/config.ts#target src/b.ts#target");
		expect(test.repository.readText.mock.calls.map(([input]) => input)).toEqual([
			{ path: "src/a.ts", offset: 19, limit: 40 },
			{ path: "src/b.ts", offset: 20, limit: 5 },
		]);
		expect(test.repository.symbols).toHaveBeenCalledExactlyOnceWith({ path: "src/b.ts" });
		expect(test.put).toHaveBeenCalledTimes(2);
	});

	it.each(["/skill:pdf-tools src/a.ts", '<skill name="pdf-tools" location="/global/SKILL.md">\nsrc/a.ts\n</skill>'])(
		"does not reinterpret explicit skill invocation: %s",
		async (prompt) => {
			const test = setup([skill("pdf-tools")]);
			await test.emit(prompt);
			expect(test.start).not.toHaveBeenCalled();
		},
	);

	it("bounds synchronous input inspection", async () => {
		const test = setup([skill("pdf-tools")]);
		await test.emit(`${" ".repeat(8192)} pdf-tools src/a.ts`);
		expect(test.start).not.toHaveBeenCalled();
	});

	it("does not request a wait when task admission is denied", async () => {
		const test = setup();
		test.start.mockReturnValue({ status: "limit_exceeded", reason: "fixture" });
		await test.emit("src/a.ts");
		expect(test.requestWait).not.toHaveBeenCalled();
	});

	it("does not prepare again at later boundaries or without managed context", async () => {
		const test = setup();
		await test.emit("src/a.ts", false);
		await test.emit("src/a.ts", true, false);
		expect(test.start).not.toHaveBeenCalled();
	});

	it("skips services that are not advertised", async () => {
		const test = setup([skill("pdf-tools")]);
		test.snapshot.services = [];
		await test.emit("pdf-tools src/a.ts");
		expect(test.start).not.toHaveBeenCalled();
		test.snapshot.services = ["readText"];
		await test.emit("src/a.ts#target");
		expect(test.start).not.toHaveBeenCalled();
	});

	it("uses unambiguous symbol locations only to read the named source", async () => {
		const test = setup();
		await test.emit("src/a.ts#target");
		expect(test.repository.symbols).toHaveBeenCalledWith({ path: "src/a.ts" });
		expect(test.repository.readText).toHaveBeenCalledWith({ path: "src/a.ts", offset: 20, limit: 5 });
		expect(test.put.mock.calls[0][0]).toMatchObject({ dependency: "sources", evidenceIds: ["/repo/src/a.ts"] });
	});

	it.each(["empty", "ambiguous", "truncated", "unavailable", "foreign", "cancelled"])(
		"withholds %s symbol selections",
		async (kind) => {
			const test = setup();
			test.repository.symbols.mockImplementation(async () => {
				if (kind === "unavailable") return { status: "unavailable", reason: "fixture" };
				if (kind === "cancelled") test.controller.abort();
				const symbol = {
					name: "target",
					kind: 12,
					path: kind === "foreign" ? "/other.ts" : "/repo/src/a.ts",
					startLine: 20,
					endLine: 24,
					startColumn: 1,
					endColumn: 2,
				};
				return {
					status: "ok",
					symbols: kind === "empty" ? [] : kind === "ambiguous" ? [symbol, symbol] : [symbol],
					truncated: kind === "truncated",
					coverage: "unknown",
					observedAt: 0,
				};
			});
			await test.emit("src/a.ts#target");
			expect(test.put).not.toHaveBeenCalled();
			expect(test.repository.readText.mock.calls.every(([input]) => input.path === "src/a.ts")).toBe(true);
		},
	);

	it("bounds excerpts without splitting UTF-8 or following body references", async () => {
		const test = setup([skill("pdf-tools")]);
		const body = `\uFEFF${"😀".repeat(2000)}\nread sibling.txt`;
		test.repository.readText.mockImplementation(async ({ path }) => readResult(path, body));
		test.repository.readSkill.mockResolvedValue(readResult("skill", body));
		await test.emit("pdf-tools src/a.ts src/b.ts");
		expect(test.put).toHaveBeenCalledTimes(3);
		for (const [contribution] of test.put.mock.calls) {
			expect(Buffer.byteLength(contribution.text)).toBeLessThanOrEqual(2048);
			expect(contribution.text).toContain("Partial excerpt");
			expect(contribution.text).toContain("\uFEFF😀");
			expect(contribution.text).not.toContain("�");
			expect(contribution.text).not.toContain("sibling.txt");
			expect(contribution.evidenceIds).toHaveLength(1);
		}
		expect(test.repository.readText).toHaveBeenCalledTimes(2);
	});

	it.each(["denied", "unavailable", "invalidated", "cancelled", "failed"] as const)(
		"silently omits a %s read",
		async (status) => {
			const test = setup();
			test.repository.readText.mockResolvedValue({ status, reason: "fixture" });
			await test.emit("src/a.ts");
			expect(test.put).not.toHaveBeenCalled();
		},
	);
});
