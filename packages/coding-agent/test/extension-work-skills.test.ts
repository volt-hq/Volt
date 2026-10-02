import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionSkillCatalog } from "../src/core/extensions/work-skills.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "volt-skill-catalog-"));
	directories.push(directory);
	const path = join(directory, "sample.md");
	await writeFile(path, "---\nname: sample\ndescription: Sample guidance\n---\ncontent\n");
	const loaded = loadSkillsFromDir({ dir: directory, source: "user" });
	return { directory, path, skills: loaded.skills };
}

describe("managed loaded skill catalog", () => {
	it("keeps detached catalog metadata and rejects foreign/runtime-stale handles", async () => {
		const { skills } = await fixture();
		const catalog = new ExtensionSkillCatalog();
		const snapshot = catalog.snapshot(skills);
		const resourceId = snapshot.skills[0].resourceId;
		snapshot.skills[0].name = "changed by consumer";
		expect(catalog.snapshot(skills).skills[0].name).toBe("sample");
		expect(catalog.resolve(resourceId, skills)).toBeDefined();
		expect(catalog.resolve(resourceId, [])).toBeUndefined();
		const replacement = new ExtensionSkillCatalog();
		expect(replacement.snapshot(skills).skills[0].resourceId).not.toBe(resourceId);
		expect(replacement.resolve(resourceId, skills)).toBeUndefined();
	});

	it("preserves native identity through DefaultResourceLoader metadata projection", async () => {
		const { directory, path } = await fixture();
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalSkillPaths: [path],
		});
		await loader.reload();
		const catalog = new ExtensionSkillCatalog();
		const skills = loader.getSkills().skills;
		const snapshot = catalog.snapshot(skills);
		expect(snapshot.skills).toHaveLength(1);
		expect(catalog.resolve(snapshot.skills[0].resourceId, skills)?.identity.path).toBe(await realpath(path));
	});

	it("does not turn a symlink retarget after loading into a new resource grant", async () => {
		const { directory, path } = await fixture();
		const aliasDirectory = join(directory, "alias");
		const alias = join(aliasDirectory, "sample.md");
		// Directory junctions preserve realpath retargeting without Windows symlink privileges.
		const linkType = process.platform === "win32" ? "junction" : "dir";
		await symlink(directory, aliasDirectory, linkType);
		expect(await realpath(alias)).toBe(await realpath(path));
		// Load only the alias to retain its lexical membership as well as the original descriptor identity.
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			additionalSkillPaths: [alias],
		});
		await loader.reload();
		const skills = loader.getSkills().skills;
		const secretDirectory = join(directory, "secret");
		await mkdir(secretDirectory);
		const secret = join(secretDirectory, "sample.md");
		await writeFile(secret, "private bytes");
		await unlink(aliasDirectory);
		await symlink(secretDirectory, aliasDirectory, linkType);
		expect(await realpath(alias)).toBe(await realpath(secret));
		const catalog = new ExtensionSkillCatalog();
		const snapshot = catalog.snapshot(skills);
		expect(snapshot.skills).toHaveLength(1);
		expect(catalog.resolve(snapshot.skills[0].resourceId, skills)).toBeUndefined();
	});

	it("bounds catalog entries and reports omitted metadata without truncating individual descriptors", async () => {
		const { directory } = await fixture();
		await Promise.all(
			Array.from({ length: 130 }, (_, i) =>
				writeFile(join(directory, `skill-${i}.md`), `---\nname: skill-${i}\ndescription: Guidance ${i}\n---\nbody`),
			),
		);
		const skills = loadSkillsFromDir({ dir: directory, source: "user" }).skills;
		const snapshot = new ExtensionSkillCatalog().snapshot(skills);
		expect(snapshot.skills).toHaveLength(128);
		expect(snapshot.skillsTruncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(snapshot.skills))).toBeLessThan(64 * 1024);
	});
});
