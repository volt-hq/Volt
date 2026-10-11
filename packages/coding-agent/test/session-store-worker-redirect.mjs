// Loaded with --import into every Vitest worker process and the threads it starts (vitest.config.ts).
// A session-store worker started from source loads the store's unbundled module graph, about half a
// second, on every start. The global setup bundles that worker once per run, as the shipped CLI does,
// and this hook loads the bundle in its place.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceWorker = new URL("../src/core/session-store/worker.ts", import.meta.url).href;
if (!existsSync(fileURLToPath(sourceWorker))) {
	throw new Error(`The session store worker moved; update ${fileURLToPath(import.meta.url)}`);
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		// Read lazily: Vitest applies its test env after this hook loads into a worker process.
		const bundle = process.env.VOLT_TEST_SESSION_STORE_WORKER;
		if (!bundle || resolved.url !== sourceWorker) return resolved;
		return { ...resolved, url: pathToFileURL(bundle).href, format: "module" };
	},
});
