/**
 * A single-file extension that registers faux providers in each session that
 * loads it, so no real provider is involved.
 *
 * - Under a test, the providers the test offered (`offerFauxProvider`), so a
 *   conversation the test does not build itself (a daemon's in-process
 *   worker) streams from the test's faux provider. Its module may load more
 *   than once in a process (the extension loader loads its own copy), so the
 *   offered providers live on `globalThis`.
 * - In a process the test spawned (a daemon's worker process), the providers
 *   the test serves over a local socket (`serveFauxProvider`): each request
 *   streams from the test's faux provider in the test's process. The agent
 *   directory names the socket.
 * - Run on its own (`./volt-test.sh --no-env -e <this file>`), a `faux`
 *   provider that answers every request with a canned reply.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessageEvent,
	type Context,
	classifyProviderError,
	createAssistantMessageEventStream,
	createFauxProvider,
	type FauxProvider,
	fauxAssistantMessage,
	type Model,
} from "@hansjm10/volt-ai";
import { getAgentDir } from "../../src/config.ts";
import type { ExtensionAPI, ProviderConfig } from "../../src/core/extensions/types.ts";

export const manifest = {
	id: "faux-provider",
	displayName: "Faux provider",
	permissions: ["providers"],
} as const;

const PROVIDERS = Symbol.for("volt.test.fauxProviders");

function offered(): Map<string, FauxProvider> {
	const global = globalThis as { [PROVIDERS]?: Map<string, FauxProvider> };
	global[PROVIDERS] ??= new Map();
	return global[PROVIDERS];
}

/** The file in an agent directory that names the socket a test serves its faux providers on. */
const CHANNEL_FILE = "faux-provider-channel.json";

interface FauxChannel {
	readonly endpoint: string;
	readonly providers: ReadonlyArray<{ readonly name: string; readonly faux: Pick<FauxProvider, "api" | "models"> }>;
}

/** A line-delimited JSON reader for one socket. */
function readLines(socket: Socket, onLine: (line: unknown) => void): void {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			try {
				onLine(JSON.parse(line));
			} catch {
				socket.destroy();
				return;
			}
		}
	});
}

/**
 * Serve `faux` to the worker processes of the daemon on `agentDir` until the
 * returned function stops: each of their requests streams from it here.
 */
export async function serveFauxProvider(faux: FauxProvider, agentDir: string): Promise<() => Promise<void>> {
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\volt-faux-${randomUUID()}`
			: join(tmpdir(), `volt-faux-${randomUUID().slice(0, 8)}.sock`);
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => undefined);
		const aborted = new AbortController();
		socket.on("close", () => aborted.abort());
		let started = false;
		readLines(socket, (message) => {
			const request = message as { type?: string; model?: Model<string>; context?: Context; options?: object };
			if (request.type === "abort") {
				aborted.abort();
				return;
			}
			if (request.type !== "stream" || started || !request.model || !request.context) return;
			started = true;
			void (async () => {
				const stream = faux.streamSimple(request.model as Model<string>, request.context as Context, {
					...request.options,
					signal: aborted.signal,
				});
				for await (const event of stream) {
					if (socket.destroyed) return;
					socket.write(`${JSON.stringify({ type: "event", event })}\n`);
				}
				socket.end();
			})().catch(() => socket.destroy());
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => resolve());
	});
	const channelPath = join(agentDir, CHANNEL_FILE);
	const channel: FauxChannel = {
		endpoint,
		providers: [{ name: faux.getModel().provider, faux: { api: faux.api, models: faux.models } }],
	};
	writeFileSync(channelPath, `${JSON.stringify(channel)}\n`, { mode: 0o600 });
	return async () => {
		rmSync(channelPath, { force: true });
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
}

/** A provider that streams each request from the test's faux provider over the channel. */
function channelStream(endpoint: string): ProviderConfig["streamSimple"] {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const socket = connect(endpoint);
		let seq = 0;
		let finished = false;
		socket.on("error", () => undefined);
		readLines(socket, (message) => {
			const event = (message as { event?: AssistantMessageEvent }).event;
			if (!event || finished) return;
			seq = event.seq;
			if (event.type === "done" || event.type === "error") finished = true;
			stream.push(event);
		});
		socket.on("close", () => {
			if (finished) return;
			finished = true;
			const error = fauxAssistantMessage([], {
				stopReason: "error",
				error: classifyProviderError(new Error("The faux provider channel closed")),
			});
			stream.push({
				type: "error",
				seq: seq + 1,
				reason: "error",
				error: { ...error, api: model.api, provider: model.provider, model: model.id },
			});
		});
		const { signal, ...serializable } = options ?? {};
		signal?.addEventListener("abort", () => socket.write(`${JSON.stringify({ type: "abort" })}\n`), { once: true });
		socket.write(`${JSON.stringify({ type: "stream", model, context, options: serializable })}\n`);
		return stream;
	};
}

/** The channel a test serves in this agent directory, if any. */
function readChannel(): FauxChannel | undefined {
	const path = join(getAgentDir(), CHANNEL_FILE);
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as FauxChannel;
}

/** Offer `faux` to the sessions that load this extension, until the returned function withdraws it. */
export function offerFauxProvider(faux: FauxProvider): () => void {
	const name = faux.getModel().provider;
	offered().set(name, faux);
	return () => {
		if (offered().get(name) === faux) offered().delete(name);
	};
}

function lastUserText(context: Context): string {
	const message = context.messages.findLast((candidate) => candidate.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** A provider for a standalone run: every turn and every auxiliary completion gets a canned reply. */
function standaloneProvider(): { faux: FauxProvider; streamSimple: ProviderConfig["streamSimple"] } {
	const faux = createFauxProvider();
	const reply = (context: Context) => fauxAssistantMessage(`Faux reply to: ${lastUserText(context).slice(0, 200)}`);
	return {
		faux,
		streamSimple: (model, context, options) => {
			if (faux.getPendingResponseCount() === 0) faux.appendResponses([reply]);
			if (faux.getPendingSimpleResponseCount() === 0) faux.appendSimpleResponses([reply]);
			return faux.streamSimple(model, context, options);
		},
	};
}

function register(
	volt: ExtensionAPI,
	name: string,
	faux: Pick<FauxProvider, "api" | "models">,
	streamSimple: ProviderConfig["streamSimple"],
) {
	volt.registerProvider(name, {
		baseUrl: faux.models[0].baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		streamSimple,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	});
}

export default function fauxProviderExtension(volt: ExtensionAPI): void {
	if (offered().size > 0) {
		for (const [name, faux] of offered()) register(volt, name, faux, faux.streamSimple);
		return;
	}
	const channel = readChannel();
	if (channel) {
		for (const { name, faux } of channel.providers) register(volt, name, faux, channelStream(channel.endpoint));
		return;
	}
	const standalone = standaloneProvider();
	register(volt, standalone.faux.getModel().provider, standalone.faux, standalone.streamSimple);
}
