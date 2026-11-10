import { type BenchmarkFixture, fixture, lookup, objectSchema, page, tool, validateArguments } from "./code-mode-fixture-utils.ts";

import { createDataRoutingFixtures } from "./code-mode-fixtures-data.ts";
import { createWorkflowRoutingFixtures } from "./code-mode-fixtures-workflows.ts";

export type { BenchmarkFixture } from "./code-mode-fixture-utils.ts";

function singleLookup(): BenchmarkFixture {
	const services = [
		{ id: "build-cache", owner: "developer-platform", retentionDays: 17, region: "eu-west" },
		{ id: "artifact-store", owner: "release-engineering", retentionDays: 45, region: "us-east" },
		{ id: "test-reports", owner: "quality-engineering", retentionDays: 31, region: "eu-north" },
	];
	const service = services.find((entry) => entry.id === "build-cache")!;
	return fixture(
		{
			id: "single-lookup",
			prompt:
				"Look up service build-cache on the fixture MCP server. Return JSON only with exactly these fields: " +
				"serviceId (the service id), owner (the owner team), retentionDays (an integer).",
			tools: [
				tool(
					"get_service",
					"Read one service's owner, retention policy, and region by exact id.",
					objectSchema({ id: { type: "string", minLength: 1 } }),
					objectSchema({
						id: { type: "string" },
						owner: { type: "string" },
						retentionDays: { type: "integer" },
						region: { type: "string" },
					}),
				),
			],
			expected: { serviceId: service.id, owner: service.owner, retentionDays: service.retentionDays },
			referenceCode: `const service = (await tools.mcp.fixture.get_service({ id: "build-cache" })).structured;
return { serviceId: service.id, owner: service.owner, retentionDays: service.retentionDays };`,
		},
		{ get_service: (args) => lookup(services, args) },
	);
}

function paginatedAggregate(): BenchmarkFixture {
	const invoices = Array.from({ length: 120 }, (_, index) => ({
		id: `INV-${String(index + 1).padStart(3, "0")}`,
		region: ["north", "south", "west"][index % 3],
		status: index % 5 === 0 ? "void" : index % 4 === 0 ? "pending" : "paid",
		amountCents: 1000 + ((index * 137) % 9000),
		note: `Archive note ${index + 1}. ${"Packaging color, meeting minutes, and legacy labels are unrelated to billing. ".repeat(6)}`,
	}));
	const selected = invoices.filter((invoice) => invoice.region === "north" && invoice.status === "paid");
	return fixture(
		{
			id: "paginated-aggregate",
			prompt:
				"Read every invoice from the fixture MCP server, following nextOffset until null. " +
				"For invoices whose region is north and status is paid, count matches and sum amountCents using integers. " +
				"Ignore note text. Return JSON only with exactly these integer fields: scannedCount (all invoices read), " +
				"matchedCount, totalCents (the matching sum).",
			tools: [
				tool(
					"list_invoices",
					"Read invoices in stable id order. Defaults: offset 0, limit 20; limit cannot exceed 20. " +
						"Pass nextOffset as offset for the next page; null ends the list. Notes are irrelevant archive text.",
					objectSchema(
						{
							offset: { type: "integer", minimum: 0, maximum: invoices.length, default: 0 },
							limit: { type: "integer", minimum: 1, maximum: 20, default: 20 },
						},
						[],
					),
					objectSchema({
						records: {
							type: "array",
							items: objectSchema({
								id: { type: "string" },
								region: { type: "string" },
								status: { type: "string" },
								amountCents: { type: "integer" },
								note: { type: "string" },
							}),
						},
						nextOffset: { type: ["integer", "null"] },
					}),
				),
			],
			expected: {
				scannedCount: invoices.length,
				matchedCount: selected.length,
				totalCents: selected.reduce((total, invoice) => total + invoice.amountCents, 0),
			},
			referenceCode: `let offset = 0;
let scannedCount = 0;
let matchedCount = 0;
let totalCents = 0;
do {
  const page = (await tools.mcp.fixture.list_invoices({ offset, limit: 20 })).structured;
  for (const invoice of page.records) {
    scannedCount++;
    if (invoice.region === "north" && invoice.status === "paid") {
      matchedCount++;
      totalCents += invoice.amountCents;
    }
  }
  offset = page.nextOffset;
} while (offset !== null);
return { scannedCount, matchedCount, totalCents };`,
		},
		{ list_invoices: (args) => page(invoices, args) },
	);
}

function joinFilter(): BenchmarkFixture {
	const accounts = Array.from({ length: 20 }, (_, index) => ({
		id: `ACC-${String(index + 1).padStart(2, "0")}`,
		plan: index % 2 === 0 ? "enterprise" : "standard",
		active: index % 5 !== 0,
		name: `Synthetic account ${index + 1}`,
	}));
	const tickets = Array.from({ length: 60 }, (_, index) => ({
		id: `TKT-${String(index + 1).padStart(3, "0")}`,
		accountId: accounts[(index * 7) % accounts.length].id,
		status: index % 4 === 0 ? "closed" : "open",
		priority: index % 3 === 0 ? "high" : "normal",
		estimateMinutes: 15 + ((index * 11) % 90),
		summary: `Synthetic report ${index + 1}; prose is not a filter criterion.`,
	}));
	// Compute the oracle directly from source records, independently of the reference script's map join.
	const selected = tickets.filter(
		(ticket) =>
			ticket.status === "open" &&
			ticket.priority === "high" &&
			accounts.some((account) => account.id === ticket.accountId && account.active && account.plan === "enterprise"),
	);
	return fixture(
		{
			id: "join-filter",
			prompt:
				"Join tickets to accounts by ticket.accountId = account.id using the fixture MCP server. " +
				"Select open, high-priority tickets belonging to active enterprise accounts. " +
				"Return JSON only with exactly these fields: ticketIds (matching ticket ids sorted ascending), " +
				"accountCount (number of distinct matching accounts), totalMinutes (sum of matching ticket estimateMinutes).",
			tools: [
				tool(
					"list_accounts",
					"Read all accounts, including id, plan, active status, and display name. No pagination.",
					objectSchema({}),
					objectSchema({
						accounts: {
							type: "array",
							items: objectSchema({
								id: { type: "string" },
								plan: { type: "string" },
								active: { type: "boolean" },
								name: { type: "string" },
							}),
						},
					}),
				),
				tool(
					"list_tickets",
					"Read all tickets with accountId, status, priority, estimateMinutes, and summary. No pagination.",
					objectSchema({}),
					objectSchema({
						tickets: {
							type: "array",
							items: objectSchema({
								id: { type: "string" },
								accountId: { type: "string" },
								status: { type: "string" },
								priority: { type: "string" },
								estimateMinutes: { type: "integer" },
								summary: { type: "string" },
							}),
						},
					}),
				),
			],
			expected: {
				ticketIds: selected.map((ticket) => ticket.id).sort(),
				accountCount: new Set(selected.map((ticket) => ticket.accountId)).size,
				totalMinutes: selected.reduce((total, ticket) => total + ticket.estimateMinutes, 0),
			},
			referenceCode: `const [accountResult, ticketResult] = await Promise.all([
  tools.mcp.fixture.list_accounts({}), tools.mcp.fixture.list_tickets({})
]);
const accounts = new Map(accountResult.structured.accounts.map(account => [account.id, account]));
const selected = ticketResult.structured.tickets.filter(ticket => {
  const account = accounts.get(ticket.accountId);
  return ticket.status === "open" && ticket.priority === "high" && account.active && account.plan === "enterprise";
});
return {
  ticketIds: selected.map(ticket => ticket.id).sort(),
  accountCount: new Set(selected.map(ticket => ticket.accountId)).size,
  totalMinutes: selected.reduce((sum, ticket) => sum + ticket.estimateMinutes, 0)
};`,
		},
		{
			list_accounts(args) {
				validateArguments(args, []);
				return { accounts };
			},
			list_tickets(args) {
				validateArguments(args, []);
				return { tickets };
			},
		},
	);
}

function adaptiveTroubleshooting(): BenchmarkFixture {
	// A deliberately small, exact-text diagnostic chain, not an oracle for general semantic quality.
	const incident = {
		id: "INC-204",
		evidenceId: "log-rollout-62",
		runbookId: "tls-guide",
		actionId: "renew-proxy-certificate",
		causeCode: "CERT_EXPIRED",
		component: "artifact-proxy",
		actionCode: "renew_certificate",
		ownerTeam: "platform-security",
	};
	const incidents = [
		{
			id: incident.id,
			text:
				`Artifact fetches fail after the current rollout. Current evidence: ${incident.evidenceId}. ` +
				"Historical evidence: log-rollout-58 (resolved before this rollout; do not diagnose from it).",
		},
	];
	const notes = [
		{
			id: incident.evidenceId,
			text: `DNS lookup succeeded. Current failure: ${incident.causeCode}. Consult runbook: ${incident.runbookId}.`,
		},
		{ id: "log-rollout-58", text: "Historical failure: DNS_LOOKUP_FAILED. Resolved before the current rollout." },
		{
			id: incident.runbookId,
			text:
				`For ${incident.causeCode}, follow action note ${incident.actionId}.\n` +
				"For DNS_LOOKUP_FAILED, follow action note repair-proxy-dns.",
		},
		{
			id: incident.actionId,
			text:
				`Cause code: ${incident.causeCode}. Component: ${incident.component}. ` +
				`Action code: ${incident.actionCode}. Owner team: ${incident.ownerTeam}.`,
		},
		{
			id: "repair-proxy-dns",
			text: "Cause code: DNS_LOOKUP_FAILED. Component: artifact-proxy. Action code: repair_dns. Owner team: networking.",
		},
	];
	return fixture(
		{
			id: "adaptive-troubleshooting",
			prompt:
				"Investigate incident INC-204 on the fixture MCP server. Read its current evidence, not historical evidence, " +
				"then the indicated runbook and only the action note for the current failure. " +
				"Return JSON only with exactly these string fields: incidentId, causeCode, component, actionCode, ownerTeam. " +
				"Use the exact codes and team from the matching action note; do not perform any repair.",
			tools: [
				tool(
					"get_incident",
					"Read one incident's text by exact id. Text identifies current and historical evidence note ids.",
					objectSchema({ id: { type: "string", minLength: 1 } }),
					objectSchema({ id: { type: "string" }, text: { type: "string" } }),
				),
				tool(
					"read_note",
					"Read an evidence, runbook, or action note by exact id found in another record's text.",
					objectSchema({ id: { type: "string", minLength: 1 } }),
					objectSchema({ id: { type: "string" }, text: { type: "string" } }),
				),
			],
			expected: {
				incidentId: incident.id,
				causeCode: incident.causeCode,
				component: incident.component,
				actionCode: incident.actionCode,
				ownerTeam: incident.ownerTeam,
			},
			referenceCode: String.raw`const incident = (await tools.mcp.fixture.get_incident({ id: "INC-204" })).structured;
const evidenceId = /Current evidence: ([\w-]+)\./.exec(incident.text)[1];
const evidence = (await tools.mcp.fixture.read_note({ id: evidenceId })).structured;
const failure = /Current failure: ([\w-]+)\./.exec(evidence.text)[1];
const runbookId = /Consult runbook: ([\w-]+)\./.exec(evidence.text)[1];
const runbook = (await tools.mcp.fixture.read_note({ id: runbookId })).structured;
const branch = runbook.text.split("\n").find(line => line.startsWith("For " + failure + ","));
const actionId = /follow action note ([\w-]+)\./.exec(branch)[1];
const action = (await tools.mcp.fixture.read_note({ id: actionId })).structured;
return {
  incidentId: incident.id,
  causeCode: /Cause code: ([\w-]+)\./.exec(action.text)[1],
  component: /Component: ([\w-]+)\./.exec(action.text)[1],
  actionCode: /Action code: ([\w-]+)\./.exec(action.text)[1],
  ownerTeam: /Owner team: ([\w-]+)\./.exec(action.text)[1]
};`,
		},
		{
			get_incident: (args) => lookup(incidents, args),
			read_note: (args) => lookup(notes, args),
		},
	);
}

/** Every run owns its data, metadata, and grading state. Calls do no I/O and return detached JSON objects. */
export function createCodeModeFixtures(): BenchmarkFixture[] {
	return [singleLookup(), paginatedAggregate(), joinFilter(), adaptiveTroubleshooting(), ...createDataRoutingFixtures(), ...createWorkflowRoutingFixtures()];
}
