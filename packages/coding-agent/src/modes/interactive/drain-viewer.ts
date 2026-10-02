import type { MarkdownTheme, TUI } from "@hansjm10/volt-tui";
import { Container, Loader, Spacer, Text } from "@hansjm10/volt-tui";
import { type ProjectionDiagnostic, StreamProjectionDecoder } from "../../core/rpc/stream-projection.ts";
import { theme } from "../../core/theme/runtime.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { isCoalescableAssistantUpdate, StreamingRenderCoalescer } from "./components/streaming-render-coalescer.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";

/**
 * Read-only attach overlay for lease drains (§6.3): renders the draining
 * remote turn's viewer feed through the existing message/tool components
 * WITHOUT a live session. The post-grant session file load is authoritative;
 * on a truncated feed the viewer shows only the spinner.
 */

type ViewerMessage = {
	role?: string;
	content?: Array<Record<string, unknown>>;
	stopReason?: string;
};

type ViewerEvent = {
	type?: string;
	/** {kind:"truncated"}: buffer overflowed daemon-side; spinner only. */
	kind?: string;
	message?: ViewerMessage;
	assistantMessageEvent?: { type?: string };
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	partialResult?: { content?: unknown[] };
	result?: { content?: unknown[] };
	isError?: boolean;
};

export interface DrainViewerOptions {
	markdownTheme: MarkdownTheme;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	showImages: boolean;
	imageWidthCells: number;
	cwd: string;
	/** Registered tool definition lookup (custom render support), if available. */
	getToolDefinition?: (toolName: string) => unknown;
}

export class DrainViewerComponent extends Container {
	private readonly tui: TUI;
	private readonly options: DrainViewerOptions;
	private readonly loader: Loader;
	private readonly content = new Container();
	private readonly streamProjectionDecoder = new StreamProjectionDecoder({
		onDiagnostic: (diagnostic) => reportStreamProjectionDiagnostic("drain-viewer", diagnostic),
	});
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingRenderCoalescer: StreamingRenderCoalescer<ViewerMessage> | undefined;
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private truncated = false;
	private finished = false;

	constructor(tui: TUI, options: DrainViewerOptions) {
		super();
		this.tui = tui;
		this.options = options;
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("muted", "A remote turn is still streaming; watching it finish before taking over."), 1, 0),
		);
		this.addChild(this.content);
		this.loader = new Loader(
			tui,
			(s: string) => theme.fg("accent", s),
			(s: string) => theme.fg("muted", s),
			"Attaching — finishing remote turn… (esc stops the remote turn)",
		);
		this.loader.start();
		this.addChild(this.loader);
	}

	/** Feed one viewer_event payload (an AgentSessionEvent as plain JSON). */
	handleViewerEvent(raw: unknown): void {
		if (this.finished || typeof raw !== "object" || raw === null) {
			return;
		}
		const wireEvent = raw as ViewerEvent;
		if (wireEvent.kind === "truncated") {
			// Too much history to replay; show only the spinner and rely on the
			// post-grant session file load. Pending tool rows never see a terminal
			// render after this, so their renderer resources must be released here
			// or partial subagent rows leak their repaint intervals.
			this.truncated = true;
			this.streamProjectionDecoder.dispose();
			this.streamingRenderCoalescer?.dispose();
			this.streamingRenderCoalescer = undefined;
			this.content.clear();
			this.streamingComponent = undefined;
			this.disposePendingTools();
			this.tui.requestRender();
			return;
		}
		if (this.truncated && wireEvent.type !== "agent_end") {
			// After truncation we only show the spinner and skip content replay, but
			// agent_end merely advances the loader label — let it through so the
			// overlay reflects the remote turn finishing instead of staying stuck on
			// "finishing remote turn…".
			return;
		}
		const decoded = this.streamProjectionDecoder.decode(raw);
		if (decoded === undefined) {
			return;
		}
		const event = decoded as ViewerEvent;
		switch (event.type) {
			case "message_start": {
				const message = event.message;
				if (message?.role === "assistant") {
					this.startAssistantStream(message);
					this.upsertToolCalls(message);
				} else if (message?.role === "user") {
					const text = (message.content ?? [])
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => part.text as string)
						.join("\n");
					if (text.trim().length > 0) {
						this.content.addChild(new UserMessageComponent(text, this.options.markdownTheme));
					}
				}
				break;
			}
			case "message_update": {
				if (event.message?.role === "assistant") {
					if (!this.streamingComponent || !this.streamingRenderCoalescer) {
						// Mid-message drains have no preceding message_start. The encoder's
						// first update is a full snapshot, so it can initialize the overlay.
						this.startAssistantStream(event.message);
						this.upsertToolCalls(event.message);
					} else {
						if (isCoalescableAssistantUpdate(event.assistantMessageEvent?.type)) {
							this.streamingRenderCoalescer.update(event.message);
						} else {
							this.streamingRenderCoalescer.commitNow(event.message);
						}
						if (event.assistantMessageEvent?.type?.startsWith("toolcall_")) {
							this.upsertToolCalls(event.message);
						}
					}
				}
				return;
			}
			case "message_end": {
				if (event.message?.role === "assistant") {
					if (!this.streamingComponent || !this.streamingRenderCoalescer) {
						// A drain can attach after the last update. message_end is a full,
						// authoritative snapshot and must initialize the overlay on its own.
						this.startAssistantStream(event.message);
					}
					this.streamingRenderCoalescer?.finish(event.message);
					this.streamingRenderCoalescer = undefined;
					this.upsertToolCalls(event.message);
					this.streamingComponent = undefined;
				}
				return;
			}
			case "tool_execution_start": {
				if (typeof event.toolCallId === "string") {
					this.ensureTool(event.toolCallId, event.toolName ?? "tool", event.args ?? {}).markExecutionStarted();
				}
				break;
			}
			case "tool_execution_update": {
				const component = event.toolCallId === undefined ? undefined : this.pendingTools.get(event.toolCallId);
				if (component && event.partialResult) {
					component.updateResult({ ...event.partialResult, isError: false } as never, true);
				}
				break;
			}
			case "tool_execution_end": {
				const component = event.toolCallId === undefined ? undefined : this.pendingTools.get(event.toolCallId);
				if (component && event.result) {
					component.updateResult({ ...event.result, isError: event.isError === true } as never);
					if (event.toolCallId !== undefined) {
						this.pendingTools.delete(event.toolCallId);
					}
				}
				break;
			}
			case "agent_end": {
				this.loader.setMessage("Remote turn finished — taking over…");
				break;
			}
			default:
				break;
		}
		this.tui.requestRender();
	}

	private startAssistantStream(message: ViewerMessage): void {
		this.streamingRenderCoalescer?.dispose();
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			this.options.hideThinkingBlock,
			this.options.markdownTheme,
			this.options.hiddenThinkingLabel,
		);
		this.content.addChild(this.streamingComponent);
		this.streamingRenderCoalescer = new StreamingRenderCoalescer((latest) => {
			this.streamingComponent?.updateContent(latest as never);
			this.tui.requestRender();
		});
		this.streamingRenderCoalescer.commitNow(message);
	}

	private upsertToolCalls(message: ViewerMessage): void {
		for (const part of message.content ?? []) {
			if (part.type === "toolCall" && typeof part.id === "string") {
				const existing = this.pendingTools.get(part.id);
				if (existing) {
					existing.updateArgs((part.arguments ?? {}) as Record<string, unknown>);
				} else {
					this.ensureTool(
						part.id,
						typeof part.name === "string" ? part.name : "tool",
						(part.arguments ?? {}) as Record<string, unknown>,
					);
				}
			}
		}
	}

	private ensureTool(toolCallId: string, toolName: string, args: Record<string, unknown>): ToolExecutionComponent {
		let component = this.pendingTools.get(toolCallId);
		if (!component) {
			component = new ToolExecutionComponent(
				toolName,
				toolCallId,
				args,
				{ showImages: this.options.showImages, imageWidthCells: this.options.imageWidthCells },
				this.options.getToolDefinition?.(toolName) as never,
				this.tui,
				this.options.cwd,
			);
			this.content.addChild(component);
			this.pendingTools.set(toolCallId, component);
		}
		return component;
	}

	/** Stop the spinner; the component is removed by the post-grant re-render. */
	finish(message?: string): void {
		this.finished = true;
		this.streamProjectionDecoder.dispose();
		this.streamingRenderCoalescer?.dispose();
		this.streamingRenderCoalescer = undefined;
		this.disposePendingTools();
		if (message) {
			this.loader.setMessage(message);
		}
		this.loader.stop();
	}

	private disposePendingTools(): void {
		for (const component of this.pendingTools.values()) {
			component.dispose();
		}
		this.pendingTools.clear();
	}
}

function reportStreamProjectionDiagnostic(boundary: string, diagnostic: ProjectionDiagnostic): void {
	console.error(`[stream-projection:${boundary}] ${diagnostic.code}: ${diagnostic.message}`, diagnostic);
}
