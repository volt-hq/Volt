import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { sanitizeIrohRemoteOutbound } from "../src/core/remote/iroh/outbound-filter.ts";
import { getRemoteSanitizerOptions } from "../src/daemon/workspace-streams.ts";

const FIXTURE_ROOT = join(tmpdir(), "volt-worktree-sanitizer");
const PARENT_PATH = join(FIXTURE_ROOT, "projects", "repo");
const WORKTREES_ROOT = join(FIXTURE_ROOT, ".volt", "agent", "worktrees");
const WORKTREE_PATH = join(WORKTREES_ROOT, "--repo--", "fix-login");

const OPTIONS = {
	remoteWorkspacePath: "/workspace",
	workspacePath: WORKTREE_PATH,
	additionalRedactedPaths: [PARENT_PATH, WORKTREES_ROOT],
};

function withMixedPathSeparators(value: string): string {
	let useSlash = false;
	return value.replace(/[\\/]/g, () => {
		useSlash = !useSlash;
		return useSlash ? "/" : "\\";
	});
}

describe("worktree sanitizer additionalRedactedPaths", () => {
	it("maps the worktree root in strict path fields and redacts the parent path in text", () => {
		const sanitized = sanitizeIrohRemoteOutbound(
			{
				cwd: WORKTREE_PATH,
				path: join(WORKTREE_PATH, "src", "index.ts"),
				text: `worktree of ${PARENT_PATH} under ${WORKTREES_ROOT} is ready`,
			},
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.cwd).toBe("/workspace");
		expect(sanitized.path).toBe("/workspace/src/index.ts");
		expect(sanitized.text).not.toContain(PARENT_PATH);
		expect(sanitized.text).not.toContain(WORKTREES_ROOT);
		expect(sanitized.text).toBe("worktree of /workspace under /workspace is ready");
	});

	it("maps subpaths of additional roots in strict path fields", () => {
		const sanitized = sanitizeIrohRemoteOutbound(
			{
				cwd: join(PARENT_PATH, "src"),
				path: join(WORKTREES_ROOT, "pending-worktree"),
			},
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.cwd).toBe("/workspace/src");
		expect(sanitized.path).toBe("/workspace/pending-worktree");
	});

	it("redacts git worktree list style output mentioning every root", () => {
		const sanitized = sanitizeIrohRemoteOutbound(
			{
				text: `${PARENT_PATH}  0f0f0f [main]\n` + `${WORKTREE_PATH}  1a1a1a [volt/fix-login]\n`,
			},
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.text).not.toContain(PARENT_PATH);
		expect(sanitized.text).not.toContain(WORKTREES_ROOT);
	});

	it("redacts an additional root exactly like a primary sanitizer root", () => {
		// Parity contract: the parent checkout listed in additionalRedactedPaths is
		// redacted the same way it would be as the stream's own workspacePath (same
		// separator/normalization variant handling inside createSanitizerContext).
		const payload = {
			text: `Workspace ${join(PARENT_PATH, "src", "index.ts")} and gitdir ${join(PARENT_PATH, ".git", "worktrees", "fix-login")}`,
		};
		const asPrimary = sanitizeIrohRemoteOutbound(payload, { workspacePath: PARENT_PATH }) as Record<string, unknown>;
		const asAdditional = sanitizeIrohRemoteOutbound(payload, OPTIONS) as Record<string, unknown>;
		expect(asAdditional.text).toBe(asPrimary.text);
		expect(asAdditional.text).not.toContain(PARENT_PATH);
	});

	it("redacts mixed Windows separator variants of additional roots", (context) => {
		if (process.platform !== "win32") {
			context.skip("mixed separators are only equivalent on Windows");
		}
		const mixedParentPath = withMixedPathSeparators(PARENT_PATH);
		const sanitized = sanitizeIrohRemoteOutbound(
			{ text: `see ${mixedParentPath}/src/index.ts for details` },
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.text).toBe("see /workspace/src/index.ts for details");
	});

	it("redacts Windows case variants of additional roots", (context) => {
		if (process.platform !== "win32") {
			context.skip("path comparison is case-sensitive outside Windows");
		}
		const sanitized = sanitizeIrohRemoteOutbound(
			{ text: `see ${PARENT_PATH.toUpperCase()}\\src\\index.ts for details` },
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.text).toBe("see /workspace/src/index.ts for details");
	});

	it("preserves literal POSIX backslashes around a redacted root", (context) => {
		if (process.platform === "win32") {
			context.skip("backslashes are path separators on Windows");
		}
		const sanitizedSuffix = sanitizeIrohRemoteOutbound(
			{ text: `see ${PARENT_PATH}/file\\name for details` },
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitizedSuffix.text).toBe("see /workspace/file\\name for details");

		const separatorIndex = PARENT_PATH.lastIndexOf("/");
		const literalBackslashPath = `${PARENT_PATH.slice(0, separatorIndex)}\\${PARENT_PATH.slice(separatorIndex + 1)}`;
		const sanitizedRoot = sanitizeIrohRemoteOutbound({ text: literalBackslashPath }, OPTIONS) as Record<
			string,
			unknown
		>;
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
			const sanitized = sanitizeIrohRemoteOutbound(
				{ text: `parent lives at ${embedded} on disk` },
				options,
			) as Record<string, unknown>;
			expect(sanitized.text).not.toContain(nfcParent);
			expect(sanitized.text).not.toContain(nfdParent);
			expect(sanitized.text).toContain("/workspace");
		}
	});

	it("getRemoteSanitizerOptions folds the worktree overrides into the sanitizer options", () => {
		const authorization = {
			workspace: { name: "ws", path: PARENT_PATH },
		} as IrohRemoteClientAuthorizationSuccess;

		// Non-worktree streams: unchanged shape, no extra roots.
		expect(getRemoteSanitizerOptions(authorization)).toEqual({
			remoteWorkspacePath: "/workspace",
			workspacePath: PARENT_PATH,
		});

		// Worktree-bound streams: worktree root + parent/worktrees-root redaction.
		expect(
			getRemoteSanitizerOptions(authorization, {
				workspacePath: WORKTREE_PATH,
				additionalRedactedPaths: [PARENT_PATH, WORKTREES_ROOT],
			}),
		).toEqual({
			remoteWorkspacePath: "/workspace",
			workspacePath: WORKTREE_PATH,
			additionalRedactedPaths: [PARENT_PATH, WORKTREES_ROOT],
		});
	});

	it("keeps paths under an additional root pointing at /workspace subpaths", () => {
		const sanitized = sanitizeIrohRemoteOutbound(
			{ text: `see ${join(PARENT_PATH, "README.md")} for details` },
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.text).toBe("see /workspace/README.md for details");
	});
});
