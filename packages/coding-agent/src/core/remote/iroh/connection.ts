/**
 * A paired device's stream after its handshake: protocol 1 frames on the
 * remote profile (RFC §6.2). The daemon serves conversation streams of the
 * conversations it hosts and every workspace stream; a TUI serves the
 * conversation streams the daemon relays to it. Both go through here, so a
 * phone sees one wire whichever host process serves it.
 */

import type { RemoteGrant } from "@hansjm10/volt-protocol";
import type { ConversationHost } from "../../host/conversation-host.ts";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import { type ProfileLimits, remoteProfile } from "../../protocol/profiles.ts";
import type { RemoteRedactionOptions } from "../../protocol/remote-redaction.ts";
import {
	type ProtocolConnection,
	type ServeConnectionOptions,
	serveConnection,
} from "../../protocol/server/connection.ts";
import {
	createIrohRpcTransport,
	createIrohSendQueueBudget,
	type IrohBiStreamLike,
	type IrohBytes,
	type IrohSendQueueBudget,
} from "../../rpc/iroh-transport.ts";
import { attachCompletionNotifications, type CompletionNotificationsOptions } from "./completion-notifications.ts";

export interface IrohRemoteConnectionOptions
	extends Pick<
		ServeConnectionOptions,
		"redirect" | "services" | "authority" | "revalidate" | "admit" | "allows" | "relay" | "clientKey"
	> {
	/** The host of the stream's conversation; a workspace stream has none. */
	readonly host?: ConversationHost;
	/** The conversation the stream is bound to; none for a workspace stream. */
	readonly conversation?: HostedConversation;
	readonly stream: IrohBiStreamLike;
	/** Bytes the device sent after its handshake line. */
	readonly initialInput?: IrohBytes;
	/** The device's grant as the stream was admitted with. */
	readonly grant: RemoteGrant;
	/** The roots redacted from every frame. */
	readonly redaction: Pick<
		RemoteRedactionOptions,
		"workspacePath" | "remoteWorkspacePath" | "additionalRedactedPaths"
	>;
	/** Completion notifications for the device's own prompts; none without a conversation. */
	readonly notifications?: CompletionNotificationsOptions;
	/** Overrides of the remote profile's bounds, for tests. */
	readonly limits?: Partial<ProfileLimits>;
}

/** Bytes all streams of one device may queue together; each stream also keeps its profile's bound. */
const DEVICE_SEND_QUEUE_BYTES = 128 * 1024 * 1024;

/** The shared send queue bound of each device with open streams, by its `clientKey`. */
const deviceSendBudgets = new Map<string, { budget: IrohSendQueueBudget; streams: number }>();

function deviceSendBudget(clientKey: string): { budget: IrohSendQueueBudget; release(): void } {
	let entry = deviceSendBudgets.get(clientKey);
	if (!entry) {
		entry = { budget: createIrohSendQueueBudget(DEVICE_SEND_QUEUE_BYTES), streams: 0 };
		deviceSendBudgets.set(clientKey, entry);
	}
	const held = entry;
	held.streams++;
	return {
		budget: held.budget,
		release() {
			held.streams--;
			if (held.streams === 0 && deviceSendBudgets.get(clientKey) === held) deviceSendBudgets.delete(clientKey);
		},
	};
}

/** Serve a paired device's stream until it ends. */
export function serveIrohRemoteConnection(options: IrohRemoteConnectionOptions): ProtocolConnection {
	const conversation = options.conversation;
	const profile = remoteProfile({
		grant: options.grant,
		redaction: options.redaction,
		...(conversation === undefined ? {} : { bound: conversation.id }),
		...(options.limits === undefined ? {} : { limits: options.limits }),
	});
	const device = options.clientKey === undefined ? undefined : deviceSendBudget(options.clientKey);
	const transport = createIrohRpcTransport({
		stream: options.stream,
		...(device === undefined ? {} : { queueBudget: device.budget }),
		...(options.initialInput === undefined ? {} : { initialInput: options.initialInput }),
		maxLineBytes: profile.limits.frameBytes,
		...(profile.limits.sendQueueBytes === undefined ? {} : { maxQueuedBytes: profile.limits.sendQueueBytes }),
	});
	const notifications =
		conversation === undefined || options.notifications === undefined
			? undefined
			: attachCompletionNotifications(conversation, options.notifications);
	const connection = serveConnection(transport, profile, {
		...(options.host === undefined ? {} : { host: options.host }),
		...(conversation === undefined ? {} : { conversation }),
		anchor: false,
		...(options.redirect === undefined ? {} : { redirect: options.redirect }),
		...(options.services === undefined ? {} : { services: options.services }),
		...(options.authority === undefined ? {} : { authority: options.authority }),
		...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
		...(options.admit === undefined ? {} : { admit: options.admit }),
		...(options.allows === undefined ? {} : { allows: options.allows }),
		...(options.relay === undefined ? {} : { relay: options.relay }),
		...(options.clientKey === undefined ? {} : { clientKey: options.clientKey }),
		...(notifications === undefined ? {} : { onInputAccepted: () => notifications.inputAccepted() }),
	});
	void connection.closed
		.finally(() => {
			notifications?.detach();
			device?.release();
		})
		.catch(() => undefined);
	return connection;
}
