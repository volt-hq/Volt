import { realpathSync, statSync } from "node:fs";
import { spawnProcessSync } from "../../utils/child-process.ts";
import type { LspLaunchDescriptor } from "./command-resolver.ts";

export interface LspVersionProbe {
	version?: string;
	compatible: boolean;
	reason: "compatible" | "incompatible-version" | "version-probe-failed";
}

/** Instance-scoped cache; restart/reload discard it. No probes for custom argv. */
export class LspVersionProbes {
	private cache = new Map<string, LspVersionProbe>();
	clear(): void {
		this.cache.clear();
	}
	probe(launch: LspLaunchDescriptor, cwd: string): LspVersionProbe {
		const executable = launch.resolvedExecutable!;
		const stat = statSync(executable);
		const identity = `${realpathSync(executable)}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		const cached = this.cache.get(identity);
		if (cached) return cached;
		const result = spawnProcessSync(executable, ["--version"], {
			cwd,
			env: launch.environment,
			encoding: "utf-8",
			timeout: 3000,
			maxBuffer: 8192,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const version =
			result.status === 0 ? /\bVersion\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i.exec(result.stdout ?? "")?.[1] : undefined;
		const compatible = version !== undefined && Number(version.split(".")[0]) >= 7;
		const probe: LspVersionProbe = {
			compatible,
			reason: compatible ? "compatible" : version ? "incompatible-version" : "version-probe-failed",
			...(version ? { version } : {}),
		};
		if (this.cache.size >= 128) this.cache.clear();
		this.cache.set(identity, probe);
		return probe;
	}
}
