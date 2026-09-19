import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { type Skill, type SkillFileIdentity, skillFileIdentities } from "../skills.ts";
import type { ExtensionWorkSkill } from "./work-types.ts";

interface Resource {
	skill: Skill;
	filePath: string;
	identity: Readonly<SkillFileIdentity>;
	metadata: ExtensionWorkSkill;
}

/** Runtime-local exact-file grants derived only from the already loaded native catalog. */
export class ExtensionSkillCatalog {
	private resources = new Map<string, Resource>();
	private loaded: Skill[] = [];
	private truncated = false;

	snapshot(skills: Skill[]): { skills: ExtensionWorkSkill[]; skillsTruncated: boolean } {
		if (skills.length !== this.loaded.length || skills.some((skill, i) => skill !== this.loaded[i])) {
			this.loaded = [...skills];
			this.resources.clear();
			this.truncated = false;
			let bytes = 2; // JSON array brackets.
			for (const skill of skills) {
				const identity = skillFileIdentities.get(skill);
				if (skill.disableModelInvocation || !identity) continue;
				const metadata: ExtensionWorkSkill = {
					resourceId: randomUUID(),
					name: skill.name,
					description: skill.description,
					scope: skill.sourceInfo.scope,
					origin: skill.sourceInfo.origin,
				};
				const size = Buffer.byteLength(JSON.stringify(metadata)) + (this.resources.size > 0 ? 1 : 0);
				if (this.resources.size >= 128 || bytes + size > 64 * 1024) {
					this.truncated = true;
					continue;
				}
				bytes += size;
				this.resources.set(metadata.resourceId, { skill, filePath: skill.filePath, identity, metadata });
			}
		}
		return {
			skills: [...this.resources.values()].map(({ metadata }) => ({ ...metadata })),
			skillsTruncated: this.truncated,
		};
	}

	resolve(resourceId: string, skills: Skill[]): Resource | undefined {
		const resource = this.resources.get(resourceId);
		if (
			!resource ||
			!skills.includes(resource.skill) ||
			resource.skill.disableModelInvocation ||
			resource.skill.filePath !== resource.filePath ||
			skillFileIdentities.get(resource.skill) !== resource.identity
		)
			return undefined;
		try {
			if (realpathSync(resource.filePath) !== resource.identity.path) return undefined;
		} catch {
			return undefined;
		}
		return resource;
	}
}
