import {
	type BenchmarkFixture,
	fixture,
	lookup,
	objectSchema,
	page,
	tool,
	validateArguments,
} from "./code-mode-fixture-utils.ts";

function cursorDedup(): BenchmarkFixture {
	const events = [
		{ id: "EVT-04", amountCents: 700 },
		{ id: "EVT-01", amountCents: 125 },
		{ id: "EVT-07", amountCents: -250 },
		{ id: "EVT-02", amountCents: 0 },
		{ id: "EVT-09", amountCents: 875 },
		{ id: "EVT-03", amountCents: 50 },
		{ id: "EVT-06", amountCents: -100 },
		{ id: "EVT-05", amountCents: 200 },
		{ id: "EVT-08", amountCents: 300 },
	];
	const cursors = [null, "evt:q7K", "evt:m2P", "evt:z9B"];
	const windows = [
		[0, 1, 2],
		[2, 3, 4],
		[1, 4, 5],
		[5, 6, 7, 8],
	];
	return fixture(
		{
			id: "cursor-dedup",
			prompt:
				"Read every event from the fixture MCP server, starting without a cursor and following each opaque nextCursor " +
				"until null. Pages overlap; repeated event ids have identical amounts. Count each event id once and sum its " +
				"signed amountCents using integers, including zero. Return JSON only with exactly these fields: " +
				"eventIds (unique event ids sorted ascending), uniqueCount (integer), totalCents (integer deduplicated sum).",
			tools: [
				tool(
					"list_events",
					"Read one overlapping event page. Omit cursor or use null for the first page; pass nextCursor unchanged " +
						"for subsequent pages. nextCursor null ends the stream. Repeated ids have identical amounts.",
					objectSchema({ cursor: { type: ["string", "null"] } }, []),
					objectSchema({
						records: {
							type: "array",
							maxItems: 4,
							items: objectSchema({ id: { type: "string" }, amountCents: { type: "integer" } }),
						},
						nextCursor: { type: ["string", "null"] },
					}),
				),
			],
			// The source contains each event once; page overlap is not part of the oracle computation.
			expected: {
				eventIds: events.map((event) => event.id).sort(),
				uniqueCount: events.length,
				totalCents: events.reduce((sum, event) => sum + event.amountCents, 0),
			},
			referenceCode: `let cursor = null;
const unique = new Map();
do {
  const result = (await tools.mcp.fixture.list_events({ cursor })).structured;
  for (const event of result.records) unique.set(event.id, event.amountCents);
  cursor = result.nextCursor;
} while (cursor !== null);
return {
  eventIds: [...unique.keys()].sort(),
  uniqueCount: unique.size,
  totalCents: [...unique.values()].reduce((sum, amount) => sum + amount, 0)
};`,
		},
		{
			list_events(args) {
				validateArguments(args, ["cursor"]);
				const cursor = Object.hasOwn(args, "cursor") ? args.cursor : null;
				if (cursor !== null && typeof cursor !== "string")
					throw new Error("cursor must be null or a returned token");
				const index = cursors.indexOf(cursor);
				if (index < 0) throw new Error("cursor must be null or a returned token");
				return {
					records: windows[index].map((eventIndex) => events[eventIndex]),
					nextCursor: cursors[index + 1] ?? null,
				};
			},
		},
	);
}

function groupedTopK(): BenchmarkFixture {
	const groups = [
		{ group: "gamma", amounts: [1200, -200, 0, 0] },
		{ group: "zeta", amounts: [90, -90, 0, 0] },
		{ group: "beta", amounts: [700, 700, 25, -25] },
		{ group: "delta", amounts: [400, 600, 100, -100] },
		{ group: "alpha", amounts: [1100, -100, 50, -50] },
		{ group: "epsilon", amounts: [150, -50, 0, 0] },
	];
	const ledger = Array.from({ length: 4 }, (_, round) =>
		groups.map((group, index) => ({
			id: `LINE-${round * groups.length + index + 1}`,
			group: group.group,
			amountCents: group.amounts[round],
		})),
	).flat();
	const totals = [...new Set(ledger.map((row) => row.group))].map((group) => ({
		group,
		totalCents: ledger.filter((row) => row.group === group).reduce((sum, row) => sum + row.amountCents, 0),
	}));
	totals.sort((a, b) => b.totalCents - a.totalCents || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
	return fixture(
		{
			id: "grouped-top-k",
			prompt:
				"Read all ledger pages from the fixture MCP server, following nextOffset until null. Group rows by group " +
				"and sum signed integer amountCents, including zero and negative entries. Rank groups by total descending, " +
				"breaking ties by group ascending in lexical code-point order. Return JSON only with exactly these fields: " +
				"topGroups (the first three ranked objects, each with exactly group and totalCents), groupCount " +
				"(integer number of all distinct groups, including zero-total groups).",
			tools: [
				tool(
					"list_ledger",
					"Read ledger entries in stable source order. Defaults: offset 0, limit 20; maximum limit 20. " +
						"Pass nextOffset as offset until it is null. Groups may span pages.",
					objectSchema(
						{
							offset: { type: "integer", minimum: 0, maximum: ledger.length, default: 0 },
							limit: { type: "integer", minimum: 1, maximum: 20, default: 20 },
						},
						[],
					),
					objectSchema({
						records: {
							type: "array",
							maxItems: 20,
							items: objectSchema({
								id: { type: "string" },
								group: { type: "string" },
								amountCents: { type: "integer" },
							}),
						},
						nextOffset: { type: ["integer", "null"], minimum: 0, maximum: ledger.length },
					}),
				),
			],
			expected: { topGroups: totals.slice(0, 3), groupCount: totals.length },
			referenceCode: `let offset = 0;
const totals = new Map();
do {
  const result = (await tools.mcp.fixture.list_ledger({ offset, limit: 20 })).structured;
  for (const row of result.records) totals.set(row.group, (totals.get(row.group) ?? 0) + row.amountCents);
  offset = result.nextOffset;
} while (offset !== null);
const ranked = [...totals].map(([group, totalCents]) => ({ group, totalCents }));
ranked.sort((a, b) => b.totalCents - a.totalCents || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
return { topGroups: ranked.slice(0, 3), groupCount: totals.size };`,
		},
		{ list_ledger: (args) => page(ledger, args) },
	);
}

function temporalAsof(): BenchmarkFixture {
	const cutoff = "2026-06-30T12:00:00Z";
	const versions = [
		{ id: "a-future", entityId: "alpha", effectiveAt: "2026-06-30T12:00:01Z", revision: 4, valueCents: 99999 },
		{ id: "b-z", entityId: "bravo", effectiveAt: "2026-06-20T00:00:00Z", revision: 3, valueCents: 900 },
		{ id: "e-new", entityId: "echo", effectiveAt: "2026-06-25T00:00:00Z", revision: 1, valueCents: -75 },
		{ id: "a-old", entityId: "alpha", effectiveAt: "2026-06-01T00:00:00Z", revision: 8, valueCents: 100 },
		{ id: "c-future", entityId: "charlie", effectiveAt: "2026-07-01T00:00:00Z", revision: 1, valueCents: 10000 },
		{ id: "b-a", entityId: "bravo", effectiveAt: "2026-06-20T00:00:00Z", revision: 3, valueCents: 600 },
		{ id: "d-zero", entityId: "delta", effectiveAt: "2026-06-29T00:00:00Z", revision: 1, valueCents: 0 },
		{ id: "a-cutoff", entityId: "alpha", effectiveAt: cutoff, revision: 1, valueCents: 1500 },
		{ id: "e-old", entityId: "echo", effectiveAt: "2026-06-02T00:00:00Z", revision: 20, valueCents: 500 },
		{ id: "b-low", entityId: "bravo", effectiveAt: "2026-06-20T00:00:00Z", revision: 2, valueCents: 999 },
	];
	const eligible = versions.filter((record) => record.effectiveAt <= cutoff);
	// Select records for which no eligible record of the same entity has higher precedence.
	const selected = eligible.filter(
		(record) =>
			!eligible.some(
				(other) =>
					other.entityId === record.entityId &&
					(other.effectiveAt > record.effectiveAt ||
						(other.effectiveAt === record.effectiveAt && other.revision > record.revision) ||
						(other.effectiveAt === record.effectiveAt &&
							other.revision === record.revision &&
							other.id < record.id)),
			),
	);
	selected.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
	return fixture(
		{
			id: "temporal-asof",
			prompt:
				`Read entity versions from the fixture MCP server. As of ${cutoff} inclusive, select one record per entity: ` +
				"greatest effectiveAt at or before the cutoff, then greatest revision at that timestamp, then lexically " +
				"smallest record id if still tied. All timestamps are UTC in the same fixed-width format. Exclude future " +
				"records and entities with no eligible record. Return JSON only with exactly these fields: selections " +
				"(objects with exactly entityId, recordId, valueCents, ordered by entityId ascending), totalCents " +
				"(signed integer sum of the selected valueCents). Lexical comparisons use code-point order.",
			tools: [
				tool(
					"list_versions",
					"Read all entity versions, including historical and future records; no server-side date filtering. " +
						"effectiveAt is a fixed-width UTC timestamp; revision is a positive integer. No pagination.",
					objectSchema({}),
					objectSchema({
						versions: {
							type: "array",
							maxItems: versions.length,
							items: objectSchema({
								id: { type: "string" },
								entityId: { type: "string" },
								effectiveAt: { type: "string", format: "date-time" },
								revision: { type: "integer", minimum: 1 },
								valueCents: { type: "integer" },
							}),
						},
					}),
				),
			],
			expected: {
				selections: selected.map((record) => ({
					entityId: record.entityId,
					recordId: record.id,
					valueCents: record.valueCents,
				})),
				totalCents: selected.reduce((sum, record) => sum + record.valueCents, 0),
			},
			referenceCode: `const result = (await tools.mcp.fixture.list_versions({})).structured;
const eligible = result.versions.filter(record => record.effectiveAt <= "2026-06-30T12:00:00Z");
eligible.sort((a, b) => (a.effectiveAt > b.effectiveAt ? -1 : a.effectiveAt < b.effectiveAt ? 1 : 0) ||
  b.revision - a.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const latest = new Map();
for (const record of eligible) if (!latest.has(record.entityId)) latest.set(record.entityId, record);
const selections = [...latest.values()].map(record => ({ entityId: record.entityId, recordId: record.id, valueCents: record.valueCents }));
selections.sort((a, b) => a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);
return { selections, totalCents: selections.reduce((sum, record) => sum + record.valueCents, 0) };`,
		},
		{
			list_versions(args) {
				validateArguments(args, []);
				return { versions };
			},
		},
	);
}

function reconciliation(): BenchmarkFixture {
	const items = ["PKG-04", "PKG-01", "PKG-03", "PKG-02", "PKG-05"].map((id) => ({ id }));
	const scans = ["PKG-03", "PKG-07", "PKG-01", "PKG-01", "PKG-04", "PKG-07", "PKG-03", "PKG-03"].map(
		(itemId, index) => ({ scanId: `SCAN-${index + 1}`, itemId }),
	);
	const observedIds = [...new Set(scans.map((scan) => scan.itemId))];
	return fixture(
		{
			id: "reconciliation",
			prompt:
				"Reconcile expected items against observed scans from the fixture MCP server, matching expected item.id to " +
				"scan.itemId. Compare distinct item ids, not scan ids. Return JSON only with exactly these fields: missingIds " +
				"(expected but never observed), unexpectedIds (observed but not expected), duplicateIds (item ids observed " +
				"more than once, including unexpected items), matchedCount (integer number of distinct expected ids observed). " +
				"Each id array must contain each applicable id once, sorted ascending.",
			tools: [
				tool(
					"list_expected_items",
					"Read every expected item id. No pagination.",
					objectSchema({}),
					objectSchema({
						items: { type: "array", maxItems: items.length, items: objectSchema({ id: { type: "string" } }) },
					}),
				),
				tool(
					"list_scans",
					"Read every observed scan with its unique scanId and possibly repeated itemId. No pagination.",
					objectSchema({}),
					objectSchema({
						scans: {
							type: "array",
							maxItems: scans.length,
							items: objectSchema({ scanId: { type: "string" }, itemId: { type: "string" } }),
						},
					}),
				),
			],
			expected: {
				missingIds: items
					.filter((item) => !observedIds.includes(item.id))
					.map((item) => item.id)
					.sort(),
				unexpectedIds: observedIds.filter((id) => !items.some((item) => item.id === id)).sort(),
				duplicateIds: observedIds.filter((id) => scans.filter((scan) => scan.itemId === id).length > 1).sort(),
				matchedCount: items.filter((item) => observedIds.includes(item.id)).length,
			},
			referenceCode: `const [expectedResult, observedResult] = await Promise.all([
  tools.mcp.fixture.list_expected_items({}), tools.mcp.fixture.list_scans({})
]);
const expected = new Set(expectedResult.structured.items.map(item => item.id));
const counts = new Map();
for (const scan of observedResult.structured.scans) counts.set(scan.itemId, (counts.get(scan.itemId) ?? 0) + 1);
return {
  missingIds: [...expected].filter(id => !counts.has(id)).sort(),
  unexpectedIds: [...counts.keys()].filter(id => !expected.has(id)).sort(),
  duplicateIds: [...counts.keys()].filter(id => counts.get(id) > 1).sort(),
  matchedCount: [...expected].filter(id => counts.has(id)).length
};`,
		},
		{
			list_expected_items(args) {
				validateArguments(args, []);
				return { items };
			},
			list_scans(args) {
				validateArguments(args, []);
				return { scans };
			},
		},
	);
}

function sparseSummary(): BenchmarkFixture {
	const readings: Array<{ id: string; reading?: number | null }> = [
		{ id: "S-01" },
		{ id: "S-02", reading: 0 },
		{ id: "S-03", reading: null },
		{ id: "S-04", reading: 8 },
		{ id: "S-05", reading: -8 },
		{ id: "S-06", reading: 0 },
		{ id: "S-07" },
		{ id: "S-08", reading: null },
		{ id: "S-09", reading: 19 },
		{ id: "S-10", reading: 0 },
	];
	const numeric = readings.flatMap((record) => (typeof record.reading === "number" ? [record.reading] : []));
	return fixture(
		{
			id: "sparse-summary",
			prompt:
				"Summarize all sensor readings from the fixture MCP server. A missing reading property, an explicit null, " +
				"and numeric zero are different states. Return JSON only with exactly these integer fields: recordCount " +
				"(all records), missingCount (reading property absent), nullCount (explicit null), zeroCount (numeric zero), " +
				"numericCount (all numeric readings, including zero), total (signed sum of numeric readings only). " +
				"Do not coerce missing or null values to zero.",
			tools: [
				tool(
					"list_readings",
					"Read all sensor records. reading may be absent, null, or an integer; absence is preserved. No pagination.",
					objectSchema({}),
					objectSchema({
						readings: {
							type: "array",
							maxItems: readings.length,
							items: objectSchema({ id: { type: "string" }, reading: { type: ["integer", "null"] } }, ["id"]),
						},
					}),
				),
			],
			expected: {
				recordCount: readings.length,
				missingCount: readings.filter((record) => !Object.hasOwn(record, "reading")).length,
				nullCount: readings.filter((record) => record.reading === null).length,
				zeroCount: numeric.filter((value) => value === 0).length,
				numericCount: numeric.length,
				total: numeric.reduce((sum, value) => sum + value, 0),
			},
			referenceCode: `const { readings } = (await tools.mcp.fixture.list_readings({})).structured;
const summary = { recordCount: readings.length, missingCount: 0, nullCount: 0, zeroCount: 0, numericCount: 0, total: 0 };
for (const record of readings) {
  if (!Object.hasOwn(record, "reading")) summary.missingCount++;
  else if (record.reading === null) summary.nullCount++;
  else {
    summary.numericCount++;
    if (record.reading === 0) summary.zeroCount++;
    summary.total += record.reading;
  }
}
return summary;`,
		},
		{
			list_readings(args) {
				validateArguments(args, []);
				return { readings };
			},
		},
	);
}

function threeWayJoin(): BenchmarkFixture {
	const customers = [
		{ id: "C-01", region: "north", active: true },
		{ id: "C-03", region: "south", active: true },
		{ id: "C-02", region: "north", active: true },
		{ id: "C-04", region: "north", active: false },
		{ id: "C-01", region: "north", active: true },
	];
	const orders = [
		{ id: "O-02", customerId: "C-01", status: "settled", amountCents: 2000 },
		{ id: "O-01", customerId: "C-01", status: "settled", amountCents: 1000 },
		{ id: "O-03", customerId: "C-02", status: "settled", amountCents: 500 },
		{ id: "O-04", customerId: "C-02", status: "pending", amountCents: 700 },
		{ id: "O-05", customerId: "C-03", status: "settled", amountCents: 900 },
		{ id: "O-06", customerId: "C-04", status: "settled", amountCents: 800 },
		{ id: "O-07", customerId: "C-missing", status: "settled", amountCents: 999 },
		{ id: "O-08", customerId: "C-02", status: "settled", amountCents: 300 },
		{ id: "O-01", customerId: "C-01", status: "settled", amountCents: 1000 },
	];
	const refunds = [
		{ id: "R-01", orderId: "O-01", status: "completed", amountCents: 100 },
		{ id: "R-02", orderId: "O-01", status: "completed", amountCents: 50 },
		{ id: "R-03", orderId: "O-02", status: "completed", amountCents: 200 },
		{ id: "R-04", orderId: "O-02", status: "pending", amountCents: 999 },
		{ id: "R-05", orderId: "O-03", status: "completed", amountCents: 500 },
		{ id: "R-06", orderId: "O-08", status: "pending", amountCents: 100 },
		{ id: "R-07", orderId: "O-missing", status: "completed", amountCents: 1000 },
		{ id: "R-01", orderId: "O-01", status: "completed", amountCents: 100 },
	];
	const selected = orders.filter(
		(order, index) =>
			orders.findIndex((other) => other.id === order.id) === index &&
			order.status === "settled" &&
			customers.some(
				(customer) => customer.id === order.customerId && customer.active && customer.region === "north",
			),
	);
	const selectedRefunds = refunds.filter(
		(refund, index) =>
			refunds.findIndex((other) => other.id === refund.id) === index &&
			refund.status === "completed" &&
			selected.some((order) => order.id === refund.orderId),
	);
	const grossCents = selected.reduce((sum, order) => sum + order.amountCents, 0);
	const refundCents = selectedRefunds.reduce((sum, refund) => sum + refund.amountCents, 0);
	return fixture(
		{
			id: "three-way-join",
			prompt:
				"Read customers, orders, and refunds from the fixture MCP server. Within each resource, repeated ids are " +
				"identical duplicates and must count once. Select settled orders whose customerId matches an active north " +
				"customer's id; exclude orders without a matching customer. Include selected orders with no completed refund. " +
				"Sum each selected order's amountCents once, not once per refund. Subtract only completed refunds with " +
				"orderId matching a selected order, each refund id once. Return JSON only with exactly these fields: orderIds " +
				"(unique selected ids sorted ascending), customerCount (distinct selected customers), grossCents (order sum), " +
				"refundCents (completed refund sum), netCents (grossCents minus refundCents). All sums and counts are integers.",
			tools: [
				tool(
					"list_customers",
					"Read all customer rows, including identical duplicate ids. No pagination.",
					objectSchema({}),
					objectSchema({
						customers: {
							type: "array",
							maxItems: customers.length,
							items: objectSchema({
								id: { type: "string" },
								region: { type: "string", enum: ["north", "south"] },
								active: { type: "boolean" },
							}),
						},
					}),
				),
				tool(
					"list_orders",
					"Read all order rows, including identical duplicate ids and unmatched customerId values. No pagination.",
					objectSchema({}),
					objectSchema({
						orders: {
							type: "array",
							maxItems: orders.length,
							items: objectSchema({
								id: { type: "string" },
								customerId: { type: "string" },
								status: { type: "string", enum: ["settled", "pending"] },
								amountCents: { type: "integer", minimum: 0 },
							}),
						},
					}),
				),
				tool(
					"list_refunds",
					"Read all refund rows, including identical duplicate ids and unmatched orderId values. No pagination.",
					objectSchema({}),
					objectSchema({
						refunds: {
							type: "array",
							maxItems: refunds.length,
							items: objectSchema({
								id: { type: "string" },
								orderId: { type: "string" },
								status: { type: "string", enum: ["completed", "pending"] },
								amountCents: { type: "integer", minimum: 0 },
							}),
						},
					}),
				),
			],
			expected: {
				orderIds: selected.map((order) => order.id).sort(),
				customerCount: new Set(selected.map((order) => order.customerId)).size,
				grossCents,
				refundCents,
				netCents: grossCents - refundCents,
			},
			referenceCode: `const [customerResult, orderResult, refundResult] = await Promise.all([
  tools.mcp.fixture.list_customers({}), tools.mcp.fixture.list_orders({}), tools.mcp.fixture.list_refunds({})
]);
const customers = new Map(customerResult.structured.customers.map(customer => [customer.id, customer]));
const orders = new Map(orderResult.structured.orders.map(order => [order.id, order]));
const refunds = new Map(refundResult.structured.refunds.map(refund => [refund.id, refund]));
const selected = [...orders.values()].filter(order => {
  const customer = customers.get(order.customerId);
  return order.status === "settled" && customer && customer.active && customer.region === "north";
});
const orderIds = selected.map(order => order.id).sort();
const selectedIds = new Set(orderIds);
const grossCents = selected.reduce((sum, order) => sum + order.amountCents, 0);
const refundCents = [...refunds.values()].filter(refund => refund.status === "completed" && selectedIds.has(refund.orderId))
  .reduce((sum, refund) => sum + refund.amountCents, 0);
return { orderIds, customerCount: new Set(selected.map(order => order.customerId)).size,
  grossCents, refundCents, netCents: grossCents - refundCents };`,
		},
		{
			list_customers(args) {
				validateArguments(args, []);
				return { customers };
			},
			list_orders(args) {
				validateArguments(args, []);
				return { orders };
			},
			list_refunds(args) {
				validateArguments(args, []);
				return { refunds };
			},
		},
	);
}

function independentFanout(): BenchmarkFixture {
	const resources = [
		{ id: "east-1", enabled: true, readyUnits: 100, reservedUnits: 20 },
		{ id: "east-2", enabled: true, readyUnits: 0, reservedUnits: 0 },
		{ id: "north-1", enabled: true, readyUnits: 55, reservedUnits: 5 },
		{ id: "north-2", enabled: false, readyUnits: 45, reservedUnits: 10 },
		{ id: "west-1", enabled: true, readyUnits: 10, reservedUnits: 10 },
		{ id: "west-2", enabled: true, readyUnits: 75, reservedUnits: 0 },
	];
	const enabled = resources.filter((resource) => resource.enabled);
	return fixture(
		{
			id: "independent-fanout",
			prompt:
				"Read these six resource snapshots from the fixture MCP server: east-1, east-2, north-1, north-2, west-1, west-2. " +
				"For enabled resources only, available units equal readyUnits minus reservedUnits. Include enabled resources " +
				"with zero available units. Return JSON only with exactly these fields: enabledIds (enabled resource ids " +
				"sorted ascending), enabledCount (integer), availableUnits (integer sum across enabled resources).",
			tools: [
				tool(
					"get_resource",
					"Read one resource snapshot by exact id. The six resources are independent; there is no bulk endpoint.",
					objectSchema({ id: { type: "string", enum: resources.map((resource) => resource.id) } }),
					objectSchema({
						id: { type: "string" },
						enabled: { type: "boolean" },
						readyUnits: { type: "integer", minimum: 0 },
						reservedUnits: { type: "integer", minimum: 0 },
					}),
				),
			],
			expected: {
				enabledIds: enabled.map((resource) => resource.id).sort(),
				enabledCount: enabled.length,
				availableUnits: enabled.reduce((sum, resource) => sum + resource.readyUnits - resource.reservedUnits, 0),
			},
			referenceCode: `const ids = ["east-1", "east-2", "north-1", "north-2", "west-1", "west-2"];
const results = await Promise.all(ids.map(id => tools.mcp.fixture.get_resource({ id })));
const enabled = results.map(result => result.structured).filter(resource => resource.enabled);
return {
  enabledIds: enabled.map(resource => resource.id).sort(),
  enabledCount: enabled.length,
  availableUnits: enabled.reduce((sum, resource) => sum + resource.readyUnits - resource.reservedUnits, 0)
};`,
		},
		{ get_resource: (args) => lookup(resources, args) },
	);
}

function emptyResult(): BenchmarkFixture {
	const candidates = [
		{ id: "CAN-01", status: "ready", region: "north", score: 89 },
		{ id: "CAN-02", status: "pending", region: "north", score: 99 },
		{ id: "CAN-03", status: "ready", region: "south", score: 99 },
		{ id: "CAN-04", status: "retired", region: "north", score: 100 },
		{ id: "CAN-05", status: "ready", region: "north", score: 0 },
		{ id: "CAN-06", status: "ready", region: "west", score: 90 },
		{ id: "CAN-07", status: "pending", region: "south", score: 40 },
	];
	const selected = candidates.filter(
		(candidate) => candidate.status === "ready" && candidate.region === "north" && candidate.score >= 90,
	);
	return fixture(
		{
			id: "empty-result",
			prompt:
				"Read all candidates from the fixture MCP server. Select only records with status ready, region north, and " +
				"score at least 90 (inclusive). Return JSON only with exactly these fields: candidateIds (matching ids sorted " +
				"ascending), matchedCount (integer count). If none match, return an empty candidateIds array and matchedCount 0.",
			tools: [
				tool(
					"list_candidates",
					"Read all candidate records with status, region, and integer score. No pagination or server-side filtering.",
					objectSchema({}),
					objectSchema({
						candidates: {
							type: "array",
							maxItems: candidates.length,
							items: objectSchema({
								id: { type: "string" },
								status: { type: "string", enum: ["ready", "pending", "retired"] },
								region: { type: "string", enum: ["north", "south", "west"] },
								score: { type: "integer", minimum: 0, maximum: 100 },
							}),
						},
					}),
				),
			],
			expected: { candidateIds: selected.map((candidate) => candidate.id).sort(), matchedCount: selected.length },
			referenceCode: `const { candidates } = (await tools.mcp.fixture.list_candidates({})).structured;
const selected = candidates.filter(candidate => candidate.status === "ready" && candidate.region === "north" && candidate.score >= 90);
return { candidateIds: selected.map(candidate => candidate.id).sort(), matchedCount: selected.length };`,
		},
		{
			list_candidates(args) {
				validateArguments(args, []);
				return { candidates };
			},
		},
	);
}

/** Deterministic, read-only data tasks with no transport, credentials, or provider dependencies. */
export function createDataRoutingFixtures(): BenchmarkFixture[] {
	return [
		cursorDedup(),
		groupedTopK(),
		temporalAsof(),
		reconciliation(),
		sparseSummary(),
		threeWayJoin(),
		independentFanout(),
		emptyResult(),
	];
}
