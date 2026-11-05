import { createLosslessCodec } from "./codec.ts";

/** File name of the script in stack traces. */
export const SCRIPT_FILENAME = "script.js";
/** File name of the prelude; its frames are removed from stack traces. */
export const PRELUDE_FILENAME = "prelude.js";
/** The script becomes the body of an async function. The prefix shares the script's first line. */
export const SCRIPT_PREFIX = "(async function () {";
export const SCRIPT_SUFFIX = "\n})";

/** Configuration the worker passes to the prelude when a VM boots. */
export interface PreludeConfig {
	maxJsonDepth: number;
	maxErrorChars: number;
	maxErrorNameChars: number;
	maxErrorSummaryChars: number;
	scriptFilename: string;
	scriptPrefixLength: number;
	preludeFilename: string;
}

/** A binding the host exposes to a script, installed at `tools.<path>`. */
export interface CodeModeBinding {
	/** Identifies the binding in call messages. */
	name: string;
	/** Property path under `tools`, for example `["mcp", "github", "create_issue"]`. */
	path: string[];
}

/** A thrown value as the prelude describes it before it leaves the VM. */
export interface CodeModeErrorDescription {
	/** The error's name, or `thrown <type>` for a thrown value that is not an Error. */
	name: string;
	/** One line: `Name: message`, or `Thrown string: ...`. */
	summary: string;
	/** The error block: the summary, the stack, inner errors, and causes, bounded in length. */
	text: string;
	outOfMemory: boolean;
}

/**
 * Functions the prelude returns to the worker. The worker holds them from boot, before any script runs,
 * and calls them only while the VM is idle.
 */
export interface PreludeApi {
	/** Installs `tools` from JSON text of a `PreludeInstall`. */
	install(installText: string): void;
	/** Runs the script function and reports its completion through the bridge. */
	run(script: () => unknown): void;
	/** Settles nested call `seq`. Returns `ok`, `unknown` for an unexpected seq, or `invalid`. */
	settle(seq: string, status: string, payload: string): string;
	/** Describes a thrown value as JSON text of a `CodeModeErrorDescription`. */
	describe(value: unknown): string;
}

/** What the worker installs for one script, after boot and before the script runs. */
export interface PreludeInstall {
	bindings: CodeModeBinding[];
	maxArgumentBytes: number;
}

type Bridge = (kind: string, payload: string) => void;

/**
 * The prelude evaluated in every VM before the script (section 5.4 of docs/code-mode-design.md).
 *
 * The VM receives this function's source, so like the codec it must stay self-contained. It captures the
 * built-ins it depends on when it runs, before the script, and uses only those afterwards, so a script
 * that patches globals or prototypes cannot change how the bridge behaves. The bridge function stays in
 * this closure; the script cannot reach it.
 */
function codeModePrelude(createCodec: typeof createLosslessCodec) {
	const call = Function.prototype.call;
	const uncurry = <F extends (this: never, ...args: never[]) => unknown>(fn: F) =>
		call.bind(fn) as unknown as (self: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F>;
	const getter = (proto: object, key: string) => {
		const get = Object.getOwnPropertyDescriptor(proto, key)?.get;
		if (get === undefined) throw new TypeError(`missing getter ${key}`);
		return call.bind(get) as unknown as (self: unknown) => unknown;
	};

	const globalObject = globalThis;
	const JSONParse = JSON.parse;
	const JSONStringify = JSON.stringify;
	const ObjectCreate = Object.create;
	const ObjectDefineProperty = Object.defineProperty;
	const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const ObjectGetPrototypeOf = Object.getPrototypeOf;
	const ObjectKeys = Object.keys;
	const ObjectIs = Object.is;
	const ObjectSetPrototypeOf = Object.setPrototypeOf;
	const ObjectPrototype = Object.prototype;
	const ObjectPrototypeToString = uncurry(Object.prototype.toString);
	const ObjectPrototypeIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
	const ArrayIsArray = Array.isArray;
	const ArrayPrototypePush = uncurry(Array.prototype.push);
	const ArrayPrototypePop = uncurry(Array.prototype.pop);
	const ArrayPrototypeJoin = uncurry(Array.prototype.join);
	const ArrayPrototypeIncludes = uncurry(Array.prototype.includes);
	const ArrayBufferIsView = ArrayBuffer.isView;
	const ArrayBufferByteLength = getter(ArrayBuffer.prototype, "byteLength");
	const TypedArrayLength = getter(Object.getPrototypeOf(Uint8Array.prototype), "length");
	const StringPrototypeSlice = uncurry(String.prototype.slice);
	const StringPrototypeSplit = call.bind(String.prototype.split) as unknown as (
		self: string,
		separator: string,
	) => string[];
	const StringPrototypeIndexOf = uncurry(String.prototype.indexOf);
	const StringPrototypeCharCodeAt = uncurry(String.prototype.charCodeAt);
	const NumberCtor = Number;
	const NumberIsNaN = Number.isNaN;
	const SymbolPrototypeToString = uncurry(Symbol.prototype.toString);
	const DatePrototypeGetTime = uncurry(Date.prototype.getTime);
	const DatePrototypeToISOString = uncurry(Date.prototype.toISOString);
	const RegExpPrototypeToString = uncurry(RegExp.prototype.toString);
	const MapCtor = Map;
	const MapPrototypeGet = uncurry(Map.prototype.get);
	const MapPrototypeSet = uncurry(Map.prototype.set);
	const MapPrototypeDelete = uncurry(Map.prototype.delete);
	const MapPrototypeForEach = uncurry(Map.prototype.forEach);
	const MapSize = getter(Map.prototype, "size");
	const SetPrototypeForEach = uncurry(Set.prototype.forEach);
	const SetSize = getter(Set.prototype, "size");
	const PromiseCtor = Promise;
	const PromisePrototypeThen = uncurry(Promise.prototype.then);
	const ErrorCtor = Error;
	const ErrorPrototype = Error.prototype;
	const TypeErrorCtor = TypeError;
	const RangeErrorCtor = RangeError;

	const MAX_FORMAT_DEPTH = 16;
	const MAX_INNER_ERRORS = 5;
	const MAX_CAUSES = 3;

	/**
	 * An array without a prototype. Pushing onto an ordinary array performs [[Set]], which runs setters a
	 * script may define on `Array.prototype` or `Object.prototype` indices; these lists have no prototype.
	 */
	function newList<T>(): T[] {
		return ObjectSetPrototypeOf([], null) as T[];
	}

	return function bootPrelude(bridge: Bridge, configText: string): PreludeApi {
		const config = JSONParse(configText) as PreludeConfig;
		const codec = createCodec(config.maxJsonDepth);
		const pending = new MapCtor<
			number,
			{ name: string; resolve(value: unknown): void; reject(error: unknown): void }
		>();
		let lastSeq = 0;
		let maxArgumentBytes = 0;

		/**
		 * A data property descriptor without a prototype. defineProperty reads descriptor fields with [[Get]], so
		 * a field a script defines on Object.prototype (such as `get`) would otherwise change the descriptor.
		 */
		function dataDescriptor(value: unknown, writable: boolean, enumerable: boolean): PropertyDescriptor {
			const descriptor = ObjectCreate(null) as PropertyDescriptor;
			descriptor.value = value;
			descriptor.writable = writable;
			descriptor.enumerable = enumerable;
			descriptor.configurable = true;
			return descriptor;
		}

		function defineHidden(target: object, key: string, value: unknown): void {
			ObjectDefineProperty(target, key, dataDescriptor(value, true, false));
		}

		function defineVisible(target: object, key: string, value: unknown): void {
			ObjectDefineProperty(target, key, dataDescriptor(value, true, true));
		}

		function read(target: object, key: string): unknown {
			try {
				return (target as Record<string, unknown>)[key];
			} catch {
				return undefined;
			}
		}

		function join(parts: string[], separator: string): string {
			return ArrayPrototypeJoin(parts, separator);
		}

		// Output formatting is lenient and never throws, unlike the codec (section 5.10).

		function constructorName(proto: object): string | undefined {
			const ctor = ObjectGetOwnPropertyDescriptor(proto, "constructor")?.value;
			if (typeof ctor !== "function") return undefined;
			const name = ObjectGetOwnPropertyDescriptor(ctor, "name")?.value;
			return typeof name === "string" && name !== "" ? name : undefined;
		}

		function formatFunction(value: unknown): string {
			const name = ObjectGetOwnPropertyDescriptor(value as object, "name")?.value;
			return typeof name === "string" && name !== "" ? `[Function ${name}]` : "[Function (anonymous)]";
		}

		function isError(value: unknown): value is object {
			return value !== null && typeof value === "object" && ObjectPrototypeIsPrototypeOf(ErrorPrototype, value);
		}

		function errorLine(error: object): string {
			const name = read(error, "name");
			const message = read(error, "message");
			const nameText = typeof name === "string" ? name : "Error";
			return typeof message === "string" && message !== "" ? `${nameText}: ${message}` : nameText;
		}

		function formatList(list: ArrayLike<unknown>, length: number, depth: number, seen: object[]): string {
			const parts = newList<string>();
			for (let i = 0; i < length; i++) {
				ArrayPrototypePush(parts, i in list ? formatNested(list[i], depth + 1, seen) : "<empty>");
			}
			return join(parts, ",");
		}

		function formatObject(object: object, depth: number, seen: object[]): string {
			if (ArrayIsArray(object)) return `[${formatList(object, object.length, depth, seen)}]`;
			if (isError(object)) return errorLine(object);
			const tag = StringPrototypeSlice(ObjectPrototypeToString(object), 8, -1);
			switch (tag) {
				case "Date": {
					return NumberIsNaN(DatePrototypeGetTime(object as Date))
						? "Invalid Date"
						: DatePrototypeToISOString(object as Date);
				}
				case "Map": {
					const parts = newList<string>();
					MapPrototypeForEach(object as Map<unknown, unknown>, (value: unknown, key: unknown) => {
						ArrayPrototypePush(
							parts,
							`${formatNested(key, depth + 1, seen)} => ${formatNested(value, depth + 1, seen)}`,
						);
					});
					return `Map(${MapSize(object)}) {${join(parts, ", ")}}`;
				}
				case "Set": {
					const parts = newList<string>();
					SetPrototypeForEach(object as Set<unknown>, (value: unknown) => {
						ArrayPrototypePush(parts, formatNested(value, depth + 1, seen));
					});
					return `Set(${SetSize(object)}) {${join(parts, ", ")}}`;
				}
				case "RegExp":
					return RegExpPrototypeToString(object as RegExp);
				case "Promise":
					return "Promise {}";
				case "ArrayBuffer":
					return `ArrayBuffer(${ArrayBufferByteLength(object)})`;
				case "Number":
				case "String":
				case "Boolean":
				case "BigInt":
				case "Symbol":
					return `[${tag}]`;
			}
			if (ArrayBufferIsView(object) && tag !== "DataView") {
				const length = TypedArrayLength(object) as number;
				return `${tag}(${length}) [${formatList(object as unknown as ArrayLike<unknown>, length, depth, seen)}]`;
			}
			const keys = ObjectKeys(object);
			const parts = newList<string>();
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				ArrayPrototypePush(parts, `${JSONStringify(key)}:${formatNested(read(object, key), depth + 1, seen)}`);
			}
			const body = `{${join(parts, ",")}}`;
			const proto = ObjectGetPrototypeOf(object);
			if (proto === ObjectPrototype || proto === null) return body;
			const name = constructorName(proto);
			return name === undefined ? body : `${name} ${body}`;
		}

		function formatNested(value: unknown, depth: number, seen: object[]): string {
			switch (typeof value) {
				case "string":
					return JSONStringify(value);
				case "number":
					return ObjectIs(value, -0) ? "-0" : `${value}`;
				case "bigint":
					return `${value}n`;
				case "boolean":
					return value ? "true" : "false";
				case "undefined":
					return "undefined";
				case "symbol":
					return SymbolPrototypeToString(value);
				case "function":
					return formatFunction(value);
			}
			if (value === null) return "null";
			const object = value as object;
			if (ArrayPrototypeIncludes(seen, object)) return "[Circular]";
			if (depth >= MAX_FORMAT_DEPTH) return ArrayIsArray(object) ? "[Array]" : "[Object]";
			ArrayPrototypePush(seen, object);
			try {
				return formatObject(object, depth, seen);
			} finally {
				ArrayPrototypePop(seen);
			}
		}

		function formatValue(value: unknown): string {
			if (typeof value === "string") return value;
			try {
				return formatNested(value, 0, newList<object>());
			} catch {
				return "[unprintable value]";
			}
		}

		function emit(payload: string): void {
			bridge("output", payload);
		}

		function consoleMethod(level: string) {
			return (...values: unknown[]): void => {
				const parts = newList<string>();
				for (let i = 0; i < values.length; i++) ArrayPrototypePush(parts, formatValue(values[i]));
				emit(`{"type":"console","level":"${level}","text":${JSONStringify(join(parts, " "))}}`);
			};
		}

		const consoleObject = ObjectCreate(ObjectPrototype) as object;
		const levels = ["log", "info", "debug", "warn", "error"];
		for (let i = 0; i < levels.length; i++) defineHidden(consoleObject, levels[i], consoleMethod(levels[i]));

		function text(value: unknown): void {
			emit(`{"type":"text","text":${JSONStringify(formatValue(value))}}`);
		}

		function image(reference: unknown): void {
			const ref =
				reference !== null && typeof reference === "object" && read(reference, "type") === "image"
					? read(reference, "ref")
					: undefined;
			if (typeof ref !== "string") throw new TypeErrorCtor("image() takes an image reference returned by a tool");
			emit(`{"type":"image","ref":${JSONStringify(ref)}}`);
		}

		class ToolCallError extends ErrorCtor {
			constructor(message: string, tool: string, kind: string, reason: unknown) {
				super(message);
				defineVisible(this, "tool", tool);
				defineVisible(this, "kind", kind);
				if (typeof reason === "string") defineVisible(this, "reason", reason);
			}
		}
		defineHidden(ToolCallError.prototype, "name", "ToolCallError");

		/**
		 * UTF-8 length of codec output. A surrogate pair is 4 bytes, 2 per code unit; codec output holds no
		 * lone surrogates, because JSON.stringify escapes them to ASCII.
		 */
		function utf8Length(value: string): number {
			let bytes = value.length;
			for (let i = 0; i < value.length; i++) {
				const code = StringPrototypeCharCodeAt(value, i);
				if (code >= 0xd800 && code <= 0xdfff) bytes += 1;
				else if (code >= 0x800) bytes += 2;
				else if (code >= 0x80) bytes += 1;
			}
			return bytes;
		}

		function callTool(name: string, args: unknown): Promise<unknown> {
			return new PromiseCtor((resolve, reject) => {
				const input = args === undefined ? {} : args;
				let encoded: string;
				try {
					if (input === null || typeof input !== "object")
						throw new TypeErrorCtor("args: tool arguments must be an object");
					if (ArrayIsArray(input)) throw new TypeErrorCtor("args: tool arguments must be an object, not an array");
					encoded = codec.encode(input, "args");
				} catch (error) {
					reject(error);
					return;
				}
				// A UTF-16 code unit is at most 3 bytes of UTF-8, so shorter text needs no exact count.
				if (encoded.length * 3 > maxArgumentBytes) {
					const bytes = utf8Length(encoded);
					if (bytes > maxArgumentBytes) {
						reject(new RangeErrorCtor(`args: ${bytes} bytes encoded exceeds the limit of ${maxArgumentBytes}`));
						return;
					}
				}
				// The seq is taken after encoding, so a getter that calls a binding during encoding posts its call
				// first. It is committed only once the call is posted: an allocation failing before then (a
				// catchable out-of-memory error) must not leave a gap the host would treat as a protocol violation.
				const seq = lastSeq + 1;
				const payload = `{"seq":${seq},"binding":${JSONStringify(name)},"args":${encoded}}`;
				MapPrototypeSet(pending, seq, { name, resolve, reject });
				bridge("call", payload);
				lastSeq = seq;
			});
		}

		function makeBinding(name: string, displayName: string) {
			const binding = (args?: unknown): Promise<unknown> => callTool(name, args);
			ObjectDefineProperty(binding, "name", dataDescriptor(displayName, false, false));
			return binding;
		}

		function install(installText: string): void {
			const request = JSONParse(installText) as PreludeInstall;
			maxArgumentBytes = request.maxArgumentBytes;
			const bindings = request.bindings;
			const root = ObjectCreate(null) as object;
			for (let i = 0; i < bindings.length; i++) {
				const path = bindings[i].path;
				let target = root;
				for (let j = 0; j < path.length - 1; j++) {
					let next = ObjectGetOwnPropertyDescriptor(target, path[j])?.value as object | undefined;
					if (next === undefined) {
						next = ObjectCreate(null) as object;
						defineVisible(target, path[j], next);
					}
					target = next;
				}
				const leaf = path[path.length - 1];
				defineVisible(target, leaf, makeBinding(bindings[i].name, leaf));
			}
			defineHidden(globalObject, "tools", root);
		}

		/**
		 * Keeps `value` within `maxChars`, including the marker that counts what was left out. The marker is
		 * sized with the full length as its count, an upper bound on the count it shows.
		 */
		function truncateWith(value: string, maxChars: number, separator: string): string {
			if (value.length <= maxChars) return value;
			const kept = maxChars - `${separator}... [${value.length} more chars]`.length;
			return `${StringPrototypeSlice(value, 0, kept)}${separator}... [${value.length - kept} more chars]`;
		}

		function truncate(value: string, maxChars: number): string {
			return truncateWith(value, maxChars, "\n");
		}

		function truncateLine(value: string, maxChars: number): string {
			return truncateWith(value, maxChars, "");
		}

		/** Writes line breaks as `\n`, so text from a message cannot start lines of its own in a result. */
		function oneLine(value: string): string {
			let result = "";
			let start = 0;
			for (let i = 0; i < value.length; i++) {
				const code = StringPrototypeCharCodeAt(value, i);
				if (code !== 0x0a && code !== 0x0d && code !== 0x2028 && code !== 0x2029) continue;
				result += `${StringPrototypeSlice(value, start, i)}\\n`;
				if (code === 0x0d && StringPrototypeCharCodeAt(value, i + 1) === 0x0a) i++;
				start = i + 1;
			}
			return start === 0 ? value : result + StringPrototypeSlice(value, start);
		}

		/** Removes prelude frames and maps columns on the script's first line back to the script. */
		function cleanStack(stack: string): string {
			const lines = StringPrototypeSplit(stack, "\n");
			const kept = newList<string>();
			const marker = `${config.scriptFilename}:1:`;
			for (let i = 0; i < lines.length; i++) {
				let line = lines[i];
				if (StringPrototypeIndexOf(line, config.preludeFilename) !== -1) continue;
				if (line === "") continue;
				const at = StringPrototypeIndexOf(line, marker);
				if (at !== -1) {
					const start = at + marker.length;
					let end = start;
					while (end < line.length) {
						const code = StringPrototypeCharCodeAt(line, end);
						if (code < 0x30 || code > 0x39) break;
						end++;
					}
					const column = NumberCtor(StringPrototypeSlice(line, start, end)) - config.scriptPrefixLength;
					line = `${StringPrototypeSlice(line, 0, start)}${column < 1 ? 1 : column}${StringPrototypeSlice(line, end)}`;
				}
				ArrayPrototypePush(kept, line);
			}
			return join(kept, "\n");
		}

		/** One bounded line describing a thrown value. */
		function summarize(value: unknown): string {
			if (isError(value)) return truncateLine(oneLine(errorLine(value)), config.maxErrorSummaryChars);
			if (value === null) return "Thrown null";
			if (value === undefined) return "Thrown undefined";
			return truncateLine(oneLine(`Thrown ${typeof value}: ${formatValue(value)}`), config.maxErrorSummaryChars);
		}

		function describeValue(value: unknown): CodeModeErrorDescription {
			if (!isError(value)) {
				const type = value === null ? "null" : typeof value;
				const summary = summarize(value);
				return {
					name: `thrown ${type}`,
					summary,
					text: truncate(summary, config.maxErrorChars),
					outOfMemory: false,
				};
			}
			const name = read(value, "name");
			const message = read(value, "message");
			const summary = summarize(value);
			let block = summary;
			const stack = read(value, "stack");
			if (typeof stack === "string") {
				const frames = cleanStack(stack);
				if (frames !== "") block += `\n${frames}`;
			}
			const errors = read(value, "errors");
			if (ArrayIsArray(errors)) {
				const shown = errors.length < MAX_INNER_ERRORS ? errors.length : MAX_INNER_ERRORS;
				for (let i = 0; i < shown; i++) block += `\n  [${i + 1}] ${summarize(errors[i])}`;
				if (errors.length > shown) block += `\n  (${errors.length - shown} more)`;
			}
			let cause = read(value, "cause");
			for (let level = 0; level < MAX_CAUSES && cause !== undefined; level++) {
				block += `\nCaused by: ${summarize(cause)}`;
				cause = isError(cause) ? read(cause, "cause") : undefined;
			}
			return {
				name:
					typeof name === "string" && name !== ""
						? truncateLine(oneLine(name), config.maxErrorNameChars)
						: "Error",
				summary,
				text: truncate(block, config.maxErrorChars),
				outOfMemory: name === "InternalError" && message === "out of memory",
			};
		}

		// Serialized by hand: QuickJS's JSON.stringify of an object keeps its own stack in an ordinary array,
		// so a setter a script defines on an Array.prototype index would run inside it.
		function serializeDescription(description: CodeModeErrorDescription): string {
			return `{"name":${JSONStringify(description.name)},"summary":${JSONStringify(description.summary)},"text":${JSONStringify(description.text)},"outOfMemory":${description.outOfMemory ? "true" : "false"}}`;
		}

		function describe(value: unknown): string {
			try {
				return serializeDescription(describeValue(value));
			} catch {
				return '{"name":"Error","summary":"Error: the thrown value could not be described","text":"Error: the thrown value could not be described","outOfMemory":false}';
			}
		}

		function finishValue(value: unknown): void {
			if (value === undefined) {
				bridge("done", '{"ok":true}');
				return;
			}
			let encoded: string;
			try {
				encoded = codec.encode(value, "return value");
			} catch (error) {
				finishError(error);
				return;
			}
			bridge("done", `{"ok":true,"value":${encoded}}`);
		}

		function finishError(error: unknown): void {
			bridge("done", `{"ok":false,"phase":"run","error":${describe(error)}}`);
		}

		function run(script: () => unknown): void {
			let completion: unknown;
			try {
				completion = script();
			} catch (error) {
				finishError(error);
				return;
			}
			try {
				// `then` looks up a species constructor through `constructor`, which a script can patch on
				// Promise.prototype. An own undefined `constructor` makes it use the intrinsic Promise.
				ObjectDefineProperty(completion as object, "constructor", dataDescriptor(undefined, false, false));
				PromisePrototypeThen(completion as Promise<unknown>, finishValue, finishError);
			} catch (error) {
				finishError(error);
			}
		}

		function settle(seqText: string, status: string, payload: string): string {
			const seq = NumberCtor(seqText);
			const entry = MapPrototypeGet(pending, seq);
			if (entry === undefined) return "unknown";
			MapPrototypeDelete(pending, seq);
			if (status === "ok") {
				let value: unknown;
				try {
					value = codec.decode(payload);
				} catch {
					return "invalid";
				}
				entry.resolve(value);
				return "ok";
			}
			let failure: { kind?: unknown; reason?: unknown; message?: unknown };
			try {
				failure = JSONParse(payload);
			} catch {
				return "invalid";
			}
			if (typeof failure.kind !== "string" || typeof failure.message !== "string") return "invalid";
			entry.reject(new ToolCallError(failure.message, entry.name, failure.kind, failure.reason));
			return "ok";
		}

		defineHidden(globalObject, "console", consoleObject);
		defineHidden(globalObject, "text", text);
		defineHidden(globalObject, "image", image);
		defineHidden(globalObject, "ToolCallError", ToolCallError);

		const api = ObjectCreate(null) as PreludeApi;
		api.install = install;
		api.run = run;
		api.settle = settle;
		api.describe = describe;
		return api;
	};
}

/** Source of the prelude. Evaluating it yields `bootPrelude(bridge, configText)`. */
export const CODE_MODE_PRELUDE_SOURCE = `(${codeModePrelude.toString()})(${createLosslessCodec.toString()})`;
