import type { IrohEndpointAddrLike, IrohModuleLike } from "./iroh-native.ts";

export function createIrohEndpointTicket(
	iroh: IrohModuleLike,
	address: IrohEndpointAddrLike,
	configuredRelayUrls: readonly string[],
): string {
	// Managed enrollment starts before the host has relay credentials. Its
	// observed address has no home relay yet, so publish the configured relay
	// as a dial hint rather than a Docker/LAN-only bootstrap ticket. This does
	// not assert registration or bypass relay/peer authentication.
	const relayUrl = address.relayUrl() ?? configuredRelayUrls[0];
	const ticketAddress = relayUrl ? new iroh.EndpointAddr(address.id(), relayUrl, address.directAddresses()) : address;
	return iroh.EndpointTicket.fromAddr(ticketAddress).toString();
}
