import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReviewPrivateDiagnostics,
	getReviewPrivateDiagnosticsDirectory,
	REVIEW_PRIVATE_DIAGNOSTICS_ENV,
} from "../src/core/review-private-diagnostics.ts";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-windows-review-diagnostics-"));
	roots.push(root);
	return root;
}

/**
 * Run a native System32 tool. ACL fixtures use icacls and whoami rather than
 * Windows PowerShell: PowerShell loads .NET on every start, and under parallel
 * CI load a single cold start exceeded 10 s before any product code ran.
 */
async function runSystemTool(tool: "icacls.exe" | "whoami.exe", args: string[]): Promise<string> {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error("Expected Windows system directory");
	const { stdout } = await execFileAsync(join(systemRoot, "System32", tool), args, { windowsHide: true });
	return stdout;
}

let currentSid: Promise<string> | undefined;

function getCurrentSid(): Promise<string> {
	currentSid ??= runSystemTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then((output) => {
		const sid = /"(S-1-[\d-]+)"/.exec(output)?.[1];
		if (!sid) throw new Error("whoami did not report the current user SID");
		return sid;
	});
	return currentSid;
}

/** The DACL of one file or directory as SDDL (`D:<flags>(ace)...`), read with `icacls /save`. */
async function readDaclSddl(path: string): Promise<string> {
	const scratch = mkdtempSync(join(tmpdir(), "volt-windows-acl-save-"));
	try {
		const saved = join(scratch, "acl.txt");
		await runSystemTool("icacls.exe", [path, "/save", saved, "/q"]);
		const bytes = readFileSync(saved);
		// icacls writes the save file as UTF-16LE: an entry-name line, then the SDDL line.
		const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes[1] === 0;
		const text = (utf16 ? bytes.toString("utf16le") : bytes.toString("utf8")).replace(/^\uFEFF/, "");
		const sddl = text.split(/\r?\n/).find((line) => line.startsWith("D:"));
		if (!sddl) throw new Error("icacls did not save a DACL");
		// Keep only the DACL. SIDs are written "S-...", so "S:" can only start a SACL.
		return sddl.replace(/S:.*$/, "");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

interface DaclSnapshot {
	protected: boolean;
	aces: Array<{ type: string; flags: string; rights: string; sid: string }>;
}

const SDDL_SID_ALIASES: Record<string, string> = { WD: "S-1-1-0", SY: "S-1-5-18", BA: "S-1-5-32-544" };

/** Parse a DACL SDDL string, resolving the SID aliases these fixtures can produce. */
function parseDacl(sddl: string, userSid: string): DaclSnapshot {
	const domain = userSid.slice(0, userSid.lastIndexOf("-"));
	const aliases: Record<string, string> = { ...SDDL_SID_ALIASES, LA: `${domain}-500`, LG: `${domain}-501` };
	const controlFlags = /^D:([^(]*)/.exec(sddl)?.[1] ?? "";
	return {
		// DACL control flags combine P, AI, AR, and NO_ACCESS_CONTROL; only P contains "P".
		protected: controlFlags.includes("P"),
		aces: [...sddl.matchAll(/\(([^)]*)\)/g)].map((match) => {
			const fields = (match[1] ?? "").split(";");
			const sid = fields[5] ?? "";
			return { type: fields[0] ?? "", flags: fields[1] ?? "", rights: fields[2] ?? "", sid: aliases[sid] ?? sid };
		}),
	};
}

async function readDacl(path: string): Promise<DaclSnapshot> {
	return parseDacl(await readDaclSddl(path), await getCurrentSid());
}

/**
 * Exactly one non-inherited FullControl ACE for the current user under a
 * protected DACL. icacls cannot report owners; ownership is enforced by the
 * native writer, which refuses to write unless the owner is the current user.
 */
async function expectUserOnlyAccess(path: string, kind: "directory" | "file"): Promise<void> {
	expect(await readDacl(path)).toEqual({
		protected: true,
		aces: [{ type: "A", flags: kind === "directory" ? "OICI" : "", rights: "FA", sid: await getCurrentSid() }],
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Windows private review diagnostics", () => {
	it("hardens a permissive diagnostic directory without changing its shared parent", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const agentDir = createRoot();
		await runSystemTool("icacls.exe", [agentDir, "/grant", "*S-1-1-0:(OI)(CI)F", "/q"]);
		const directory = getReviewPrivateDiagnosticsDirectory(agentDir);
		mkdirSync(directory);
		const parentBefore = await readDaclSddl(agentDir);
		expect((await readDacl(directory)).aces).toContainEqual(expect.objectContaining({ sid: "S-1-1-0" }));
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:windows-acl",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "Private concern." });

		const file = await diagnostics.flush();
		expect(file).toBeDefined();
		await expectUserOnlyAccess(directory, "directory");
		await expectUserOnlyAccess(file!, "file");
		expect(await readDaclSddl(agentDir)).toBe(parentBefore);
		expect(readFileSync(file!, "utf8")).toContain("Private concern.");
	});

	it("creates protected files with literal Unicode paths and diagnostic content", async () => {
		const path = join(createRoot(), "review '$(); 界", "record.jsonl");
		const content = '$(throw \'not executable\'); 界\n{"challenge":"private"}\n';
		await writeWindowsReviewDiagnostic(path, content);

		expect(readFileSync(path, "utf8")).toBe(content);
		await expectUserOnlyAccess(path, "file");
	});

	it("does not replace an existing file", async () => {
		const path = join(createRoot(), "review", "record.jsonl");
		await writeWindowsReviewDiagnostic(path, "original");

		await expect(writeWindowsReviewDiagnostic(path, "replacement")).rejects.toThrow(
			"Could not retain private Windows review diagnostics.",
		);
		expect(readFileSync(path, "utf8")).toBe("original");
	});

	it.each([false, true])("rejects a junction without changing its target (exists=%s)", async (targetExists) => {
		const root = createRoot();
		const target = join(root, "target");
		if (targetExists) mkdirSync(target);
		const targetBefore = targetExists ? await readDaclSddl(target) : undefined;
		const junction = join(root, "review-link");
		symlinkSync(target, junction, "junction");

		await expect(writeWindowsReviewDiagnostic(join(junction, "record.jsonl"), "private")).rejects.toThrow();
		expect(existsSync(join(target, "record.jsonl"))).toBe(false);
		if (targetExists) expect(await readDaclSddl(target)).toBe(targetBefore);
		else expect(existsSync(target)).toBe(false);
	});

	it("writes private diagnostics without a PowerShell installation", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const agentDir = createRoot();
		vi.stubEnv("SystemRoot", join(agentDir, "private-path-marker"));
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:native-writer",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "private-content-marker" });

		const file = await diagnostics.flush();
		expect(file).toBeDefined();
		expect(readFileSync(file!, "utf8")).toContain("private-content-marker");
		vi.unstubAllEnvs();
		await expectUserOnlyAccess(file!, "file");
	});

	it("secures concurrent writes into one newly created directory", async () => {
		const directory = join(createRoot(), "concurrent");
		const paths = Array.from({ length: 16 }, (_, index) => join(directory, `record-${index}.jsonl`));
		await Promise.all(paths.map((path, index) => writeWindowsReviewDiagnostic(path, `record ${index}\n`)));
		for (const [index, path] of paths.entries()) expect(readFileSync(path, "utf8")).toBe(`record ${index}\n`);
		await expectUserOnlyAccess(directory, "directory");
		await expectUserOnlyAccess(paths[0]!, "file");
	});
});
