import type { ControlRelayCredentialStatus, RemoteTransportHealth } from "./control-protocol.ts";

type RelayAccessState = ControlRelayCredentialStatus["state"];

const RELAY_ACCESS_LABELS: Readonly<Record<RelayAccessState, string>> = {
	unpaired: "not set up",
	pairing: "pairing in progress",
	active: "active",
	expired: "expired",
	subscription_inactive: "subscription inactive",
	revocation_pending: "credential reset pending",
};

/** Guidance for states where phones cannot reach this computer through the managed relay. */
const RELAY_ACCESS_GUIDANCE: Readonly<Partial<Record<RelayAccessState, string>>> = {
	subscription_inactive:
		"Renew Volt Pro; Volt reconnects automatically. After renewing, use /remote → Check relay access now.",
	expired: "Volt retries automatically. Check this computer's network connection.",
	revocation_pending: "Retry `volt remote credential revoke` when online, then pair again.",
};

/**
 * Phone access is ready when local transport is ready and managed relay access,
 * if configured, is not expired, suspended, or awaiting a reset. Unpaired and
 * pairing are setup states and do not count as unavailable.
 */
export function isRemoteAccessReady(status: {
	remoteTransport?: RemoteTransportHealth;
	relayCredential?: ControlRelayCredentialStatus;
}): boolean {
	return (
		status.remoteTransport?.state === "ready" &&
		(status.relayCredential === undefined || RELAY_ACCESS_GUIDANCE[status.relayCredential.state] === undefined)
	);
}

/** One-line relay access summary plus recovery guidance for unavailable states. */
export function formatRelayAccessStatus(
	relayCredential: ControlRelayCredentialStatus,
	now = Date.now(),
): { summary: string; guidance?: string } {
	const { state, nextRefreshAt } = relayCredential;
	let timing = "";
	if (state === "expired" || state === "subscription_inactive") {
		timing =
			nextRefreshAt === undefined ? " · checking now" : ` · next check in ${formatCheckDelay(nextRefreshAt - now)}`;
	}
	const guidance = RELAY_ACCESS_GUIDANCE[state];
	return { summary: `${RELAY_ACCESS_LABELS[state]}${timing}`, ...(guidance === undefined ? {} : { guidance }) };
}

function formatCheckDelay(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
