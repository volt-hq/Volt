import { resolvePath } from "../utils/paths.ts";
import { GitContextProvider } from "./git-context-provider.ts";

export interface GitContextProviderPoolAcquireOptions {
	/** Working directory the provider scans. */
	cwd: string;
	/** Host-owned display name for the repository. */
	workspaceName?: string;
	/** Trusted local base ref for managed-worktree divergence. */
	baseRef?: string;
}

/** One holder's share of a pooled provider. Release it instead of disposing the provider. */
export interface GitContextProviderLease {
	provider: GitContextProvider;
	/** Idempotent. The provider is disposed when its last lease is released. */
	release(): void;
}

/**
 * Shares Git context providers between the sessions of one delegation tree: a
 * session, its subagents, and its replacements. Leases are keyed by cwd,
 * workspace name, and base ref; a provider is disposed when its last lease is
 * released.
 */
export class GitContextProviderPool {
	private entries = new Map<string, { provider: GitContextProvider; leases: number }>();

	acquire(options: GitContextProviderPoolAcquireOptions): GitContextProviderLease {
		const cwd = resolvePath(options.cwd);
		const key = JSON.stringify([cwd, options.workspaceName ?? null, options.baseRef ?? null]);
		let entry = this.entries.get(key);
		if (!entry || entry.provider.isDisposed) {
			entry = {
				provider: new GitContextProvider(cwd, { workspaceName: options.workspaceName, baseRef: options.baseRef }),
				leases: 0,
			};
			this.entries.set(key, entry);
		}
		entry.leases++;
		const current = entry;
		let released = false;
		return {
			provider: current.provider,
			release: () => {
				if (released) return;
				released = true;
				current.leases--;
				if (current.leases > 0) return;
				if (this.entries.get(key) === current) this.entries.delete(key);
				current.provider.dispose();
			},
		};
	}
}
