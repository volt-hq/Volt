import { type BenchmarkFixture, fixture, objectSchema, tool, validateArguments } from "./code-mode-fixture-utils.ts";

/**
 * Tasks shaped like recorded MCP use rather than small lookups: multi-kilobyte results, chains of dependent reads,
 * and steps that need the listing to be read. All data is generated here; none is copied from a real binary or session.
 */

const FILLER_IMPORTS = ["mem_copy", "queue_push", "heap_alloc", "log_write", "irq_mask", "cache_flush"];

interface Procedure {
	address: string;
	name: string;
	listing: string;
}

type Planted = Record<number, [mnemonic: string, operands?: string]>;

function prng(seed: number): (bound: number) => number {
	let state = seed >>> 0;
	return (bound) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return Math.floor((state / 0x1_0000_0000) * bound);
	};
}

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function line(address: number, mnemonic: string, operands = ""): string {
	return `${hex(address)}  ${mnemonic.padEnd(6)}${operands}`.trimEnd();
}

/**
 * One instruction per line, four bytes apart. Filler never emits `jmp`, `ret`, `lea`, a backward branch, or a symbol
 * outside FILLER_IMPORTS, so every such instruction in a listing was planted. `quiet` is an index range without calls.
 */
function listing(base: number, lines: number, seed: number, planted: Planted = {}, quiet?: [number, number]): string {
	const next = prng(seed);
	const register = () => `r${next(8)}`;
	return Array.from({ length: lines }, (_, index) => {
		const address = base + index * 4;
		const fixed = planted[index];
		if (fixed) return line(address, fixed[0], fixed[1]);
		const kind = next(8);
		if (kind === 0) return line(address, "mov", `${register()}, ${register()}`);
		if (kind === 1) return line(address, "ldr", `${register()}, [${register()}+${hex(next(32) * 4)}]`);
		if (kind === 2) return line(address, "str", `${register()}, [sp+${hex(next(24) * 4)}]`);
		if (kind === 3) return line(address, "add", `${register()}, ${register()}, #${next(96) + 1}`);
		if (kind === 4) return line(address, "xor", `${register()}, ${register()}`);
		if (kind === 5) return line(address, "cmp", `${register()}, #${next(200) + 100}`);
		if (kind === 6 && index + 2 < lines)
			return line(address, "b.ne", `loc_${(base + (index + 1 + next(lines - index - 1)) * 4).toString(16)}`);
		if (kind === 7 && !(quiet && index >= quiet[0] && index <= quiet[1]))
			return line(address, "call", FILLER_IMPORTS[next(FILLER_IMPORTS.length)]);
		return line(address, "nop");
	}).join("\n");
}

function procedure(base: number, lines: number, seed: number, planted: Planted = {}, quiet?: [number, number]): Procedure {
	return { address: hex(base), name: `sub_${base.toString(16)}`, listing: listing(base, lines, seed, planted, quiet) };
}

function readProcedure(procedures: Procedure[], args: Record<string, unknown>): Procedure {
	validateArguments(args, ["address"]);
	const found = procedures.find((entry) => entry.address === args.address);
	if (!found) throw new Error(`Unknown procedure address: ${String(args.address)}`);
	return found;
}

const ADDRESS = { type: "string", pattern: "^0x[0-9a-f]+$" };
const READ_PROCEDURE = tool(
	"read_procedure",
	"Read one procedure's full instruction listing by its start address. Each listing line is '<address>  <mnemonic> <operands>'; " +
		"listings are several kilobytes.",
	objectSchema({ address: ADDRESS }),
	objectSchema({ address: { type: "string" }, name: { type: "string" }, listing: { type: "string" } }),
);

/** Fan-out over large results where only a count survives: twelve listings, four real callers, four near misses. */
function listingScan(): BenchmarkFixture {
	const calls: Record<number, number[]> = { 1: [40], 4: [22, 131], 7: [88], 10: [15, 16, 140] };
	const decoys: Record<number, Planted> = {
		2: { 60: ["call", "crc32_final"] },
		4: { 70: ["call", "crc32_update_table"] },
		5: { 33: ["lea", "r0, [crc32_update]"] },
		8: { 101: ["nop", "; todo: call crc32_update after the refactor"] },
	};
	const procedures = Array.from({ length: 12 }, (_, index) => {
		const planted: Planted = { ...decoys[index] };
		for (const at of calls[index] ?? []) planted[at] = ["call", "crc32_update"];
		return procedure(0x4000 + index * 0x400, 160, 101 + index, planted);
	});
	const callers = Object.keys(calls).map((index) => procedures[Number(index)].address);
	return fixture(
		{
			id: "listing-scan",
			prompt:
				"The fixture MCP server exposes the procedures of a synthetic firmware image. Read every procedure listing. " +
				"Count the instructions whose mnemonic is call and whose operand is exactly crc32_update. Symbols that merely " +
				"start with that name, comments, and address loads do not count. Return JSON only with exactly these fields: " +
				"scannedCount (procedures read), callers (start addresses of procedures containing at least one such call, " +
				"sorted ascending), callCount (total such instructions).",
			tools: [
				tool(
					"list_procedures",
					"List every procedure in the image with its start address, name, and instruction count. No pagination.",
					objectSchema({}),
					objectSchema({
						procedures: {
							type: "array",
							items: objectSchema({
								address: { type: "string" },
								name: { type: "string" },
								instructions: { type: "integer" },
							}),
						},
					}),
				),
				READ_PROCEDURE,
			],
			expected: {
				scannedCount: procedures.length,
				callers,
				callCount: Object.values(calls).reduce((total, lines) => total + lines.length, 0),
			},
			referenceCode: String.raw`const procedures = (await tools.mcp.fixture.list_procedures({})).structured.procedures;
const results = await Promise.all(procedures.map(entry => tools.mcp.fixture.read_procedure({ address: entry.address })));
const callers = [];
let callCount = 0;
for (const result of results) {
  const count = result.structured.listing.split("\n").filter(text => /^\S+\s+call\s+crc32_update$/.test(text)).length;
  if (count > 0) callers.push(result.structured.address);
  callCount += count;
}
return { scannedCount: results.length, callers: callers.sort(), callCount };`,
		},
		{
			list_procedures(args) {
				validateArguments(args, []);
				return {
					procedures: procedures.map(({ address, name, listing: text }) => ({
						address,
						name,
						instructions: text.split("\n").length,
					})),
				};
			},
			read_procedure: (args) => ({ ...readProcedure(procedures, args) }),
		},
	);
}

/** A dependent chain where each next read follows a fixed rule: six tail jumps through multi-kilobyte listings. */
function tailCallChain(): BenchmarkFixture {
	const lines = 140;
	const base = (index: number) => 0x6000 + index * 0x400;
	const chain = [0, 3, 7, 2, 8, 5, 6];
	const procedures = Array.from({ length: 9 }, (_, index) => {
		const position = chain.indexOf(index);
		const planted: Planted = {
			// Calls into other procedures and a guarded mid-listing jump are not tail jumps.
			[20 + index]: ["call", hex(base((index + 4) % 9))],
			[75 + index]: ["jmp", hex(base((index + 1) % 9))],
			[lines - 1]: position >= 0 && position < chain.length - 1 ? ["jmp", hex(base(chain[position + 1]))] : ["ret"],
		};
		return procedure(base(index), lines, 301 + index, planted);
	});
	const path = chain.map((index) => procedures[index].address);
	return fixture(
		{
			id: "tail-call-chain",
			prompt:
				`Start at procedure ${path[0]} on the fixture MCP server. The final instruction of every procedure is either ret ` +
				"or a tail jump (jmp <procedure address>) to another procedure. Follow tail jumps until you reach a procedure " +
				"whose final instruction is ret. Ignore call instructions and any jmp that is not the final instruction. " +
				"Return JSON only with exactly these fields: path (start addresses visited in order, beginning with the start " +
				"procedure and ending with the procedure that returns), hops (the number of tail jumps followed), " +
				"terminal (the last address in path).",
			tools: [READ_PROCEDURE],
			expected: { path, hops: path.length - 1, terminal: path[path.length - 1] },
			referenceCode: String.raw`const path = [];
let address = "${path[0]}";
for (let guard = 0; guard < 20 && address; guard++) {
  path.push(address);
  const text = (await tools.mcp.fixture.read_procedure({ address })).structured.listing;
  const last = text.slice(text.lastIndexOf("\n") + 1);
  const jump = /^\S+\s+jmp\s+(0x[0-9a-f]+)$/.exec(last);
  address = jump ? jump[1] : null;
}
return { path, hops: path.length - 1, terminal: path[path.length - 1] };`,
		},
		{ read_procedure: (args) => ({ ...readProcedure(procedures, args) }) },
	);
}

/** A deterministic sweep followed by reading: four referencing procedures, one of which decides the outcome. */
function xrefTriage(): BenchmarkFixture {
	const text = "license check failed";
	const symbol = "[str_license_check_failed]";
	const base = (index: number) => 0x8000 + index * 0x400;
	const branchIndex = 61;
	const failureIndex = 120;
	const plans: Planted[] = [
		{ 30: ["lea", `r0, ${symbol}`], 31: ["call", "log_write"] },
		{},
		// The deciding routine: finish the checksum, compare it with the stored one, branch to the failure path.
		{
			58: ["call", "crc32_final"],
			59: ["ldr", "r1, [stored_checksum]"],
			60: ["cmp", "r0, r1"],
			[branchIndex]: ["b.ne", `loc_${(base(2) + failureIndex * 4).toString(16)}`],
			[failureIndex]: ["lea", `r0, ${symbol}`],
			[failureIndex + 1]: ["call", "fault_raise"],
		},
		// Updates the stored checksum and never references the message.
		{ 44: ["call", "crc32_final"], 45: ["str", "r0, [stored_checksum]"] },
		{ 90: ["lea", `r1, ${symbol}`], 91: ["call", "format_message"], 130: ["lea", `r1, ${symbol}`], 131: ["call", "format_message"] },
		{},
		// Compares a retry counter, then only logs: a compare-and-branch next to the string is not the checksum decision.
		{
			70: ["ldr", "r1, [retry_limit]"],
			71: ["cmp", "r2, r1"],
			72: ["b.ne", `loc_${(base(6) + 110 * 4).toString(16)}`],
			73: ["lea", `r0, ${symbol}`],
			74: ["call", "log_write"],
		},
		{},
	];
	const procedures = plans.map((planted, index) => procedure(base(index), 150, 501 + index, planted));
	const refs = plans.flatMap((planted, index) =>
		Object.entries(planted)
			.filter(([, instruction]) => instruction[1]?.includes(symbol))
			.map(([at]) => ({ procedure: procedures[index].address, line: hex(base(index) + Number(at) * 4) })),
	);
	return fixture(
		{
			id: "xref-triage",
			prompt:
				`On the fixture MCP server, find the procedures that reference the string "${text}". Exactly one of them ` +
				"decides the outcome: it compares a freshly computed checksum with the stored checksum and conditionally " +
				"branches to the failure path when they differ. The others only log or format the message. Read the " +
				"referencing procedures and identify the deciding one. Return JSON only with exactly these fields: " +
				"referencingCount (distinct procedures that reference the string), validator (start address of the deciding " +
				"procedure), failureBranchLine (the listing address of its conditional branch to the failure path).",
			tools: [
				tool(
					"find_string_refs",
					"Find instructions that reference a string, by the string's exact text. A procedure can appear more than once.",
					objectSchema({ text: { type: "string", minLength: 1 } }),
					objectSchema({
						refs: {
							type: "array",
							items: objectSchema({ procedure: { type: "string" }, line: { type: "string" } }),
						},
					}),
				),
				READ_PROCEDURE,
			],
			expected: {
				referencingCount: new Set(refs.map((ref) => ref.procedure)).size,
				validator: procedures[2].address,
				failureBranchLine: hex(base(2) + branchIndex * 4),
			},
			referenceCode: String.raw`const refs = (await tools.mcp.fixture.find_string_refs({ text: "${text}" })).structured.refs;
const addresses = [...new Set(refs.map(ref => ref.procedure))].sort();
const results = await Promise.all(addresses.map(address => tools.mcp.fixture.read_procedure({ address })));
let validator = null;
let failureBranchLine = null;
for (const result of results) {
  const lines = result.structured.listing.split("\n");
  for (let index = 2; index < lines.length; index++) {
    if (!/^\S+\s+b\.ne\s/.test(lines[index]) || !/^\S+\s+cmp\s/.test(lines[index - 1])) continue;
    if (!/^\S+\s+ldr\s.*\[stored_checksum\]$/.test(lines[index - 2])) continue;
    validator = result.structured.address;
    failureBranchLine = lines[index].split(/\s+/)[0];
  }
}
return { referencingCount: addresses.length, validator, failureBranchLine };`,
		},
		{
			find_string_refs(args) {
				validateArguments(args, ["text"]);
				return { refs: args.text === text ? refs : [] };
			},
			read_procedure: (args) => ({ ...readProcedure(procedures, args) }),
		},
	);
}

/** Paged raw reads: a signature scan with a match across a page boundary and matches that are not byte-aligned. */
function byteSignatureScan(): BenchmarkFixture {
	const size = 4096;
	const pageBytes = 512;
	const signature = [0xc0, 0xde, 0x7a, 0x11];
	const offsets = [261, 510, 2048, 3650];
	const next = prng(907);
	// Filler avoids the signature's first byte, so only planted bytes can begin a match.
	const bytes = Array.from({ length: size }, () => {
		const value = next(256);
		return value === signature[0] ? 0x3c : value;
	});
	for (const offset of offsets) bytes.splice(offset, signature.length, ...signature);
	bytes.splice(1500, 4, 0xc0, 0xde, 0x7a, 0x10);
	bytes.splice(2500, 4, 0xc0, 0xde, 0x7b, 0x11);
	// "4c0de7a113" contains the signature's hex digits one nibble off a byte boundary.
	bytes.splice(3000, 5, 0x4c, 0x0d, 0xe7, 0xa1, 0x13);
	const image = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
	return fixture(
		{
			id: "byte-signature-scan",
			prompt:
				`The fixture MCP server exposes a ${size}-byte synthetic image through read_bytes, at most ${pageBytes} bytes per call. ` +
				"Read the whole image, following nextOffset until null. Find every byte offset at which the four-byte sequence " +
				"c0 de 7a 11 begins. A match can span two reads. Hex output has two lowercase characters per byte and no " +
				"separators, so a match must start on a byte boundary. Return JSON only with exactly these fields: " +
				"imageBytes (total bytes read), offsets (matching byte offsets, ascending), count (number of matches).",
			tools: [
				tool(
					"read_bytes",
					`Read raw image bytes as contiguous lowercase hex. Defaults: offset 0, length ${pageBytes}; length cannot exceed ${pageBytes}. ` +
						"Pass nextOffset as offset for the next read; null ends the image.",
					objectSchema(
						{
							offset: { type: "integer", minimum: 0, maximum: size, default: 0 },
							length: { type: "integer", minimum: 1, maximum: pageBytes, default: pageBytes },
						},
						[],
					),
					objectSchema({
						offset: { type: "integer" },
						length: { type: "integer" },
						hex: { type: "string" },
						nextOffset: { type: ["integer", "null"] },
					}),
				),
			],
			expected: { imageBytes: size, offsets, count: offsets.length },
			referenceCode: String.raw`let hex = "";
let offset = 0;
do {
  const chunk = (await tools.mcp.fixture.read_bytes({ offset, length: ${pageBytes} })).structured;
  hex += chunk.hex;
  offset = chunk.nextOffset;
} while (offset !== null);
const offsets = [];
for (let at = hex.indexOf("c0de7a11"); at !== -1; at = hex.indexOf("c0de7a11", at + 1)) {
  if (at % 2 === 0) offsets.push(at / 2);
}
return { imageBytes: hex.length / 2, offsets, count: offsets.length };`,
		},
		{
			read_bytes(args) {
				validateArguments(args, ["offset", "length"]);
				const offset = Object.hasOwn(args, "offset") ? args.offset : 0;
				const length = Object.hasOwn(args, "length") ? args.length : pageBytes;
				if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > size)
					throw new Error(`offset must be an integer from 0 through ${size}`);
				if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > pageBytes)
					throw new Error(`length must be an integer from 1 through ${pageBytes}`);
				const end = Math.min(offset + length, size);
				return { offset, length: end - offset, hex: image.slice(offset * 2, end * 2), nextOffset: end < size ? end : null };
			},
		},
	);
}

/** One large result that has to be read: a control where a script cannot save a round trip. */
function loopInterpretation(): BenchmarkFixture {
	const base = 0xa000;
	const start = 50;
	const branch = 96;
	const bound = 37;
	const planted: Planted = {
		[start + 9]: ["call", "uart_write"],
		[start + 30]: ["call", "timer_arm"],
		[branch - 1]: ["cmp", `r4, #${bound}`],
		[branch]: ["b.lt", `loc_${(base + start * 4).toString(16)}`],
		[219]: ["ret"],
	};
	const procedures = [procedure(base, 220, 701, planted, [start, branch])];
	return fixture(
		{
			id: "loop-interpretation",
			prompt:
				`Read procedure ${hex(base)} on the fixture MCP server. It contains exactly one loop, closed by a conditional ` +
				"branch back to an earlier address; every other branch goes forward. Return JSON only with exactly these fields: " +
				"loopStart (the address the backward branch targets, written like 0xa000), loopBound (the integer immediate " +
				"compared immediately before the backward branch), callsInLoop (symbols called from loopStart up to the " +
				"backward branch, in listing order).",
			tools: [READ_PROCEDURE],
			expected: { loopStart: hex(base + start * 4), loopBound: bound, callsInLoop: ["uart_write", "timer_arm"] },
			referenceCode: String.raw`const lines = (await tools.mcp.fixture.read_procedure({ address: "${hex(base)}" })).structured.listing.split("\n");
const parsed = lines.map(text => text.split(/\s+/));
const branchIndex = parsed.findIndex(([address, mnemonic, operand]) =>
  mnemonic.startsWith("b.") && Number.parseInt(operand.slice(4), 16) < Number.parseInt(address, 16));
const loopStart = "0x" + parsed[branchIndex][2].slice(4);
const startIndex = parsed.findIndex(([address]) => address === loopStart);
return {
  loopStart,
  loopBound: Number(lines[branchIndex - 1].slice(lines[branchIndex - 1].indexOf("#") + 1)),
  callsInLoop: parsed.slice(startIndex, branchIndex).filter(([, mnemonic]) => mnemonic === "call").map(([, , symbol]) => symbol),
};`,
		},
		{ read_procedure: (args) => ({ ...readProcedure(procedures, args) }) },
	);
}

/** Every run owns its data and grading state, as in the core suite. */
export function createRealisticRoutingFixtures(): BenchmarkFixture[] {
	return [listingScan(), tailCallChain(), xrefTriage(), byteSignatureScan(), loopInterpretation()];
}
