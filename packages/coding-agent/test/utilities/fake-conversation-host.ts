/**
 * A fake conversation host for mode tests over fake sessions. It keeps one
 * attachment per client, attaches a client's live view to the conversation's
 * live state and its extension surface to the fake session when the client
 * joins a conversation, closes a conversation when its anchor leaves, and
 * moves an in-place client through the client's move protocol (`prepare`,
 * join, `onMoved`, then the source closes) as the real `ConversationHost` does.
 */

import { vi } from "vitest";
import type { ExtensionMode } from "../../src/core/extensions/index.ts";
import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { LiveState } from "../../src/core/host/live-state.ts";
import type { HostClient } from "../../src/core/host/targets.ts";

interface FakeExtensionAttachment {
	ready?: Promise<void>;
	detach?: () => void;
}

interface FakeSessionLike {
	sessionId?: string;
	liveState?: LiveState;
	attachExtensionClient?: (client: object) => FakeExtensionAttachment;
}

export interface FakeConversation {
	readonly conversation: HostedConversation;
	/** Resolve the conversation's `lost`: its session lost its log. */
	loseLog(error: Error): void;
}

/**
 * A fake hosted conversation over `session`. `members` adds or replaces
 * conversation members (`listSessions`, `reviewWorkflows`, `services`, ...).
 * Its live state is the session's `liveState`, or its own.
 */
export function createFakeConversation(session: object, members: Record<string, unknown> = {}): FakeConversation {
	const lost = Promise.withResolvers<Error>();
	const conversation = {
		session,
		get id() {
			return (session as FakeSessionLike).sessionId ?? "";
		},
		closed: false,
		lost: lost.promise,
		services: {},
		liveState: (session as FakeSessionLike).liveState ?? new LiveState(),
		...members,
	};
	return { conversation: conversation as unknown as HostedConversation, loseLog: (error) => lost.resolve(error) };
}

interface Attachment {
	client: HostClient;
	conversation: HostedConversation;
	detachLive?: () => void;
	detachSurface?: () => void;
}

export interface FakeHost {
	readonly host: ConversationHost;
	readonly attach: ReturnType<typeof vi.fn<(client: HostClient, conversation: HostedConversation) => Promise<void>>>;
	readonly detach: ReturnType<typeof vi.fn<(client: HostClient) => Promise<void>>>;
	readonly close: ReturnType<typeof vi.fn<(conversation: HostedConversation) => Promise<void>>>;
	/** The client attached to `conversation`, if any. */
	clientOf(conversation: HostedConversation): HostClient | undefined;
	/** Move an in-place `client` to `to`, as the host does for a structural intent. */
	move(client: HostClient, to: HostedConversation): Promise<void>;
}

export function createFakeHost(
	options: {
		extensionMode?: ExtensionMode;
		onClose?: (conversation: HostedConversation) => Promise<void> | void;
	} = {},
): FakeHost {
	const attachments = new Map<string, Attachment>();
	const closedListeners = new Set<(conversation: HostedConversation) => void>();
	const mode = options.extensionMode ?? "rpc";

	const join = async (client: HostClient, conversation: HostedConversation): Promise<void> => {
		if (conversation.closed) throw new Error("Cannot attach to a closed conversation");
		const attachment: Attachment = { client, conversation };
		attachments.set(client.id, attachment);
		try {
			if (client.live) attachment.detachLive = conversation.liveState.attach(client.id, client.live);
			if (!client.surface) return;
			const session = conversation.session as unknown as FakeSessionLike;
			const extensions = session.attachExtensionClient?.({ ...client.surface, id: client.id, mode });
			attachment.detachSurface = extensions?.detach;
			await extensions?.ready;
		} catch (error) {
			if (attachments.get(client.id) === attachment) attachments.delete(client.id);
			attachment.detachLive?.();
			throw error;
		}
	};
	const leave = (attachment: Attachment): void => {
		if (attachments.get(attachment.client.id) === attachment) attachments.delete(attachment.client.id);
		attachment.detachSurface?.();
		attachment.detachLive?.();
		attachment.detachLive = undefined;
	};
	const close = vi.fn(async (conversation: HostedConversation): Promise<void> => {
		if (conversation.closed) return;
		(conversation as { closed: boolean }).closed = true;
		await options.onClose?.(conversation);
		// As a disposed session does: its pending host requests end.
		conversation.liveState.close();
		for (const attachment of [...attachments.values()]) {
			if (attachment.conversation === conversation) leave(attachment);
		}
		for (const listener of [...closedListeners]) listener(conversation);
	});
	const attach = vi.fn(async (client: HostClient, conversation: HostedConversation) => {
		if (attachments.has(client.id)) throw new Error(`Client ${client.id} is already attached; move it instead`);
		await join(client, conversation);
	});
	const detach = vi.fn(async (client: HostClient) => {
		const attachment = attachments.get(client.id);
		if (!attachment) return;
		if (client.anchor) {
			await close(attachment.conversation);
			return;
		}
		leave(attachment);
	});
	const host = {
		attach,
		detach,
		close,
		conversationOf: (client: HostClient) => attachments.get(client.id)?.conversation,
		onClosed: (listener: (conversation: HostedConversation) => void) => {
			closedListeners.add(listener);
			return () => {
				closedListeners.delete(listener);
			};
		},
	} as unknown as ConversationHost;
	return {
		host,
		attach,
		detach,
		close,
		clientOf: (conversation) =>
			[...attachments.values()].find((attachment) => attachment.conversation === conversation)?.client,
		async move(client, to) {
			const move = client.move;
			if (move.kind !== "in_place") throw new Error("Only an in-place client moves in place");
			const attachment = attachments.get(client.id);
			const from = attachment?.conversation;
			if (attachment) leave(attachment);
			move.prepare?.(to, from);
			await join(client, to);
			await move.onMoved(to, from);
			if (from && client.anchor) await close(from);
		},
	};
}
