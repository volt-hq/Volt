import { createHash } from "node:crypto";
import type { LspDiagnostic } from "./client.ts";
import { SEVERITY_NAMES } from "./config.ts";
import type { LspFreshness, LspProjectContext } from "./outcome.ts";

export const MAX_FEEDBACK_FILES = 256;
export const MAX_FEEDBACK_FINGERPRINTS = 4096;
export const MAX_AUTOMATIC_REPORT_BYTES = 8 * 1024;
const MAX_CROSS_FILE_REPORTS = 5;

export interface DiagnosticFeedbackSnapshot {
	path: string;
	displayPath: string;
	diagnostics: LspDiagnostic[];
	freshness: LspFreshness;
	projectContext?: LspProjectContext;
	/** Other files require a known-clean baseline or prior automatic eligibility. */
	otherFile?: boolean;
	wasClean?: boolean;
}

interface Delivery {
	sequence: number;
	crossEligible: boolean;
	fingerprints: Map<string, string>;
}

function fingerprint(diagnostic: LspDiagnostic): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				diagnostic.message,
				diagnostic.range.start.line,
				diagnostic.range.start.character,
				diagnostic.range.end.line,
				diagnostic.range.end.character,
				diagnostic.severity ?? 1,
				diagnostic.code ?? null,
				diagnostic.source ?? null,
			]),
		)
		.digest("hex");
}

/** Bounded automatic-delivery state, independent of the client's publication cache. */
export class LspDiagnosticFeedback {
	private files = new Map<string, Delivery>();
	private fingerprintCount = 0;

	clear(): void {
		this.files.clear();
		this.fingerprintCount = 0;
	}

	forget(serverKey: string, path?: string): void {
		const prefix = `${serverKey}\u0000`;
		for (const key of this.files.keys()) {
			if (path === undefined ? key.startsWith(prefix) : key === prefix + path) this.remove(key);
		}
	}

	private remove(key: string): void {
		this.fingerprintCount -= this.files.get(key)?.fingerprints.size ?? 0;
		this.files.delete(key);
	}

	/** Called synchronously with current snapshots; only fully emitted findings consume delivery state. */
	render(
		serverKey: string,
		sequence: number,
		snapshots: DiagnosticFeedbackSnapshot[],
		maxSeverity: number,
		maxDiagnostics: number,
		prefix = "",
	): string {
		const lines: string[] = [];
		let bytes = 0;
		let emitted = 0;
		let otherFiles = 0;
		let omitted = 0;
		const append = (text: string): boolean => {
			const size = Buffer.byteLength(text) + (lines.length ? 1 : 0);
			// Reserve space for an explicit truncation notice, regardless of message/path size.
			if (bytes + size > MAX_AUTOMATIC_REPORT_BYTES - 128) return false;
			lines.push(text);
			bytes += size;
			return true;
		};
		if (prefix) append(prefix);
		for (const snapshot of snapshots) {
			if (snapshot.freshness !== "fresh" && snapshot.freshness !== "unverified") continue;
			const key = `${serverKey}\u0000${snapshot.path}`;
			let delivery = this.files.get(key);
			if (delivery && delivery.sequence > sequence) continue;
			if (snapshot.otherFile && !snapshot.wasClean && !delivery?.crossEligible) continue;
			if (!delivery) delivery = { sequence, crossEligible: false, fingerprints: new Map() };
			if (snapshot.otherFile && snapshot.wasClean) delivery.crossEligible = true;
			delivery.sequence = sequence;
			// Touch LRU before reconciliation, keeping both files and fixed-size hashes bounded.
			this.files.delete(key);
			this.files.set(key, delivery);
			const current = new Map(
				snapshot.diagnostics
					.filter((item) => (item.severity ?? 1) <= maxSeverity)
					.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
					.map((item) => [fingerprint(item), item]),
			);
			let removed = 0;
			for (const hash of delivery.fingerprints.keys()) {
				if (!current.has(hash)) {
					delivery.fingerprints.delete(hash);
					this.fingerprintCount--;
					removed++;
				}
			}
			const confidence = `${snapshot.freshness}:${snapshot.projectContext ?? ""}`;
			const changed = [...current].filter(([hash]) => delivery.fingerprints.get(hash) !== confidence);
			const recovery =
				removed && snapshot.freshness === "fresh"
					? `${snapshot.displayPath}: ${removed} previously reported diagnostic${removed === 1 ? "" : "s"} no longer reported (fresh snapshot; not a build check).`
					: "";
			const limitedContext = snapshot.projectContext === "not-detected" || snapshot.projectContext === "unknown";
			const label =
				snapshot.freshness === "unverified"
					? `Best-effort diagnostics (unversioned; freshness: unverified${limitedContext ? "; Swift context unverified" : ""}):`
					: limitedContext
						? "Best-effort diagnostics (fresh; Swift context unverified):"
						: "Diagnostics (fresh):";
			let header = snapshot.otherFile ? `Newly failing in other open files:\n${label}` : label;
			if (snapshot.otherFile && (changed.length || recovery)) {
				if (otherFiles >= MAX_CROSS_FILE_REPORTS) {
					omitted += changed.length || 1;
					continue;
				}
				otherFiles++;
			}
			if (recovery && !append(recovery)) omitted++;
			for (const [hash, diagnostic] of changed) {
				const severity = SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error";
				const code =
					diagnostic.code !== undefined
						? ` [${diagnostic.source ? `${diagnostic.source} ` : ""}${diagnostic.code}]`
						: "";
				const message = diagnostic.message.replace(/\s+/g, " ").trim();
				const line = `${snapshot.displayPath}(${diagnostic.range.start.line + 1},${diagnostic.range.start.character + 1}): ${severity}: ${message}${code}`;
				if (emitted >= Math.max(0, maxDiagnostics) || !append(`${header ? `${header}\n` : ""}${line}`)) {
					omitted++;
					continue;
				}
				header = "";
				emitted++;
				if (!delivery.fingerprints.has(hash)) this.fingerprintCount++;
				delivery.fingerprints.set(hash, confidence);
			}
		}
		while (this.files.size > MAX_FEEDBACK_FILES || this.fingerprintCount > MAX_FEEDBACK_FINGERPRINTS) {
			this.remove(this.files.keys().next().value!);
		}
		if (omitted)
			lines.push(
				`... and ${omitted} more diagnostic/recovery entries omitted (automatic report truncated; use lsp diagnostics for a full report).`,
			);
		return lines.join("\n");
	}
}
