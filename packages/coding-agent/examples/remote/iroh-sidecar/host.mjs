import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import iroh from "@number0/iroh";
import {
	ALPN,
	ALPN_TEXT,
	encodeTicketPayload,
	getFlag,
	hasFlag,
	parseFlags,
	pipeIrohRecvToNodeWritable,
	pipeNodeReadableToIrohSend,
	readLineFromIroh,
	serializeJsonLine,
	toBytes,
} from "./common.mjs";

const { Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh;

function printUsage() {
	console.error(`Usage: npm run host -- [options]

Options:
  --workspace <name=path>    Workspace exposed to the client. Defaults to cwd.
  --relay <disabled|default> Iroh relay preset. Defaults to disabled for local tests.
  --use-volt                 Spawn volt --mode rpc instead of the fake RPC child.
  --volt-bin <path>          Volt executable for --use-volt. Defaults to volt.
  --allow-tools <list>       Tool allowlist passed to Volt. Defaults to read,grep,find,ls.
  --once                     Exit after the first client disconnects.
`);
}

function parseWorkspace(value) {
	if (!value) {
		const cwd = process.cwd();
		return { name: basename(cwd) || "workspace", path: cwd };
	}

	const separatorIndex = value.indexOf("=");
	if (separatorIndex === -1) {
		const path = resolve(value);
		return { name: basename(path) || "workspace", path };
	}

	const name = value.slice(0, separatorIndex).trim();
	const path = resolve(value.slice(separatorIndex + 1));
	if (!name) throw new Error("Workspace name cannot be empty");
	return { name, path };
}

async function bindEndpoint(relayMode) {
	const builder = Endpoint.builder();
	if (relayMode === "default") {
		presetN0(builder);
	} else {
		presetMinimal(builder);
		builder.relayMode(RelayMode.disabled());
	}
	builder.alpns([ALPN]);
	const endpoint = await builder.bind();
	if (relayMode === "default") {
		await endpoint.online();
	}
	return endpoint;
}

function spawnRpcChild(options) {
	if (!options.useVolt) {
		const fakeRpcPath = fileURLToPath(new URL("./fake-rpc.mjs", import.meta.url));
		return spawn(process.execPath, [fakeRpcPath], {
			cwd: options.workspace.path,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	const voltBin = process.platform === "win32" && options.voltBin === "volt" ? "volt.cmd" : options.voltBin;
	const args = ["--mode", "rpc", "--tools", options.allowTools];
	return spawn(voltBin, args, {
		cwd: options.workspace.path,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function attachChildLogging(child) {
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.trim().length > 0) process.stderr.write(`[volt-rpc] ${line}\n`);
		}
	});
}

async function sendHandshakeError(send, message) {
	await send.writeAll(toBytes(serializeJsonLine({ type: "volt_iroh_handshake", success: false, error: message })));
	await send.finish();
}

async function handleConnection(incoming, options) {
	const accepting = await incoming.accept();
	const connection = await accepting.connect();
	const remoteId = connection.remoteId().toString();
	console.error(`client connected: ${remoteId}`);

	let child;
	try {
		const stream = await connection.acceptBi();
		const handshake = await readLineFromIroh(stream.recv);
		if (handshake.line === undefined) {
			await sendHandshakeError(stream.send, "missing handshake");
			return;
		}

		const hello = JSON.parse(handshake.line);
		if (hello.type !== "volt_iroh_hello") {
			await sendHandshakeError(stream.send, "unexpected handshake type");
			return;
		}
		if (hello.protocol !== ALPN_TEXT) {
			await sendHandshakeError(stream.send, `unsupported protocol: ${hello.protocol}`);
			return;
		}
		if (hello.secret !== options.secret) {
			await sendHandshakeError(stream.send, "invalid pairing secret");
			return;
		}
		if (hello.workspace !== options.workspace.name) {
			await sendHandshakeError(stream.send, `workspace not allowed: ${hello.workspace}`);
			return;
		}

		await stream.send.writeAll(
			toBytes(
				serializeJsonLine({
					type: "volt_iroh_handshake",
					success: true,
					workspace: options.workspace.name,
					child: options.useVolt ? "volt" : "fake-rpc",
				}),
			),
		);

		child = spawnRpcChild(options);
		attachChildLogging(child);

		const clientToChild = pipeIrohRecvToNodeWritable(stream.recv, child.stdin, handshake.rest).catch((error) => {
			if (!child.killed) child.kill();
			throw error;
		});
		const childToClient = pipeNodeReadableToIrohSend(child.stdout, stream.send);
		const childExit = new Promise((resolveChildExit) => {
			child.once("exit", (code, signal) => resolveChildExit({ code, signal }));
		});

		await Promise.race([clientToChild, childToClient, childExit]);
	} finally {
		if (child && !child.killed) child.kill();
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		console.error(`client disconnected: ${remoteId}`);
	}
}

async function main() {
	const { flags } = parseFlags(process.argv.slice(2));
	if (hasFlag(flags, "help")) {
		printUsage();
		return;
	}

	const workspace = parseWorkspace(getFlag(flags, "workspace"));
	const relayMode = getFlag(flags, "relay", "disabled");
	if (relayMode !== "disabled" && relayMode !== "default") {
		throw new Error("--relay must be disabled or default");
	}

	const options = {
		allowTools: getFlag(flags, "allow-tools", "read,grep,find,ls"),
		relayMode,
		secret: randomBytes(24).toString("base64url"),
		once: hasFlag(flags, "once"),
		useVolt: hasFlag(flags, "use-volt"),
		voltBin: getFlag(flags, "volt-bin", "volt"),
		workspace,
	};

	const endpoint = await bindEndpoint(relayMode);
	const ticket = encodeTicketPayload({
		alpn: ALPN_TEXT,
		expiresAt: Date.now() + 10 * 60 * 1000,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		nodeId: endpoint.id().toString(),
		relayMode,
		secret: options.secret,
		workspace: workspace.name,
	});

	console.error(`host id: ${endpoint.id().toString()}`);
	console.error(`workspace: ${workspace.name} -> ${workspace.path}`);
	console.error(`child: ${options.useVolt ? "volt --mode rpc" : "fake-rpc"}`);
	console.error("pairing ticket:");
	console.log(ticket);

	while (true) {
		const incoming = await endpoint.acceptNext();
		if (!incoming) break;
		await handleConnection(incoming, options).catch((error) => {
			console.error(error instanceof Error ? error.stack : String(error));
		});
		if (options.once) break;
	}

	await endpoint.close();
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
