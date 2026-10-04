/**
 * The query registry: admission (profile, then parameters) and the run, for
 * every wire that reads a catalog — protocol query frames and the legacy RPC
 * and Iroh read commands.
 */

import { QUERY_SCHEMAS, type QueryName, type QueryParams, type QueryResult } from "@hansjm10/volt-protocol";
import type { TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { type IntentContext, missingCapability } from "../intents/types.ts";
import { formatSchemaError } from "../schema-errors.ts";
import type { BUILTIN_QUERIES } from "./definitions.ts";
import { type QueryDefinition, QueryRejectedError, type RegisteredQueryName } from "./types.ts";

export type BuiltinQueryDefinitions = typeof BUILTIN_QUERIES;

export class QueryRegistry {
	private readonly load: () => BuiltinQueryDefinitions;
	private loaded: BuiltinQueryDefinitions | undefined;
	private readonly validators = new Map<RegisteredQueryName, Validator>();

	/** `load` returns the definitions; the registry reads them on first use. */
	constructor(load: () => BuiltinQueryDefinitions) {
		this.load = load;
	}

	private get definitions(): BuiltinQueryDefinitions {
		if (this.loaded) return this.loaded;
		const definitions = this.load();
		for (const name of Object.keys(definitions) as RegisteredQueryName[]) {
			const definition: QueryDefinition<RegisteredQueryName> = definitions[name];
			if (definition.name !== name) throw new Error(`Query ${name} is defined as ${definition.name}`);
		}
		this.loaded = definitions;
		return definitions;
	}

	names(): RegisteredQueryName[] {
		return Object.keys(this.definitions) as RegisteredQueryName[];
	}

	get<N extends RegisteredQueryName>(name: N): BuiltinQueryDefinitions[N] {
		return this.definitions[name];
	}

	has(name: string): name is RegisteredQueryName {
		return Object.hasOwn(this.definitions, name);
	}

	/** Admit and run a query with typed parameters. */
	run<N extends RegisteredQueryName>(ctx: IntentContext, name: N, params: QueryParams<N>): Promise<QueryResult<N>> {
		return this.runUnchecked(ctx, name, params) as Promise<QueryResult<N>>;
	}

	/** Admit and run any query by name with unchecked parameters (a wire frame). */
	runFrame(ctx: IntentContext, name: string, params: unknown): Promise<unknown> {
		if (!this.has(name)) {
			return Promise.reject(new QueryRejectedError("unknown_query", `Unknown query: ${name}`));
		}
		return this.runUnchecked(ctx, name, params);
	}

	private async runUnchecked(ctx: IntentContext, name: RegisteredQueryName, params: unknown): Promise<unknown> {
		const definition: QueryDefinition<RegisteredQueryName> = this.definitions[name];
		if (ctx.profile.name === "remote") {
			if (definition.remote !== "safe") {
				throw new QueryRejectedError("not_allowed", `Query not available over remote host: ${name}`);
			}
			const missing = missingCapability(ctx.profile.grant, definition.requires);
			if (missing !== undefined) {
				throw new QueryRejectedError("not_allowed", `Remote capability required: ${missing}`, {
					requiredCapability: missing,
				});
			}
		}
		const admitted = params ?? {};
		const validator = this.validator(name);
		if (!validator.Check(admitted)) {
			throw new QueryRejectedError(
				"invalid_input",
				`Invalid ${name} parameters: ${formatSchemaError(QUERY_SCHEMAS[name].params as TObject, validator.Errors(admitted))}`,
			);
		}
		if (definition.scope === "conversation" && !ctx.target) {
			throw new QueryRejectedError("unavailable", `${name} needs a conversation`);
		}
		return definition.run(ctx, admitted as never);
	}

	private validator(name: QueryName): Validator {
		const key = name as RegisteredQueryName;
		let validator = this.validators.get(key);
		if (validator === undefined) {
			validator = Compile(QUERY_SCHEMAS[name].params);
			this.validators.set(key, validator);
		}
		return validator;
	}
}
