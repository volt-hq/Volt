import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import {
	createIrohRemoteProjectionSanitizer,
	type IrohRemoteSanitizerOptions,
} from "../src/core/remote/iroh/sanitizer.ts";

const FIXTURE_ROOT = join(tmpdir(), "volt-worktree-sanitizer");
const PARENT_PATH = join(FIXTURE_ROOT, "projects", "repo");
const WORKTREES_ROOT = join(FIXTURE_ROOT, ".volt", "agent", "worktrees");
const WORKTREE_PATH = join(WORKTREES_ROOT, "--repo--", "fix-login");

const OPTIONS: IrohRemoteSanitizerOptions = {
	remoteWorkspacePath: "/workspace",
	workspacePath: WORKTREE_PATH,
	additionalRedactedPaths: [PARENT_PATH, WORKTREES_ROOT],
};

/** `value` as the remote profile's path sanitizer redacts it with `options`. */
function sanitize(value: Record<string, unknown>, options: IrohRemoteSanitizerOptions): Record<string, unknown> {
	return createIrohRemoteProjectionSanitizer(options).sanitizeValue(value) as Record<string, unknown>;
}

function withMixedPathSeparators(value: string): string {
	let useSlash = false;
	return value.replace(/[\\/]/g, () => {
		useSlash = !useSlash;
		return useSlash ? "/" : "\\";
	});
}

describe("worktree sanitizer additionalRedactedPaths", () => {
	it("maps the worktree root in strict path fields and redacts the parent path in text", () => {
		const sanitized = sanitize(
			{
				cwd: WORKTREE_PATH,
				path: join(WORKTREE_PATH, "src", "index.ts"),
				text: `worktree of ${PARENT_PATH} under ${WORKTREES_ROOT} is ready`,
			},
			OPTIONS,
		);
		expect(sanitized.cwd).toBe("/workspace");
		expect(sanitized.path).toBe("/workspace/src/index.ts");
		expect(sanitized.text).not.toContain(PARENT_PATH);
		expect(sanitized.text).not.toContain(WORKTREES_ROOT);
		expect(sanitized.text).toBe("worktree of /workspace under /workspace is ready");
	});

	it("maps subpaths of additional roots in strict path fields", () => {
		const sanitized = sanitize(
			{
				cwd: join(PARENT_PATH, "src"),
				path: join(WORKTREES_ROOT, "pending-worktree"),
			},
			OPTIONS,
		);
		expect(sanitized.cwd).toBe("/workspace/src");
		expect(sanitized.path).toBe("/workspace/pending-worktree");
	});

	it("redacts git worktree list style output mentioning every root", () => {
		const sanitized = sanitize(
			{
				text: `${PARENT_PATH}  0f0f0f [main]\n` + `${WORKTREE_PATH}  1a1a1a [volt/fix-login]\n`,
			},
			OPTIONS,
		);
		expect(sanitized.text).not.toContain(PARENT_PATH);
		expect(sanitized.text).not.toContain(WORKTREES_ROOT);
	});

	it("redacts every root from the frames a worktree-bound stream sends", () => {
		// The roots the daemon and a relaying TUI serve a worktree-bound conversation with.
		const redactor = remoteProfile({
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: OPTIONS,
		}).redactor();
		const listing = `${PARENT_PATH}  0f0f0f [main]\n${WORKTREE_PATH}  1a1a1a [volt/fix-login]\n`;
		expect(redactor.redact({ type: "result", queryId: "q-1", data: { output: listing } })).toEqual({
			type: "result",
			queryId: "q-1",
			data: { output: "/workspace  0f0f0f [main]\n/workspace  1a1a1a [volt/fix-login]\n" },
		});
		const notice = redactor.redact({
			type: "live",
			subscriptionId: "s1",
			basedOn: 3,
			seq: 1,
			items: [{ type: "notice", level: "info", message: `created ${join(WORKTREES_ROOT, "pending")}` }],
		});
		expect(notice).toMatchObject({ items: [{ type: "notice", message: "created /workspace/pending" }] });
		expect(JSON.stringify(notice)).not.toContain(FIXTURE_ROOT);
	});

	it("redacts an additional root exactly like a primary sanitizer root", () => {
		// Parity contract: the parent checkout listed in additionalRedactedPaths is
		// redacted the same way it would be as the stream's own workspacePath (same
		// separator/normalization variant handling inside createSanitizerContext).
		const payload = {
			text: `Workspace ${join(PARENT_PATH, "src", "index.ts")} and gitdir ${join(PARENT_PATH, ".git", "worktrees", "fix-login")}`,
		};
		const asPrimary = sanitize(payload, { workspacePath: PARENT_PATH });
		const asAdditional = sanitize(payload, OPTIONS);
		expect(asAdditional.text).toBe(asPrimary.text);
		expect(asAdditional.text).not.toContain(PARENT_PATH);
	});

	it("redacts mixed Windows separator variants of additional roots", (context) => {
		if (process.platform !== "win32") {
			context.skip("mixed separators are only equivalent on Windows");
		}
		const mixedParentPath = withMixedPathSeparators(PARENT_PATH);
		const sanitized = sanitize({ text: `see ${mixedParentPath}/src/index.ts for details` }, OPTIONS);
		expect(sanitized.text).toBe("see /workspace/src/index.ts for details");
	});

	it("redacts Windows case variants of additional roots", (context) => {
		if (process.platform !== "win32") {
			context.skip("path comparison is case-sensitive outside Windows");
		}
		const sanitized = sanitize({ text: `see ${PARENT_PATH.toUpperCase()}\\src\\index.ts for details` }, OPTIONS);
		expect(sanitized.text).toBe("see /workspace/src/index.ts for details");
	});

	it("preserves literal POSIX backslashes around a redacted root", (context) => {
		if (process.platform === "win32") {
			context.skip("backslashes are path separators on Windows");
		}
		const sanitizedSuffix = sanitize({ text: `see ${PARENT_PATH}/file\\name for details` }, OPTIONS);
		expect(sanitizedSuffix.text).toBe("see /workspace/file\\name for details");

		const separatorIndex = PARENT_PATH.lastIndexOf("/");
		const literalBackslashPath = `${PARENT_PATH.slice(0, separatorIndex)}\\${PARENT_PATH.slice(separatorIndex + 1)}`;
		const sanitizedRoot = sanitize({ text: literalBackslashPath }, OPTIONS);
		expect(sanitizedRoot.text).toBe(literalBackslashPath);
	});

	it("redacts NFC and NFD normalization variants of the additional roots", () => {
		const nfcParent = join(FIXTURE_ROOT, "caf\u00e9", "repo"); // NFC "café"
		const nfdParent = join(FIXTURE_ROOT, "cafe\u0301", "repo"); // NFD "café"
		const options = {
			remoteWorkspacePath: "/workspace",
			workspacePath: WORKTREE_PATH,
			additionalRedactedPaths: [nfcParent],
		};
		for (const embedded of [nfcParent, nfdParent]) {
			const sanitized = sanitize({ text: `parent lives at ${embedded} on disk` }, options);
			expect(sanitized.text).not.toContain(nfcParent);
			expect(sanitized.text).not.toContain(nfdParent);
			expect(sanitized.text).toContain("/workspace");
		}
	});

	it("keeps paths under an additional root pointing at /workspace subpaths", () => {
		const sanitized = sanitize({ text: `see ${join(PARENT_PATH, "README.md")} for details` }, OPTIONS);
		expect(sanitized.text).toBe("see /workspace/README.md for details");
	});
});
