import { afterEach, describe, expect, it, vi } from "vitest";
import {
	encodeIrohRemoteTicketPayload,
	getIrohRemotePairingVerificationDetails,
} from "../src/core/remote/iroh/ticket.ts";
import { resolveIrohRelayConfig, resolveIrohRelayCredentialServiceUrl } from "../src/daemon/iroh-service.ts";

const { profile } = vi.hoisted(() => ({
	profile: {
		deployments: [
			{
				name: "pairing-e2e",
				relayUrls: ["https://127.0.0.1:19443"],
				credentialServiceUrl: "https://127.0.0.1:18443",
			},
		],
		caRootsDer: [[1]],
	},
}));

vi.mock("../src/remote/iroh-deployment.ts", () => ({ IROH_DEPLOYMENT_PROFILE: profile }));

afterEach(() => vi.unstubAllEnvs());

describe("private build relay authority", () => {
	it("selects the isolated managed deployment without runtime overrides", () => {
		expect(resolveIrohRelayConfig({}, {})).toEqual({
			relayMode: "production",
			relayUrls: ["https://127.0.0.1:19443"],
		});
		expect(resolveIrohRelayCredentialServiceUrl("production", ["https://127.0.0.1:19443"])).toBe(
			"https://127.0.0.1:18443",
		);
	});

	it("cannot select another relay through settings, environment, or persisted authority", () => {
		const production = ["https://iroh-relay-us-central.volt-cli.dev"];
		expect(() => resolveIrohRelayConfig({ relayUrls: production }, {})).toThrow("another relay authority");
		expect(() => resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_URLS: production[0] })).toThrow(
			"another relay authority",
		);
		expect(() => resolveIrohRelayConfig({}, {}, production)).toThrow("another relay authority");
		for (const relayMode of ["disabled", "development"] as const) {
			expect(() => resolveIrohRelayConfig({ relayMode }, {})).toThrow("another relay authority");
		}
	});

	it("displays verification details only for the exact private relay origin", () => {
		const ticket = (relay: string) =>
			encodeIrohRemoteTicketPayload({
				alpn: "volt-rpc/0",
				irohTicket: "fixture",
				nodeId: "a".repeat(64),
				workspace: "workspace",
				relayMode: "production",
				relayUrls: [relay],
			});
		expect(getIrohRemotePairingVerificationDetails(ticket("https://127.0.0.1:19443")).relayOrigins).toEqual([
			"https://127.0.0.1:19443",
		]);
		for (const relay of [
			"https://127.0.0.1:19444",
			"https://localhost:19443",
			"https://iroh-relay-us-central.volt-cli.dev",
			"https://127.0.0.1:19443/path",
		]) {
			expect(() => getIrohRemotePairingVerificationDetails(ticket(relay))).toThrow("another relay authority");
		}
	});

	it("does not recognize production or canary as managed test deployments", () => {
		for (const relay of [
			"https://iroh-relay-us-central.volt-cli.dev",
			"https://iroh-relay-us-central-canary.volt-cli.dev",
		]) {
			expect(resolveIrohRelayCredentialServiceUrl("production", [relay])).toBeUndefined();
		}
		expect(() =>
			resolveIrohRelayCredentialServiceUrl(
				"production",
				["https://127.0.0.1:19443"],
				"https://credentials.volt-cli.dev",
			),
		).toThrow("conflicts with the pairing-e2e relay deployment");
	});
});
