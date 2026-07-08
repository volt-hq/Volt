import { describe, expect, it } from "vitest";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { sanitizeIrohRemoteOutbound } from "../src/core/remote/iroh/outbound-filter.ts";
import { getRemoteSanitizerOptions } from "../src/daemon/workspace-streams.ts";

const PARENT_PATH = "/home/user/projects/repo";
const WORKTREES_ROOT = "/home/user/.volt/agent/worktrees";
const WORKTREE_PATH = `${WORKTREES_ROOT}/--home-user-projects-repo--/fix-login`;

const OPTIONS = {
	remoteWorkspacePath: "/workspace",
	workspacePath: WORKTREE_PATH,
	additionalRedactedPaths: [PARENT_PATH, WORKTREES_ROOT],
};

describe("worktree sanitizer additionalRedactedPaths", () => {
	it("maps the worktree root in strict path fields and redacts the parent path in text", () => {
		const sanitized = sanitizeIrohRemoteOutbound(
			{
				cwd: WORKTREE_PATH,
				path: `${WORKTREE_PATH}/src/index.ts`,
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
			text: `Workspace ${PARENT_PATH}/src/index.ts and gitdir ${PARENT_PATH}/.git/worktrees/fix-login`,
		};
		const asPrimary = sanitizeIrohRemoteOutbound(payload, { workspacePath: PARENT_PATH }) as Record<string, unknown>;
		const asAdditional = sanitizeIrohRemoteOutbound(payload, OPTIONS) as Record<string, unknown>;
		expect(asAdditional.text).toBe(asPrimary.text);
		expect(asAdditional.text).not.toContain(PARENT_PATH);
	});

	it("redacts NFC and NFD normalization variants of the additional roots", () => {
		const nfcParent = "/home/user/caf\u00e9/repo"; // NFC "café"
		const nfdParent = "/home/user/cafe\u0301/repo"; // NFD "café"
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
			{ text: `see ${PARENT_PATH}/README.md for details` },
			OPTIONS,
		) as Record<string, unknown>;
		expect(sanitized.text).toBe("see /workspace/README.md for details");
	});
});
