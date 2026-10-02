import type { EndpointTicket } from "@hansjm10/volt-iroh";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIrohEndpointTicket } from "../src/daemon/iroh-endpoint-ticket.ts";
import { type IrohEndpointLike, loadIrohModule } from "../src/daemon/iroh-native.ts";

const { iroh } = loadIrohModule();

describe.skipIf(!iroh)("native Iroh bootstrap tickets", () => {
	let endpoint: IrohEndpointLike;

	beforeAll(async () => {
		if (!iroh) throw new Error("native binding unavailable");
		const builder = iroh.Endpoint.builder();
		iroh.presetMinimal(builder);
		endpoint = await builder.bind();
	});

	afterAll(async () => {
		await endpoint?.close();
	});

	it("includes the configured relay before a managed host is online", () => {
		if (!iroh) throw new Error("native binding unavailable");
		const address = new iroh.EndpointAddr(endpoint.id(), null, ["172.18.0.2:58642"]);
		const ticket = createIrohEndpointTicket(iroh, address, ["https://relay.example.com"]);
		const decoded = (iroh.EndpointTicket as typeof EndpointTicket).fromString(ticket).endpointAddr();
		expect(decoded.relayUrl()).toBe("https://relay.example.com/");
		expect(decoded.id().toString()).toBe(endpoint.id().toString());
		expect(decoded.directAddresses()).toEqual(address.directAddresses());
		expect(address.relayUrl()).toBeNull();
	});

	it("preserves an observed home relay instead of replacing it with the first configured relay", () => {
		if (!iroh) throw new Error("native binding unavailable");
		const address = new iroh.EndpointAddr(endpoint.id(), "https://second.example.com", ["127.0.0.1:1234"]);
		const ticket = createIrohEndpointTicket(iroh, address, [
			"https://first.example.com",
			"https://second.example.com",
		]);
		expect(ticket).toBe(iroh.EndpointTicket.fromAddr(address).toString());
	});

	it("retains relay-free tickets when no relay is configured", () => {
		if (!iroh) throw new Error("native binding unavailable");
		const address = new iroh.EndpointAddr(endpoint.id(), null, ["127.0.0.1:1234"]);
		const ticket = createIrohEndpointTicket(iroh, address, []);
		expect(ticket).toBe(iroh.EndpointTicket.fromAddr(address).toString());
		expect((iroh.EndpointTicket as typeof EndpointTicket).fromString(ticket).endpointAddr().relayUrl()).toBeNull();
	});
});
