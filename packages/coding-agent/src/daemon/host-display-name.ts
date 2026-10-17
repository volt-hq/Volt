import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export interface HostDisplayNameSources {
	platform: NodeJS.Platform;
	readMacComputerName: () => string | undefined;
	hostname: () => string;
}

/**
 * The name paired clients show for this computer: the macOS Computer Name
 * ("Jordan's MacBook Pro") when available, otherwise the network hostname
 * without its mDNS `.local` suffix.
 */
export function resolveHostDisplayName(sources: HostDisplayNameSources): string | undefined {
	if (sources.platform === "darwin") {
		const computerName = sources.readMacComputerName()?.trim();
		if (computerName) return computerName;
	}
	const name = sources
		.hostname()
		.trim()
		.replace(/\.local$/i, "");
	return name.length > 0 ? name : undefined;
}

let cachedHostDisplayName: { value: string | undefined } | undefined;

/** Resolved once per process; a renamed computer shows after the daemon restarts. */
export function getHostDisplayName(): string | undefined {
	cachedHostDisplayName ??= {
		value: resolveHostDisplayName({ platform: process.platform, readMacComputerName, hostname }),
	};
	return cachedHostDisplayName.value;
}

function readMacComputerName(): string | undefined {
	try {
		return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		});
	} catch {
		return undefined;
	}
}
