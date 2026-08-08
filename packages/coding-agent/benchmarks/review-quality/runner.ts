import { evaluateReviewQuality } from "./evaluate.ts";
import { runRealModelReviewQuality } from "./real-model.ts";

try {
	const evaluation = await evaluateReviewQuality({ runRealModel: runRealModelReviewQuality });
	process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: { message } }, null, 2)}\n`);
	process.exitCode = 1;
}
