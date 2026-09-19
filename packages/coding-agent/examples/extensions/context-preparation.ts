/**
 * Opt-in deterministic preparation; no auxiliary inference, raw filesystem access, or cache.
 * See the Context preparation section in this directory's README for SDK configuration
 * and limitations. Loading this example does not raise the host's default zero wait.
 */
import type {
	ExtensionAPI,
	ExtensionWorkReadResult,
	ExtensionWorkSkill,
	ExtensionWorkTaskContext,
} from "@hansjm10/volt-coding-agent";

const WAIT_MS = 100;
const TASK_MS = 1000;
const READ_LINES = 40;
const EXCERPT_BYTES = 1536;
const STOP_WORDS = new Set(
	"and are can code file files for from help how into please source that the this use using when with".split(" "),
);

interface SourceCandidate {
	path: string;
	line?: number;
	symbol?: string;
}

function words(text: string): Set<string> {
	return new Set((text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((word) => !STOP_WORDS.has(word)));
}

function selectSkill(prompt: string, skills: readonly ExtensionWorkSkill[]): ExtensionWorkSkill | undefined {
	const terms = words(prompt);
	const names = new Set(prompt.toLowerCase().match(/[a-z][a-z0-9-]*/g));
	const ranked = skills.map((skill) => {
		const overlap = [...words(`${skill.name.slice(0, 64)} ${skill.description.slice(0, 1024)}`)].filter((word) =>
			terms.has(word),
		).length;
		return { skill, score: names.has(skill.name.toLowerCase()) ? 1000 : overlap >= 2 ? overlap : 0 };
	});
	ranked.sort((a, b) => b.score - a.score);
	if (!ranked[0]?.score || ranked[0].score === ranked[1]?.score) return undefined;
	return ranked[0].skill;
}

function selectSources(prompt: string): SourceCandidate[] {
	const sources: SourceCandidate[] = [];
	const seen = new Set<string>();
	// Deliberately parse whole tokens, never a path substring inside a URL or an absolute path.
	for (const token of prompt.match(/`[^`]*`|"[^"]*"|'[^']*'|[^\s`"'(),;<>]+/g) ?? []) {
		// Keep quoted paths whole: a space must not turn their trailing component into a new target.
		const value = /^[`"']/.test(token) ? token.slice(1, -1) : token;
		const match = value
			.replace(/[.!?]+$/, "")
			.match(
				/^(?:\.\/)?([a-zA-Z0-9_-][a-zA-Z0-9_./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|swift|java|kt|c|h|cpp|hpp|cs|rb|php|sh|md|txt|json|yaml|yml|toml))(?::([1-9][0-9]{0,6})|#([a-zA-Z_$][a-zA-Z0-9_$]{0,63}))?$/,
			);
		if (!match) continue;
		const path = match[1];
		if (
			path.length > 256 ||
			path
				.split("/")
				.some((part) => !part || part.startsWith(".") || part === "node_modules" || part === "vendor") ||
			seen.has(path)
		)
			continue;
		seen.add(path);
		sources.push({
			path,
			...(match[2] ? { line: Number(match[2]) } : {}),
			...(match[3] ? { symbol: match[3] } : {}),
		});
		if (sources.length === 2) break;
	}
	return sources;
}

function contribute(task: ExtensionWorkTaskContext, key: string, label: string, result: ExtensionWorkReadResult): void {
	if (task.signal.aborted || result.status !== "ok" || !result.text.trim()) return;
	// Streaming decode drops an incomplete final UTF-8 sequence rather than changing source bytes.
	const excerpt = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
		Buffer.from(result.text).subarray(0, EXCERPT_BYTES),
		{
			stream: true,
		},
	);
	const partial = result.truncated || excerpt.length < result.text.length;
	task.context.put({
		key,
		text: `${label}\n${partial ? "Partial excerpt; omitted content may matter.\n" : ""}${excerpt}`,
		dependency: "sources",
		evidenceIds: [result.evidence.id],
	});
}

async function prepareSource(task: ExtensionWorkTaskContext, source: SourceCandidate, index: number): Promise<void> {
	let offset = source.line ?? 1;
	let limit = READ_LINES;
	let expectedPath: string | undefined;
	if (source.symbol) {
		if (!task.snapshot.services.includes("symbols")) return;
		const result = await task.repository.symbols({ path: source.path });
		// An incomplete discovery cannot establish that a same-named symbol is unambiguous.
		if (task.signal.aborted || result.status !== "ok" || result.truncated) return;
		const matches = result.symbols.filter((symbol) => symbol.name === source.symbol);
		if (matches.length !== 1) return;
		offset = matches[0].startLine;
		limit = Math.min(READ_LINES, matches[0].endLine - offset + 1);
		expectedPath = matches[0].path;
	}
	if (task.signal.aborted) return;
	// Read only the explicit target, then compare canonical evidence with the discovered location.
	const result = await task.repository.readText({ path: source.path, offset, limit });
	if (expectedPath && result.status === "ok" && result.evidence.path !== expectedPath) return;
	contribute(
		task,
		`source-${index + 1}`,
		"Source excerpt selected heuristically; not proof of complete context or successful verification.",
		result,
	);
}

export default function contextPreparation(volt: ExtensionAPI): void {
	volt.on("request_boundary", (event, ctx) => {
		const work = ctx.work;
		if (!work || !event.first) return;
		// Bound synchronous selection. Do not mine explicitly expanded skill bodies for more work.
		const inputs = work.snapshot.inputs.slice(-8).map(({ text }) => text.slice(0, 8192));
		if (inputs.some((text) => text.startsWith("/skill:") || text.startsWith("<skill "))) return;
		const prompt = inputs.join("\n").slice(0, 8192);
		// Lexical matching cannot interpret exclusions: abstain on common negative cues.
		if (/\b(?:do not|don['’]t|never|avoid|skip|without)\b/i.test(prompt)) return;
		const skill = work.snapshot.services.includes("readSkill")
			? selectSkill(prompt, work.snapshot.skills)
			: undefined;
		const sources = work.snapshot.services.includes("readText")
			? selectSources(prompt).filter((source) => !source.symbol || work.snapshot.services.includes("symbols"))
			: [];
		if (!skill && sources.length === 0) return;
		const admission = work.tasks.start(
			{ key: "prepare-context", label: "Prepare context", timeoutMs: TASK_MS },
			async (task) => {
				const operations = sources.map((source, index) => prepareSource(task, source, index));
				if (skill) {
					operations.push(
						(async () => {
							const result = await task.repository.readSkill({
								resourceId: skill.resourceId,
								limit: READ_LINES,
							});
							contribute(
								task,
								"skill",
								`Skill excerpt ${JSON.stringify(skill.name.slice(0, 64))}; advisory only.`,
								result,
							);
						})(),
					);
				}
				await Promise.all(operations);
			},
		);
		if (admission.status === "started") work.context.requestWait(WAIT_MS);
	});
}
