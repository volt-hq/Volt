import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

export const BYTE_REVIEW_PATHS = {
	fe: "collision-%FE.txt",
	ff: "collision-%FF.txt",
	replacement: "collision-�.txt",
	literal: "collision-%25FF.txt",
	directory: "dir-%FF",
	child: "dir-%FF/child.txt",
	shared: "shared.txt",
	added: "add-%FF.txt",
	deleted: "delete-%FE.txt",
	old: "old-%FE.txt",
	renamed: "new-%FF.txt",
	lineFeed: "line%0Abreak.txt",
	backslash: "back%5Cslash.txt",
	link: "link-%FF",
	module: "module-%FF",
	type: "type-%FF",
} as const;

/** Object-only fixture: none of its unusual filenames needs to exist on the host filesystem. */
export function createByteReviewRepository(repository: string): string {
	const git = (args: string[], input?: string | Buffer): string => {
		const result = spawnSync("git", args, { cwd: repository, input, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout.trim();
	};
	git(["init", "--initial-branch=main"]);
	git(["config", "user.email", "review@example.com"]);
	git(["config", "user.name", "Review Test"]);
	git(["config", "commit.gpgsign", "false"]);
	const blob = (content: string): string => git(["hash-object", "-w", "--stdin"], content);
	const entry = (path: string | Buffer, oid: string, mode = "100644", type = "blob"): Buffer =>
		Buffer.concat([Buffer.from(`${mode} ${type} ${oid}\t`), Buffer.from(path), Buffer.from([0])]);
	const tree = (entries: Buffer[]): string => git(["mktree", "-z"], Buffer.concat(entries));
	const odd = (prefix: string, byte: number, suffix = ".txt"): Buffer =>
		Buffer.concat([Buffer.from(prefix), Buffer.from([byte]), Buffer.from(suffix)]);
	const emptyTree = tree([]);
	const module = git(["commit-tree", emptyTree, "-m", "module"]);
	const makeTree = (head: boolean): string => {
		const revision = head ? "head" : "base";
		const shared = blob(`${revision} needle shared\nneedle second\n`);
		const renameLines = Array.from({ length: 20 }, (_, index) => `rename context ${index}`);
		renameLines[10] = `${revision} needle rename`;
		return tree([
			entry(odd("collision-", 0xfe), blob(`${revision} needle fe\nneedle second\n`)),
			entry(odd("collision-", 0xff), blob(`${revision} needle ff\nneedle second\n`)),
			entry("collision-�.txt", blob(`${revision} needle replacement\nneedle second\n`)),
			entry("collision-%FF.txt", blob(`${revision} needle literal\nneedle second\n`)),
			entry(odd("dir-", 0xff, ""), tree([entry("child.txt", shared)]), "040000", "tree"),
			entry("dir-other.txt", blob("needle unrelated\n")),
			entry("shared.txt", shared),
			entry(
				odd(head ? "add-" : "delete-", head ? 0xff : 0xfe),
				blob(head ? "needle completely new file\n" : "needle removed content\n"),
			),
			entry(odd(head ? "new-" : "old-", head ? 0xff : 0xfe), blob(`${renameLines.join("\n")}\n`)),
			entry("line\nbreak.txt", blob(`${revision} needle line feed\n`)),
			entry("back\\slash.txt", blob(`${revision} needle backslash\n`)),
			entry(odd("link-", 0xff, ""), blob("needle link target"), "120000"),
			entry(odd("module-", 0xff, ""), module, "160000", "commit"),
			entry(
				odd("type-", 0xff, ""),
				blob(head ? "needle regular file\n" : "needle old target"),
				head ? "100644" : "120000",
			),
		]);
	};
	const base = git(["commit-tree", makeTree(false), "-m", "byte paths base"]);
	return git(["commit-tree", makeTree(true), "-p", base, "-m", "byte paths head"]);
}
