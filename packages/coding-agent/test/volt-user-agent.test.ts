import { describe, expect, it } from "vitest";
import { getVoltUserAgent } from "../src/utils/volt-user-agent.ts";

describe("getVoltUserAgent", () => {
	it("formats the volt user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getVoltUserAgent("1.2.3");

		expect(userAgent).toBe(`volt/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^volt\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
