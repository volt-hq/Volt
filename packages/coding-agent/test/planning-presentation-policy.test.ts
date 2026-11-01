import { describe, expect, it } from "vitest";
import { formatPlanPolicy } from "../src/core/planning.ts";

describe("Plan mode presentation policy", () => {
	it("describes the host-enforced sequential execution contract", () => {
		expect(formatPlanPolicy("plan")).toContain("Order outcomes and substeps for sequential execution");
		const policy = formatPlanPolicy("build", "active");
		expect(policy).toContain("Only the earliest unfinished leaf may start");
		expect(policy).toContain("in_progress state committed in a previous call");
		expect(policy).toContain("complete the current leaf and start the next");
		expect(policy).toContain("Completed leaves cannot be reopened");
		expect(policy).toContain("resets active leaves to pending");
		expect(policy).not.toContain("multiple leaves genuinely completed together");
	});

	it("defaults to a scannable decision artifact instead of a research transcript", () => {
		const policy = formatPlanPolicy("plan");

		expect(policy).toContain("Use the fewest items that preserve clear scope and execution detail");
		expect(policy).toContain("Large tasks may contain as many outcomes and substeps as required");
		expect(policy).toContain("never compress unrelated work to meet an arbitrary count");
		expect(policy).toContain("optimize the user-facing artifact for scanability");
		expect(policy).toContain("remove research chronology");
		expect(policy).toContain("only decision-driving findings and consequential assumptions");
	});
});
