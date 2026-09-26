import { describe, expect, it } from "vitest";
import type { ControlRelayCredentialStatus, RemoteTransportHealth } from "../src/daemon/control-protocol.ts";
import { formatRelayAccessStatus, isRemoteAccessReady } from "../src/daemon/relay-access-status.ts";

const READY: RemoteTransportHealth = { state: "ready" };
const NOW = 1_790_000_000_000;

describe("relay access status", () => {
	it.each([
		["unpaired", true],
		["pairing", true],
		["active", true],
		["expired", false],
		["subscription_inactive", false],
		["revocation_pending", false],
	] as const)("treats %s relay access as ready=%s when transport is ready", (state, ready) => {
		expect(isRemoteAccessReady({ remoteTransport: READY, relayCredential: { state } })).toBe(ready);
	});

	it("requires ready transport regardless of relay access", () => {
		expect(isRemoteAccessReady({ remoteTransport: READY })).toBe(true);
		expect(isRemoteAccessReady({})).toBe(false);
		expect(
			isRemoteAccessReady({ remoteTransport: { state: "starting" }, relayCredential: { state: "active" } }),
		).toBe(false);
		expect(
			isRemoteAccessReady({
				remoteTransport: { state: "degraded", reasonCode: "host_storage_full" },
				relayCredential: { state: "active" },
			}),
		).toBe(false);
	});

	it.each([
		[NOW + 14_200, "subscription inactive · next check in 15s"],
		[NOW + 300_000, "subscription inactive · next check in 5m"],
		[NOW + 3_600_000, "subscription inactive · next check in 1h 0m"],
		[NOW + 90_500, "subscription inactive · next check in 1m 31s"],
		[NOW - 5_000, "subscription inactive · next check in 0s"],
		[undefined, "subscription inactive · checking now"],
	])("summarizes a suspended subscription with next check %s", (nextRefreshAt, summary) => {
		const relay: ControlRelayCredentialStatus = {
			state: "subscription_inactive",
			...(nextRefreshAt === undefined ? {} : { nextRefreshAt }),
		};
		const formatted = formatRelayAccessStatus(relay, NOW);
		expect(formatted.summary).toBe(summary);
		expect(formatted.guidance).toContain("Renew Volt Pro");
		expect(formatted.guidance).toContain("Check relay access now");
	});

	it("gives recovery guidance only for unavailable states", () => {
		expect(formatRelayAccessStatus({ state: "expired", nextRefreshAt: NOW + 2_000 }, NOW)).toEqual({
			summary: "expired · next check in 2s",
			guidance: "Volt retries automatically. Check this computer's network connection.",
		});
		expect(formatRelayAccessStatus({ state: "revocation_pending" }, NOW)).toEqual({
			summary: "credential reset pending",
			guidance: expect.stringContaining("volt remote credential revoke"),
		});
		for (const [state, summary] of [
			["active", "active"],
			["unpaired", "not set up"],
			["pairing", "pairing in progress"],
		] as const) {
			// A proactive refresh time is not shown for healthy or setup states.
			expect(formatRelayAccessStatus({ state, nextRefreshAt: NOW + 60_000 }, NOW)).toEqual({ summary });
		}
	});
});
