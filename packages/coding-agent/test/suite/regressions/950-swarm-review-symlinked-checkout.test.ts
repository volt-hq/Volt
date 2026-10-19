// Regression for https://github.com/volt-hq/Volt/issues/950
//
// The swarm review's confined tools compared a path with its symlinks resolved against roots as given. A checkout
// reached through a symlink (on macOS, every checkout under tmpdir(): /var -> /private/var) therefore refused every
// file in it. An in-checkout symlink that leads outside the repository must still be refused.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@hansjm10/volt-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryTools } from "../../../../../.volt/extensions/swarm-review/tools.ts";
import type { ReviewTarget } from "../../../../../.volt/extensions/swarm-review/types.ts";

const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

describe("swarm review tools in a checkout reached through a symlink (issue #950)", () => {
	let base: string | undefined;

	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
		base = undefined;
	});

	/** A checkout whose path goes through a symlink, holding a file and a symlink to a directory outside it. */
	function symlinkedCheckout(): string {
		base = realpathSync(mkdtempSync(join(tmpdir(), "volt-swarm-symlinked-checkout-")));
		const real = join(base, "real");
		const outside = join(base, "outside");
		mkdirSync(real);
		mkdirSync(outside);
		writeFileSync(join(real, "a.ts"), "export const inside = 1;\n");
		writeFileSync(join(outside, "secret.txt"), "outside the repository\n");
		symlinkSync(outside, join(real, "escape"), DIRECTORY_LINK);
		const checkout = join(base, "link");
		symlinkSync(real, checkout, DIRECTORY_LINK);
		return checkout;
	}

	function readTool(checkout: string): ToolDefinition {
		const target: ReviewTarget = {
			repoRoot: checkout,
			checkout,
			description: "test change",
			stat: "",
			scope: [],
			shards: [],
			fileHunks: new Map(),
			hunkBytes: new Map(),
			complete: true,
			submodules: false,
			commonDir: join(checkout, ".git"),
			readBase: async () => undefined,
			createCheckout: async () => checkout,
		};
		const tools: ToolDefinition[] = createRepositoryTools(target, checkout);
		const read = tools.find((tool) => tool.name === "read");
		if (!read) throw new Error("createRepositoryTools returned no read tool");
		return read;
	}

	const read = (checkout: string, path: string) =>
		readTool(checkout).execute("read-1", { path }, undefined, undefined, {} as ExtensionContext);

	it("reads a file in the checkout", async () => {
		const result = await read(symlinkedCheckout(), "a.ts");
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("export const inside = 1;") }]);
	});

	it("still refuses an in-checkout symlink that leads outside the repository", async () => {
		await expect(read(symlinkedCheckout(), "escape/secret.txt")).rejects.toThrow(
			"Access outside the repository under review is not allowed",
		);
	});

	it("reports a missing file in the checkout as missing, not as outside the repository", async () => {
		await expect(read(symlinkedCheckout(), "missing.ts")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
