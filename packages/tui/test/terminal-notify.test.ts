/**
 * Tests for terminal desktop-notification sequence building.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { buildNotificationSequence, detectNotificationProtocol, sanitizeNotificationText } from "../src/terminal.ts";

const BEL = "\x07";
const ST = "\x1b\\";

describe("detectNotificationProtocol", () => {
	it("picks OSC 99 for kitty", () => {
		assert.strictEqual(detectNotificationProtocol({ TERM: "xterm-kitty" }), "osc99");
		assert.strictEqual(detectNotificationProtocol({ KITTY_WINDOW_ID: "1", TERM: "xterm-256color" }), "osc99");
	});

	it("picks OSC 777 for WezTerm, Ghostty, foot, and urxvt", () => {
		assert.strictEqual(detectNotificationProtocol({ TERM_PROGRAM: "WezTerm", TERM: "wezterm" }), "osc777");
		assert.strictEqual(detectNotificationProtocol({ TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }), "osc777");
		assert.strictEqual(detectNotificationProtocol({ TERM: "foot" }), "osc777");
		assert.strictEqual(detectNotificationProtocol({ TERM: "rxvt-unicode-256color" }), "osc777");
	});

	it("picks OSC 9 for iTerm2 and ConEmu", () => {
		assert.strictEqual(detectNotificationProtocol({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" }), "osc9");
		assert.strictEqual(detectNotificationProtocol({ ConEmuANSI: "ON", TERM: "xterm" }), "osc9");
	});

	it("falls back to bell for multiplexers even inside a capable terminal", () => {
		assert.strictEqual(
			detectNotificationProtocol({ TMUX: "/tmp/tmux-1000/default,1,0", TERM: "xterm-kitty" }),
			"bell",
		);
		assert.strictEqual(detectNotificationProtocol({ TERM: "screen-256color", TERM_PROGRAM: "WezTerm" }), "bell");
		assert.strictEqual(detectNotificationProtocol({ TERM: "tmux-256color" }), "bell");
	});

	it("falls back to bell for unknown terminals, Windows Terminal, Apple Terminal, and VS Code", () => {
		assert.strictEqual(detectNotificationProtocol({ TERM: "xterm-256color" }), "bell");
		assert.strictEqual(detectNotificationProtocol({ WT_SESSION: "guid", TERM: "xterm-256color" }), "bell");
		assert.strictEqual(
			detectNotificationProtocol({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }),
			"bell",
		);
		assert.strictEqual(detectNotificationProtocol({ TERM_PROGRAM: "vscode", TERM: "xterm-256color" }), "bell");
		assert.strictEqual(detectNotificationProtocol({}), "bell");
	});
});

describe("buildNotificationSequence", () => {
	it("builds a kitty OSC 99 title+body pair", () => {
		const seq = buildNotificationSequence("Volt", "Done", { TERM: "xterm-kitty" });
		assert.strictEqual(seq, `\x1b]99;i=volt:d=0:p=title;Volt${ST}\x1b]99;i=volt:d=1:p=body;Done${ST}`);
	});

	it("builds an OSC 777 notify sequence", () => {
		const seq = buildNotificationSequence("Volt", "Done", { TERM_PROGRAM: "WezTerm" });
		assert.strictEqual(seq, `\x1b]777;notify;Volt;Done${ST}`);
	});

	it("escapes field separators in the OSC 777 title but not the final body field", () => {
		const seq = buildNotificationSequence("a;b", "c;d", { TERM_PROGRAM: "WezTerm" });
		assert.strictEqual(seq, `\x1b]777;notify;a,b;c;d${ST}`);
	});

	it("builds an OSC 9 sequence with title prefix", () => {
		const seq = buildNotificationSequence("Volt", "Done", { TERM_PROGRAM: "iTerm.app" });
		assert.strictEqual(seq, `\x1b]9;Volt: Done${BEL}`);
	});

	it("omits the title prefix in OSC 9 when the title is empty", () => {
		const seq = buildNotificationSequence("", "Done", { TERM_PROGRAM: "iTerm.app" });
		assert.strictEqual(seq, `\x1b]9;Done${BEL}`);
	});

	it("falls back to BEL for unsupported terminals", () => {
		assert.strictEqual(buildNotificationSequence("Volt", "Done", { TERM: "xterm-256color" }), BEL);
	});

	it("strips control characters so text cannot break out of the OSC sequence", () => {
		const seq = buildNotificationSequence("Vo\x1blt", "Do\x07ne\nnow", { TERM_PROGRAM: "iTerm.app" });
		assert.strictEqual(seq, `\x1b]9;Vo lt: Do ne now${BEL}`);
	});
});

describe("sanitizeNotificationText", () => {
	it("collapses whitespace and trims", () => {
		assert.strictEqual(sanitizeNotificationText("  a \t b\r\nc  "), "a b c");
	});

	it("caps length with an ellipsis", () => {
		const long = "x".repeat(500);
		const out = sanitizeNotificationText(long);
		assert.strictEqual(out.length, 200);
		assert.ok(out.endsWith("…"));
	});

	it("preserves unicode text", () => {
		assert.strictEqual(sanitizeNotificationText("完了 · done ✓"), "完了 · done ✓");
	});
});
