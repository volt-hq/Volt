import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnRpcClient } from "../src/client/protocol-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Interactive example of using coding-agent over RPC mode's protocol frames.
 * Usage: npx tsx test/rpc-example.ts
 */

async function main() {
	const client = await spawnRpcClient({
		cliPath: join(__dirname, "../dist/cli.js"),
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		args: ["--no-session"],
	});

	// Stream the assistant's text and tool progress from the live lane.
	client.onFrame((frame) => {
		if (frame.type !== "live") return;
		for (const item of frame.items) {
			if (
				item.type === "assistant_delta" &&
				(item.event.type === "text_delta" || item.event.type === "thinking_delta")
			) {
				process.stdout.write(item.event.delta);
			}
			if (item.type === "tool" && item.op === "start") console.log(`\n[Tool: ${item.toolName}]`);
		}
	});

	console.log(`Model: ${client.state.model?.provider}/${client.state.model?.modelId}`);
	console.log(`Thinking: ${client.state.thinkingLevel}\n`);

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	let isWaiting = false;

	const prompt = () => {
		if (!isWaiting) process.stdout.write("You: ");
	};

	rl.on("line", async (line) => {
		if (isWaiting) return;
		if (line.trim() === "exit") {
			await client.stop();
			process.exit(0);
		}

		isWaiting = true;
		await client.promptAndWait(line);
		console.log("\n");
		isWaiting = false;
		prompt();
	});

	rl.on("SIGINT", () => {
		if (isWaiting) {
			console.log("\n[Aborting...]");
			void client.intent("abort", {});
		} else {
			void client.stop();
			process.exit(0);
		}
	});

	console.log("Interactive RPC example. Type 'exit' to quit.\n");
	prompt();
}

main().catch(console.error);
