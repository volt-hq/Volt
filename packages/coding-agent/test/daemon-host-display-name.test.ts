import { describe, expect, test } from "vitest";
import { type HostDisplayNameSources, resolveHostDisplayName } from "../src/daemon/host-display-name.ts";

function sources(overrides: Partial<HostDisplayNameSources>): HostDisplayNameSources {
	return {
		platform: "darwin",
		readMacComputerName: () => undefined,
		hostname: () => "Jordans-MacBook-Pro.local",
		...overrides,
	};
}

describe("resolveHostDisplayName", () => {
	test("prefers the macOS Computer Name", () => {
		expect(resolveHostDisplayName(sources({ readMacComputerName: () => "Jordan's MacBook Pro\n" }))).toBe(
			"Jordan's MacBook Pro",
		);
	});

	test("falls back to the hostname without its .local suffix when the Computer Name is unavailable", () => {
		expect(resolveHostDisplayName(sources({}))).toBe("Jordans-MacBook-Pro");
		expect(resolveHostDisplayName(sources({ readMacComputerName: () => "  \n" }))).toBe("Jordans-MacBook-Pro");
	});

	test("uses the hostname on other platforms without reading the macOS Computer Name", () => {
		let readComputerName = false;
		const resolved = resolveHostDisplayName({
			platform: "linux",
			readMacComputerName: () => {
				readComputerName = true;
				return "unused";
			},
			hostname: () => "build-box",
		});
		expect(resolved).toBe("build-box");
		expect(readComputerName).toBe(false);
	});

	test("returns undefined when no name is available", () => {
		expect(resolveHostDisplayName(sources({ hostname: () => " " }))).toBeUndefined();
		expect(resolveHostDisplayName(sources({ hostname: () => ".local" }))).toBeUndefined();
	});
});
