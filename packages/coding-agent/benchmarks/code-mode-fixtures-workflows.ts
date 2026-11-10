import {
	type BenchmarkFixture,
	fixture,
	lookup,
	objectSchema,
	tool,
	validateArguments,
} from "./code-mode-fixture-utils.ts";

function nestedProjection(): BenchmarkFixture {
	const config = {
		id: "release-console",
		defaults: { enabled: true, retries: 4, label: "Default" },
		environments: {
			staging: { enabled: true, retries: 2, label: "Staging" },
			production: { enabled: false, retries: 0, label: "Review \"A\"\\B\nnext" },
		},
	};
	return fixture({
		id: "nested-projection",
		prompt: "Read release-console configuration. For production, explicitly present fields override defaults, including false and zero. " +
			"Return JSON only with exactly enabled (boolean), retries (integer), and label (the exact string, preserving quotes, backslash, and newline).",
		tools: [tool("get_release_config", "Read defaults and environment overrides for a release-console configuration by id.",
			objectSchema({ id: { type: "string" } }), objectSchema({
				id: { type: "string" }, defaults: { type: "object" }, environments: { type: "object" },
			}))],
		expected: { ...config.defaults, ...config.environments.production },
		referenceCode: `const config = (await tools.mcp.fixture.get_release_config({id:"release-console"})).structured;
const value = {...config.defaults, ...config.environments.production};
return {enabled:value.enabled, retries:value.retries, label:value.label};`,
	}, { get_release_config: (args) => lookup([config], args) });
}

function hierarchyRollup(): BenchmarkFixture {
	const nodes = [
		{ id: "company", active: true, budget: 100, children: ["ops", "apps"] },
		{ id: "ops", active: true, budget: 20, children: ["shared"] },
		{ id: "apps", active: true, budget: 30, children: ["shared", "web"] },
		{ id: "shared", active: true, budget: 40, children: [] },
		{ id: "web", active: false, budget: 50, children: [] },
		{ id: "unrelated", active: true, budget: 9000, children: [] },
	];
	const reachable = new Set(["company"]);
	for (let changed = true; changed;) {
		changed = false;
		for (const node of nodes.filter((node) => reachable.has(node.id))) {
			for (const child of node.children) if (!reachable.has(child)) { reachable.add(child); changed = true; }
		}
	}
	const selected = nodes.filter((node) => reachable.has(node.id));
	return fixture({
		id: "hierarchy-rollup",
		prompt: "Starting at department company, traverse all child links. Shared departments count only once, even if multiple parents reference them. " +
			"Include the root and inactive nodes in nodeCount, but sum budget only for active nodes. Return JSON only with exactly nodeCount, activeBudget, " +
			"and leafIds (all reachable nodes with no children, sorted ascending, including inactive leaves).",
		tools: [tool("get_department", "Read one department by id: active flag, integer budget, and child department IDs. Links may share children.",
			objectSchema({ id: { type: "string" } }), objectSchema({ id: { type: "string" }, active: { type: "boolean" },
				budget: { type: "integer" }, children: { type: "array", items: { type: "string" } } }))],
		expected: { nodeCount: selected.length, activeBudget: selected.reduce((sum, node) => sum + (node.active ? node.budget : 0), 0),
			leafIds: selected.filter((node) => !node.children.length).map((node) => node.id).sort() },
		referenceCode: `const queue = ["company"], seen = new Set(), leaves = [];
let activeBudget = 0;
while (queue.length) {
  const id = queue.shift();
  if (seen.has(id)) continue;
  seen.add(id);
  const node = (await tools.mcp.fixture.get_department({id})).structured;
  if (node.active) activeBudget += node.budget;
  if (!node.children.length) leaves.push(id);
  queue.push(...node.children);
}
return {nodeCount:seen.size, activeBudget, leafIds:leaves.sort()};`,
	}, { get_department: (args) => lookup(nodes, args) });
}

function intervalOverlap(): BenchmarkFixture {
	const reservations = [
		{ id: "r1", resource: "gpu-a", start: 100, end: 120, cancelled: false },
		{ id: "r2", resource: "gpu-a", start: 120, end: 150, cancelled: false },
		{ id: "r3", resource: "gpu-a", start: 140, end: 170, cancelled: false },
		{ id: "r4", resource: "gpu-a", start: 170, end: 185, cancelled: false },
		{ id: "r5", resource: "gpu-a", start: 180, end: 200, cancelled: false },
		{ id: "r6", resource: "gpu-b", start: 120, end: 180, cancelled: false },
		{ id: "r7", resource: "gpu-a", start: 130, end: 190, cancelled: true },
	];
	const selected = reservations.filter((row) => row.resource === "gpu-a" && !row.cancelled && row.start < 180 && row.end > 120);
	const covered = Array.from({ length: 60 }, (_, i) => i + 120).filter((minute) => selected.some((row) => row.start <= minute && minute < row.end));
	return fixture({
		id: "interval-overlap",
		prompt: "Read reservations for gpu-a intersecting the half-open minute window [120,180). Exclude cancelled reservations and other resources. " +
			"Touching only a window boundary is not overlap. Return JSON only with exactly reservationIds (sorted ascending) and coveredMinutes " +
			"(the union length inside the window, not the sum of overlapping durations).",
		tools: [tool("list_reservations", "Read all reservations; start/end are integer minutes and intervals are half-open. No filtering or pagination.",
			objectSchema({}), objectSchema({ reservations: { type: "array", items: objectSchema({ id: { type: "string" },
				resource: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, cancelled: { type: "boolean" } }) } }))],
		expected: { reservationIds: selected.map((row) => row.id).sort(), coveredMinutes: covered.length },
		referenceCode: `const rows = (await tools.mcp.fixture.list_reservations({})).structured.reservations;
const selected = rows.filter(r=>r.resource==="gpu-a" && !r.cancelled && r.start<180 && r.end>120);
const intervals = selected.map(r=>[Math.max(120,r.start),Math.min(180,r.end)]).sort((a,b)=>a[0]-b[0]);
let coveredMinutes=0, end=120;
for (const [start, stop] of intervals) { coveredMinutes+=Math.max(0,stop-Math.max(start,end)); end=Math.max(end,stop); }
return {reservationIds:selected.map(r=>r.id).sort(), coveredMinutes};`,
	}, { list_reservations(args) { validateArguments(args, []); return { reservations }; } });
}

function textLogExtraction(): BenchmarkFixture {
	const events = [
		{ level: "ERROR", service: "api", code: "E_TIMEOUT", message: "first | attempt" },
		{ level: "WARN", service: "api", code: "E_TIMEOUT", message: "not an error" },
		{ level: "ERROR", service: "worker", code: "E_AUTH", message: "ignore other service" },
		{ level: "INFO", service: "api", code: "OK", message: "mentions ERROR|api|E_FAKE" },
		{ level: "ERROR", service: "api", code: "E_AUTH", message: "expired token (synthetic)" },
		{ level: "ERROR", service: "api", code: "E_TIMEOUT", message: "retry" },
		{ level: "ERROR", service: "api", code: "E_RATE", message: "capacity" },
		{ level: "ERROR", service: "api", code: "E_AUTH", message: "still expired" },
		{ level: "DEBUG", service: "api", code: "E_AUTH", message: "trace" },
	];
	const selected = events.filter((row) => row.level === "ERROR" && row.service === "api");
	const codes = [...new Set(selected.map((row) => row.code))].sort();
	const pages = Array.from({ length: 3 }, (_, page) => ({
		text: events.slice(page * 3, page * 3 + 3).map((row) => [row.level, row.service, row.code, row.message].join("|")).join("\n") + "\n",
		nextPage: page < 2 ? page + 1 : null,
	}));
	return fixture({
		id: "text-log-extraction",
		prompt: "Read log pages starting at page 0 until nextPage is null. Each nonblank line is LEVEL|service|code|message; the message may contain more pipes. " +
			"Count only exact ERROR level for service api, using the first three columns, not words in the message. " +
			"Return JSON only with exactly errorCount and counts (objects with code and count, sorted ascending by code).",
		tools: [tool("read_log_page", "Read a page of pipe-delimited synthetic logs. Page index starts at zero; nextPage=null ends the log.",
			objectSchema({ page: { type: "integer", minimum: 0, maximum: 2 } }), objectSchema({ text: { type: "string" }, nextPage: { type: ["integer", "null"] } }))],
		expected: { errorCount: selected.length, counts: codes.map((code) => ({ code, count: selected.filter((row) => row.code === code).length })) },
		referenceCode: `let page=0, errorCount=0; const counts=new Map();
do {
  const result=(await tools.mcp.fixture.read_log_page({page})).structured;
  for (const line of result.text.split("\\n")) {
    const [level,service,code]=line.split("|");
    if(level==="ERROR" && service==="api") {errorCount++; counts.set(code,(counts.get(code)??0)+1);}
  }
  page=result.nextPage;
} while(page!==null);
return {errorCount, counts:[...counts.keys()].sort().map(code=>({code,count:counts.get(code)}))};`,
	}, { read_log_page(args) {
		validateArguments(args, ["page"]);
		if (typeof args.page !== "number" || !Number.isInteger(args.page) || args.page < 0 || args.page >= pages.length) throw new Error("page must be an integer from 0 through 2");
		return pages[args.page];
	} });
}

function policyPrecedence(): BenchmarkFixture {
	const subjects = [{ id: "cache", team: "platform" }, { id: "billing", team: "finance" }, { id: "reports", team: "platform" }];
	const rules = [
		{ id: "global", scope: "global", target: "*", priority: 99, effect: "deny", enabled: true },
		{ id: "platform", scope: "team", target: "platform", priority: 1, effect: "allow", enabled: true },
		{ id: "cache-allow", scope: "resource", target: "cache", priority: 2, effect: "allow", enabled: true },
		{ id: "cache-deny", scope: "resource", target: "cache", priority: 2, effect: "deny", enabled: true },
		{ id: "billing-off", scope: "resource", target: "billing", priority: 100, effect: "allow", enabled: false },
		{ id: "other", scope: "team", target: "other", priority: 100, effect: "allow", enabled: true },
	];
	const decisions = subjects.map((subject) => {
		let winner = rules[0];
		let best = -1;
		for (const rule of rules) {
			const specificity = rule.scope === "resource" ? 2 : rule.scope === "team" ? 1 : 0;
			if (!rule.enabled || (specificity === 2 && rule.target !== subject.id) || (specificity === 1 && rule.target !== subject.team)) continue;
			const score = specificity * 10_000 + rule.priority * 2 + (rule.effect === "deny" ? 1 : 0);
			if (score > best || (score === best && rule.id < winner.id)) { best = score; winner = rule; }
		}
		return { resourceId: subject.id, effect: winner.effect, ruleId: winner.id };
	}).sort((left, right) => left.resourceId.localeCompare(right.resourceId));
	return fixture({
		id: "policy-precedence",
		prompt: "Evaluate the read-only synthetic access rules for every policy subject. Ignore disabled/nonmatching rules. " +
			"Resource scope outranks team scope, which outranks global, regardless of priority. Within a scope, higher priority wins; " +
			"ties prefer deny over allow, then lexically smallest rule id. Return JSON only with exactly decisions " +
			"(objects with resourceId, effect, ruleId, sorted ascending by resourceId). Do not change any policy.",
		tools: [
			tool("list_policy_subjects", "Read all policy subjects, each with resource id and team.", objectSchema({}),
				objectSchema({ subjects: { type: "array", items: objectSchema({ id: { type: "string" }, team: { type: "string" } }) } })),
			tool("list_access_rules", "Read all synthetic rules. Scope is global/team/resource; target is */team/resource id; effect is allow/deny.", objectSchema({}),
				objectSchema({ rules: { type: "array", items: objectSchema({ id: { type: "string" }, scope: { enum: ["global", "team", "resource"] },
					target: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 100 }, effect: { enum: ["allow", "deny"] }, enabled: { type: "boolean" } }) } })),
		],
		expected: { decisions },
		referenceCode: `const [a,b]=await Promise.all([tools.mcp.fixture.list_policy_subjects({}),tools.mcp.fixture.list_access_rules({})]);
const rank={global:0,team:1,resource:2};
const decisions=a.structured.subjects.map(s=>{
  const matches=b.structured.rules.filter(r=>r.enabled && (r.scope==="global" || (r.scope==="team" ? r.target===s.team : r.target===s.id)));
  matches.sort((a,b)=>rank[b.scope]-rank[a.scope] || b.priority-a.priority || Number(b.effect==="deny")-Number(a.effect==="deny") || (a.id<b.id?-1:a.id>b.id?1:0));
  return {resourceId:s.id,effect:matches[0].effect,ruleId:matches[0].id};
}).sort((a,b)=>a.resourceId<b.resourceId?-1:a.resourceId>b.resourceId?1:0);
return {decisions};`,
	}, {
		list_policy_subjects(args) { validateArguments(args, []); return { subjects }; },
		list_access_rules(args) { validateArguments(args, []); return { rules }; },
	});
}

function boundedSearch(): BenchmarkFixture {
	const builds = Array.from({ length: 64 }, (_, index) => ({ index, passed: index < 37 }));
	const first = builds.find((build) => !build.passed)!.index;
	return fixture({
		id: "bounded-search",
		prompt: "Build indices 0 through 63 are ordered. All builds before one boundary pass; every build at/after it fails. " +
			"At least one build passes and one fails. Find the first failing index through the fixture status tool, without assuming its value. " +
			"Return JSON only with exactly firstFailed and lastPassing (integer indices).",
		tools: [tool("get_build_status", "Read pass/fail status for one build index in the ordered monotone build history.",
			objectSchema({ index: { type: "integer", minimum: 0, maximum: 63 } }), objectSchema({ index: { type: "integer" }, passed: { type: "boolean" } }))],
		expected: { firstFailed: first, lastPassing: first - 1 },
		referenceCode: `let lo=0, hi=64;
while(lo<hi){ const index=Math.floor((lo+hi)/2); const build=(await tools.mcp.fixture.get_build_status({index})).structured;
  if(build.passed) lo=index+1; else hi=index;
}
return {firstFailed:lo,lastPassing:lo-1};`,
	}, { get_build_status(args) {
		validateArguments(args, ["index"]);
		if (typeof args.index !== "number" || !Number.isInteger(args.index) || args.index < 0 || args.index > 63) throw new Error("index must be an integer from 0 through 63");
		return builds[args.index];
	} });
}

function partitionAvailability(): BenchmarkFixture {
	const partitions = [
		{ id: "north", status: "available", count: 10, amountCents: 500 },
		{ id: "south", status: "available", count: 0, amountCents: 0 },
		{ id: "west", status: "unavailable", count: null, amountCents: null },
		{ id: "east", status: "available", count: 3, amountCents: 75 },
		{ id: "central", status: "available", count: 2, amountCents: 25 },
	];
	return fixture({
		id: "partition-availability",
		prompt: "Read partitions north, south, west, east, central. Sum count and amountCents for available partitions only. " +
			"Unavailable data is unknown, not zero. Return JSON only with exactly knownCount, knownCents, unavailableIds (sorted ascending), " +
			"and complete (true only if every partition is available).",
		tools: [tool("get_partition", "Read a partition report by id. Unavailable partitions have null count/amountCents, not a tool failure; available values may be zero.",
			objectSchema({ id: { type: "string" } }), objectSchema({ id: { type: "string" }, status: { enum: ["available", "unavailable"] },
				count: { type: ["integer", "null"] }, amountCents: { type: ["integer", "null"] } }))],
		expected: { knownCount: partitions.reduce((n, row) => n + (row.count ?? 0), 0), knownCents: partitions.reduce((n, row) => n + (row.amountCents ?? 0), 0),
			unavailableIds: partitions.filter((row) => row.status !== "available").map((row) => row.id).sort(), complete: partitions.every((row) => row.status === "available") },
		referenceCode: `const results=await Promise.all(["north","south","west","east","central"].map(id=>tools.mcp.fixture.get_partition({id})));
let knownCount=0,knownCents=0; const unavailableIds=[];
for(const {structured:p} of results){if(p.status==="available"){knownCount+=p.count;knownCents+=p.amountCents;}else unavailableIds.push(p.id);}
return {knownCount,knownCents,unavailableIds:unavailableIds.sort(),complete:unavailableIds.length===0};`,
	}, { get_partition: (args) => lookup(partitions, args) });
}

function snapshotDiff(): BenchmarkFixture {
	const before = [
		{ path: "app.ts", hash: "a1", bytes: 100 }, { path: "config.json", hash: "c1", bytes: 50 },
		{ path: "old.txt", hash: "o1", bytes: 10 }, { path: "readme.md", hash: "r1", bytes: 20 },
		{ path: "notes/a|b.md", hash: "n1", bytes: 15 },
	];
	const after = [
		{ path: "app.ts", hash: "a2", bytes: 100 }, { path: "config.json", hash: "c1", bytes: 50 },
		{ path: "new.txt", hash: "o1", bytes: 10 }, { path: "readme.md", hash: "r1", bytes: 20 },
		{ path: "notes/a|b.md", hash: "n2", bytes: 17 }, { path: "extra.ts", hash: "e1", bytes: 5 },
	];
	return fixture({
		id: "snapshot-diff",
		prompt: "Compare synthetic snapshots before and after by case-sensitive exact path. A changed hash means modified even if byte length is unchanged. " +
			"A rename is removed+added, not unchanged. Return JSON only with exactly added, removed, modified (path arrays sorted ascending), and unchangedCount. " +
			"Read fixture snapshots only; do not access or change real files.",
		tools: [tool("get_snapshot", "Read a complete synthetic file manifest for version before or after. Hashes identify content; bytes alone do not.",
			objectSchema({ version: { enum: ["before", "after"] } }), objectSchema({ files: { type: "array", items: objectSchema({
				path: { type: "string" }, hash: { type: "string" }, bytes: { type: "integer" },
			}) } }))],
		expected: {
			added: after.filter((row) => !before.some((old) => old.path === row.path)).map((row) => row.path).sort(),
			removed: before.filter((row) => !after.some((next) => next.path === row.path)).map((row) => row.path).sort(),
			modified: after.filter((row) => before.some((old) => old.path === row.path && old.hash !== row.hash)).map((row) => row.path).sort(),
			unchangedCount: after.filter((row) => before.some((old) => old.path === row.path && old.hash === row.hash)).length,
		},
		referenceCode: `const [a,b]=await Promise.all([tools.mcp.fixture.get_snapshot({version:"before"}),tools.mcp.fixture.get_snapshot({version:"after"})]);
const before=new Map(a.structured.files.map(f=>[f.path,f.hash])), after=new Map(b.structured.files.map(f=>[f.path,f.hash]));
const added=[],removed=[],modified=[]; let unchangedCount=0;
for(const [path,hash] of after){if(!before.has(path))added.push(path);else if(before.get(path)!==hash)modified.push(path);else unchangedCount++;}
for(const path of before.keys())if(!after.has(path))removed.push(path);
return {added:added.sort(),removed:removed.sort(),modified:modified.sort(),unchangedCount};`,
	}, { get_snapshot(args) {
		validateArguments(args, ["version"]);
		if (args.version !== "before" && args.version !== "after") throw new Error("version must be before or after");
		return { files: args.version === "before" ? before : after };
	} });
}

export function createWorkflowRoutingFixtures(): BenchmarkFixture[] {
	return [nestedProjection(), hierarchyRollup(), intervalOverlap(), textLogExtraction(), policyPrecedence(), boundedSearch(), partitionAvailability(), snapshotDiff()];
}
