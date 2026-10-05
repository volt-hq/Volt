/**
 * Extension permissions (RFC §8.2, Q2): what an extension declares it does
 * beyond the conversation, the user's acknowledgment of it, and the checks
 * the extension API makes.
 *
 * Permissions are advisory: extensions run in-process and are not sandboxed,
 * so an extension can reach Node's own modules. The API still refuses what a
 * manifest does not declare: `volt.exec` needs `exec`; `volt.registerProvider`
 * and provider registration through `ctx.modelRegistry` need `providers`; and
 * stored credentials (`ctx.modelRegistry.authStorage` and the API key reads)
 * need `secrets`. `network` and `fs-write` are declared and shown but not
 * enforced.
 *
 * Acknowledgments live in the user's `extension-permissions.json` (mode 0600)
 * by manifest id: the package fingerprint and the permissions acknowledged.
 * A fingerprint names where the code came from and which revision: an npm
 * package's name and version, a git repository and commit, or a local path.
 * An extension is acknowledged when its fingerprint matches and it declares
 * nothing beyond what was acknowledged, so another package, a changed
 * revision outside an update, or a new permission asks again. Startup never
 * asks: install and update ask, and enabling asks for what is still
 * unacknowledged.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXTENSION_ID_PATTERN, EXTENSION_PERMISSIONS, type ExtensionPermission } from "@hansjm10/volt-protocol";
import lockfile from "proper-lockfile";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { isLocalPath } from "../../utils/paths.ts";
import { ensurePrivateDirectorySync, hardenPrivateRegularFileSync } from "../../utils/private-files.ts";
import { type ExtensionManifest, readPackageManifest } from "./manifest.ts";

/** What each permission lets an extension do, as install and enable prompts show it. */
export const EXTENSION_PERMISSION_DESCRIPTIONS: Readonly<Record<ExtensionPermission, string>> = {
	exec: "run commands",
	network: "use the network (not enforced)",
	"fs-write": "write files (not enforced)",
	secrets: "read stored credentials and API keys",
	providers: "register model providers",
};

/** One line per permission: its name and what it allows. */
export function describePermissions(permissions: readonly ExtensionPermission[]): string[] {
	return permissions.map((permission) => `${permission}: ${EXTENSION_PERMISSION_DESCRIPTIONS[permission]}`);
}

// ============================================================================
// API checks
// ============================================================================

/** An extension API call its manifest does not permit. */
export class ExtensionPermissionError extends Error {
	readonly extensionId: string;
	readonly permission: ExtensionPermission;

	constructor(extensionId: string, permission: ExtensionPermission, use: string) {
		super(
			`Extension "${extensionId}" needs the "${permission}" permission to use ${use}: declare it in the manifest's "permissions"`,
		);
		this.name = "ExtensionPermissionError";
		this.extensionId = extensionId;
		this.permission = permission;
	}
}

/** An extension and the permissions its manifest declares. */
export interface PermissionHolder {
	readonly id: string;
	readonly manifest: Pick<ExtensionManifest, "permissions">;
}

/** Throw an {@link ExtensionPermissionError} unless `holder` declares `permission`. */
export function requirePermission(holder: PermissionHolder, permission: ExtensionPermission, use: string): void {
	if (!holder.manifest.permissions?.includes(permission)) {
		throw new ExtensionPermissionError(holder.id, permission, use);
	}
}

/** `ctx.modelRegistry` members an extension needs a permission to reach. */
const MODEL_REGISTRY_PERMISSIONS: Readonly<Record<string, ExtensionPermission>> = {
	authStorage: "secrets",
	getApiKeyAndHeaders: "secrets",
	getApiKeyForProvider: "secrets",
	login: "secrets",
	registerProvider: "providers",
	unregisterProvider: "providers",
	clearRegisteredProviders: "providers",
};

/** `ctx.modelRegistry.client` members an extension needs a permission to reach. */
const AI_CLIENT_PERMISSIONS: Readonly<Record<string, ExtensionPermission>> = {
	registerProvider: "providers",
	unregisterProvider: "providers",
	registerImagesProvider: "providers",
	unregisterImagesProvider: "providers",
	registerOAuthProvider: "providers",
	unregisterOAuthProvider: "providers",
	setModels: "providers",
	// Provider implementations are shared objects a caller could patch to see credentials.
	getProvider: "providers",
	getProviders: "providers",
	getOAuthProvider: "providers",
	getOAuthProviders: "providers",
	// Image models are not in the catalog requests are checked against.
	generateImages: "secrets",
};

/** AI client requests that carry the stored credentials of their model's provider to the model's `baseUrl`. */
const AI_CLIENT_REQUESTS: ReadonlySet<string> = new Set([
	"stream",
	"complete",
	"streamSimple",
	"completeSimple",
	"refreshPromptCache",
]);

function checkedMembers<T extends object>(
	target: T,
	members: Readonly<Record<string, ExtensionPermission>>,
	check: (permission: ExtensionPermission, member: string) => void,
	label: string,
	nested: (key: string, value: unknown) => unknown = (_key, value) => value,
): T {
	const checkMember = (key: string | symbol): void => {
		if (typeof key === "string" && Object.hasOwn(members, key)) check(members[key]!, `${label}.${key}`);
	};
	return new Proxy(target, {
		get: (object, key) => {
			checkMember(key);
			const value = Reflect.get(object, key);
			return typeof key === "string" ? nested(key, value) : value;
		},
		// A property's descriptor carries its value: it is checked like a read.
		getOwnPropertyDescriptor: (object, key) => {
			checkMember(key);
			const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(object, key);
			if (descriptor !== undefined && "value" in descriptor && typeof key === "string") {
				descriptor.value = nested(key, descriptor.value);
			}
			return descriptor;
		},
	});
}

interface CatalogModel {
	readonly provider: string;
	readonly id: string;
	readonly baseUrl?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Throw unless `model` is a catalog model as the catalog has it: without
 * `secrets`, a request may not take a provider's credentials to another
 * `baseUrl` or with other headers.
 */
function requireCatalogModel(
	holder: PermissionHolder,
	model: unknown,
	find: (provider: string, id: string) => CatalogModel | undefined,
	use: string,
): void {
	const candidate = model as Partial<CatalogModel> | undefined;
	const catalog =
		typeof candidate?.provider === "string" && typeof candidate.id === "string"
			? find(candidate.provider, candidate.id)
			: undefined;
	if (
		catalog === undefined ||
		candidate?.baseUrl !== catalog.baseUrl ||
		JSON.stringify(candidate?.headers ?? {}) !== JSON.stringify(catalog.headers ?? {})
	) {
		throw new ExtensionPermissionError(holder.id, "secrets", `${use} with a model other than the catalog's`);
	}
}

/**
 * `modelRegistry` as an extension's context shows it to `holder`: reaching
 * stored credentials needs `secrets`, and registering providers (directly or
 * through its AI client) needs `providers`. Without `secrets`, the AI client
 * sends requests only for catalog models as the catalog has them.
 */
export function permissionCheckedModelRegistry<T extends object>(target: T, holder: PermissionHolder): T {
	const check = (permission: ExtensionPermission, use: string) => requirePermission(holder, permission, use);
	const secrets = holder.manifest.permissions?.includes("secrets") === true;
	const find = (provider: string, id: string): CatalogModel | undefined => {
		const lookup: unknown = Reflect.get(target, "find");
		return typeof lookup === "function" ? (lookup(provider, id) as CatalogModel | undefined) : undefined;
	};
	const request = (key: string, value: unknown): unknown => {
		if (secrets || !AI_CLIENT_REQUESTS.has(key) || typeof value !== "function") return value;
		return (model: unknown, ...rest: unknown[]) => {
			requireCatalogModel(holder, model, find, `ctx.modelRegistry.client.${key}`);
			return Reflect.apply(value, undefined, [model, ...rest]);
		};
	};
	let client: { readonly source: unknown; readonly checked: unknown } | undefined;
	return checkedMembers(target, MODEL_REGISTRY_PERMISSIONS, check, "ctx.modelRegistry", (key, value) => {
		if (key !== "client" || typeof value !== "object" || value === null) return value;
		if (client?.source !== value) {
			client = {
				source: value,
				checked: checkedMembers(value, AI_CLIENT_PERMISSIONS, check, "ctx.modelRegistry.client", request),
			};
		}
		return client.checked;
	});
}

// ============================================================================
// Fingerprints
// ============================================================================

const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_GIT_FILE_BYTES = 64 * 1024;

function readSmallFile(path: string): string | undefined {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_GIT_FILE_BYTES) return undefined;
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/** The git directory of the checkout containing `path`, if any. */
function gitDirectory(path: string): string | undefined {
	let current = resolve(path);
	for (let depth = 0; depth < 32; depth++) {
		const dotGit = join(current, ".git");
		try {
			const stat = lstatSync(dotGit);
			if (stat.isDirectory()) return dotGit;
			if (stat.isFile()) {
				const pointer = readSmallFile(dotGit)?.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
				return pointer === undefined ? undefined : resolve(current, pointer);
			}
		} catch {
			// No .git here; look further up.
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

/** The commit the checkout containing `path` has checked out, read from its git directory. */
export function readGitHead(path: string): string | undefined {
	const gitDir = gitDirectory(path);
	if (gitDir === undefined) return undefined;
	const head = readSmallFile(join(gitDir, "HEAD"))?.trim();
	if (head === undefined) return undefined;
	if (GIT_SHA.test(head)) return head;
	const ref = head.match(/^ref:\s*(refs\/[^\s]+)$/)?.[1];
	if (ref === undefined || ref.includes("\\") || ref.split("/").includes("..")) return undefined;
	const loose = readSmallFile(join(gitDir, ref))?.trim();
	if (loose !== undefined && GIT_SHA.test(loose)) return loose;
	for (const line of readSmallFile(join(gitDir, "packed-refs"))?.split("\n") ?? []) {
		const [sha, name] = line.trim().split(" ");
		if (name === ref && sha !== undefined && GIT_SHA.test(sha)) return sha;
	}
	return undefined;
}

function packageVersion(root: string): string | undefined {
	try {
		const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
		if (typeof pkg !== "object" || pkg === null) return undefined;
		const { version } = pkg as { version?: unknown };
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * An npm source's identity, from the source as configured, never from the
 * installed package.json: `npm:<name>` for a registry spec (a name with an
 * optional version, range, or tag), else the whole spec (a URL, path, or
 * alias names its own origin).
 */
function npmIdentity(source: string): string {
	const spec = source.slice("npm:".length).trim();
	const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
	const name = at === -1 ? spec : spec.slice(0, at);
	const range = at === -1 ? "" : spec.slice(at + 1);
	return /^[\w.\-+~^<>=|* ]*$/.test(range) && !name.includes(":") ? `npm:${name}` : `npm:${spec}`;
}

function localFingerprint(path: string): string {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		real = resolve(path);
	}
	return `local:${createHash("sha256").update(real).digest("hex").slice(0, 32)}`;
}

/**
 * Where an extension's code came from, and which revision:
 * `npm:<name>@<version>` (the name from the configured source, the version
 * installed), `git:<host>/<path>@<commit>`, `local:<hash of its real path>`,
 * or `sdk:<id>` for an extension a program passes to the SDK.
 * `path` is the extension's package root or module; `packageSource` the
 * package source it was installed from, when it was.
 */
export function extensionFingerprint(options: {
	readonly id: string;
	readonly path: string;
	readonly packageSource?: string;
}): string {
	if (options.path.startsWith("<")) return `sdk:${options.id}`;
	const source = options.packageSource?.trim();
	if (source !== undefined && !isLocalPath(source)) {
		if (source.startsWith("npm:")) {
			return `${npmIdentity(source)}@${packageVersion(options.path) ?? "unknown"}`;
		} else {
			const git = parseGitUrl(source);
			if (git !== null) return `git:${git.host}/${git.path}@${readGitHead(options.path) ?? git.ref ?? "unknown"}`;
		}
	}
	return localFingerprint(options.path);
}

/** A fingerprint without its revision: the same package at another version or commit has the same identity. */
export function fingerprintIdentity(fingerprint: string): string {
	if (!fingerprint.startsWith("npm:") && !fingerprint.startsWith("git:")) return fingerprint;
	const at = fingerprint.lastIndexOf("@");
	return at > fingerprint.indexOf(":") + 1 ? fingerprint.slice(0, at) : fingerprint;
}

// ============================================================================
// Acknowledgments
// ============================================================================

/** What the user acknowledged for one extension. */
export interface PermissionAcknowledgment {
	readonly fingerprint: string;
	readonly permissions: readonly ExtensionPermission[];
	readonly version: string;
	/** ISO 8601. */
	readonly acknowledgedAt: string;
}

/** An extension whose permissions are checked: its id, fingerprint, and declared permissions. */
export interface PermissionSubject {
	readonly id: string;
	readonly fingerprint: string;
	readonly permissions: readonly ExtensionPermission[];
}

/**
 * What a loaded extension's permissions are checked as. Enabling an
 * extension asks the user for the ones its review says to ask (RFC §8.2):
 * `store.review(permissionSubject(extension))`.
 */
export function permissionSubject(extension: {
	readonly id: string;
	readonly fingerprint: string;
	readonly manifest: Pick<ExtensionManifest, "permissions">;
}): PermissionSubject {
	return { id: extension.id, fingerprint: extension.fingerprint, permissions: extension.manifest.permissions ?? [] };
}

/**
 * Whether a subject's permissions need the user:
 * - `acknowledged`: it declares none, or the user acknowledged these for this fingerprint;
 * - `carried`: the same package at another revision that adds none (an update records it without asking);
 * - `ask`: show the permissions, marking those `added` since the last acknowledgment of the same package.
 */
export type PermissionReview =
	| { readonly status: "acknowledged" }
	| { readonly status: "carried" }
	| { readonly status: "ask"; readonly added: readonly ExtensionPermission[] };

const PERMISSIONS_FILE = "extension-permissions.json";
const MAX_PERMISSIONS_FILE_BYTES = 1024 * 1024;
const MAX_FINGERPRINT_CHARS = 1024;
const MAX_VERSION_CHARS = 256;
const ID = new RegExp(EXTENSION_ID_PATTERN);
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(EXTENSION_PERMISSIONS);

function readAcknowledgment(value: unknown): PermissionAcknowledgment | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { fingerprint, permissions, version, acknowledgedAt } = value as Record<string, unknown>;
	if (typeof fingerprint !== "string" || fingerprint.length === 0 || fingerprint.length > MAX_FINGERPRINT_CHARS) {
		return undefined;
	}
	if (!Array.isArray(permissions) || !permissions.every((entry) => KNOWN_PERMISSIONS.has(entry))) return undefined;
	if (typeof version !== "string" || version.length > MAX_VERSION_CHARS) return undefined;
	if (typeof acknowledgedAt !== "string" || acknowledgedAt.length > 64) return undefined;
	return {
		fingerprint,
		permissions: [...new Set(permissions as ExtensionPermission[])],
		version,
		acknowledgedAt,
	};
}

function covers(granted: readonly ExtensionPermission[], wanted: readonly ExtensionPermission[]): boolean {
	return wanted.every((permission) => granted.includes(permission));
}

/** The user's permission acknowledgments, in `<agentDir>/extension-permissions.json`. */
export class ExtensionPermissionStore {
	private readonly path: string;

	constructor(agentDir: string) {
		this.path = join(resolve(agentDir), PERMISSIONS_FILE);
	}

	private read(): Map<string, PermissionAcknowledgment> {
		const acknowledgments = new Map<string, PermissionAcknowledgment>();
		if (!existsSync(this.path)) return acknowledgments;
		const stat = hardenPrivateRegularFileSync(this.path);
		if (stat.size > MAX_PERMISSIONS_FILE_BYTES) {
			throw new Error(`Extension permissions file exceeds ${MAX_PERMISSIONS_FILE_BYTES} bytes: ${this.path}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf-8"));
		} catch (error) {
			throw new Error(
				`Failed to read extension permissions ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Invalid extension permissions ${this.path}: expected an object`);
		}
		for (const [id, value] of Object.entries(parsed)) {
			const acknowledgment = ID.test(id) ? readAcknowledgment(value) : undefined;
			if (acknowledgment !== undefined) acknowledgments.set(id, acknowledgment);
		}
		return acknowledgments;
	}

	private write(acknowledgments: ReadonlyMap<string, PermissionAcknowledgment>): void {
		const sorted: Record<string, PermissionAcknowledgment> = {};
		for (const id of [...acknowledgments.keys()].sort()) {
			Object.defineProperty(sorted, id, { value: acknowledgments.get(id), enumerable: true });
		}
		const serialized = `${JSON.stringify(sorted, null, 2)}\n`;
		if (Buffer.byteLength(serialized, "utf8") > MAX_PERMISSIONS_FILE_BYTES) {
			throw new Error(`Refusing to write extension permissions larger than ${MAX_PERMISSIONS_FILE_BYTES} bytes`);
		}
		writeDurableAtomicFileSync(this.path, serialized, { directoryMode: 0o700, fileMode: 0o600 });
	}

	private withLock<T>(fn: () => T): T {
		ensurePrivateDirectorySync(dirname(this.path));
		let release: (() => void) | undefined;
		for (let attempt = 1; release === undefined; attempt++) {
			try {
				release = lockfile.lockSync(dirname(this.path), { realpath: false, lockfilePath: `${this.path}.lock` });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ELOCKED" || attempt >= 10) throw error;
				const start = Date.now();
				while (Date.now() - start < 20) {
					// Wait synchronously: callers are synchronous.
				}
			}
		}
		try {
			return fn();
		} finally {
			release();
		}
	}

	/** What the user acknowledged for `id`, if anything. */
	get(id: string): PermissionAcknowledgment | undefined {
		return this.withLock(() => this.read().get(id));
	}

	/** How `subject`'s permissions stand against what the user acknowledged. */
	review(subject: PermissionSubject): PermissionReview {
		if (subject.permissions.length === 0) return { status: "acknowledged" };
		const acknowledged = this.get(subject.id);
		if (acknowledged?.fingerprint === subject.fingerprint && covers(acknowledged.permissions, subject.permissions)) {
			return { status: "acknowledged" };
		}
		const samePackage =
			acknowledged !== undefined &&
			fingerprintIdentity(acknowledged.fingerprint) === fingerprintIdentity(subject.fingerprint);
		if (samePackage && covers(acknowledged.permissions, subject.permissions)) return { status: "carried" };
		const granted = samePackage ? acknowledged.permissions : [];
		return { status: "ask", added: subject.permissions.filter((permission) => !granted.includes(permission)) };
	}

	/** Whether the user acknowledged `subject`'s permissions for its fingerprint. */
	isAcknowledged(subject: PermissionSubject): boolean {
		return this.review(subject).status === "acknowledged";
	}

	/** Record that the user acknowledged `subject`'s permissions at `version`. */
	acknowledge(subject: PermissionSubject & { readonly version: string }): void {
		if (!ID.test(subject.id)) throw new Error(`Invalid extension id ${JSON.stringify(subject.id)}`);
		if (subject.fingerprint.length === 0 || subject.fingerprint.length > MAX_FINGERPRINT_CHARS) {
			throw new Error("Invalid extension fingerprint");
		}
		this.withLock(() => {
			const acknowledgments = this.read();
			acknowledgments.set(subject.id, {
				fingerprint: subject.fingerprint,
				permissions: [...new Set(subject.permissions)],
				version: subject.version.slice(0, MAX_VERSION_CHARS),
				acknowledgedAt: new Date().toISOString(),
			});
			this.write(acknowledgments);
		});
	}
}

/** The extension a package declares, as its permissions are reviewed at install and update. */
export interface PackagePermissions extends PermissionSubject {
	readonly displayName: string;
	readonly version: string;
}

/**
 * The extension the package installed at `root` from `source` declares, with
 * its fingerprint; undefined when it declares none. Reads package.json only.
 * Throws when the manifest is invalid.
 */
export function readPackagePermissions(root: string, source: string): PackagePermissions | undefined {
	const declared = readPackageManifest(root);
	if (declared === undefined) return undefined;
	const { manifest, version } = declared;
	return {
		id: manifest.id,
		displayName: manifest.displayName,
		version,
		permissions: manifest.permissions ?? [],
		fingerprint: extensionFingerprint({ id: manifest.id, path: root, packageSource: source }),
	};
}

/**
 * What the permissions of the package installed at `root` came to:
 * - `none`: it declares no extension, or no permissions;
 * - `acknowledged`: the user had acknowledged them, or acknowledged them now;
 * - `declined`: the user declined;
 * - `unreviewed`: nobody could be asked (`confirm` is absent), so they stay unacknowledged.
 */
export type PackagePermissionOutcome =
	| { readonly status: "none" }
	| { readonly status: "acknowledged" | "declined" | "unreviewed"; readonly subject: PackagePermissions };

/** The lines an install or update prompt shows: each permission, the ones new since the last acknowledgment marked. */
export function permissionRequestLines(subject: PackagePermissions, added: readonly ExtensionPermission[]): string[] {
	const marked = new Set(added.length < subject.permissions.length ? added : []);
	return [
		`${subject.displayName} (${subject.id} ${subject.version}) asks to:`,
		...subject.permissions.map(
			(permission) =>
				`  ${permission}: ${EXTENSION_PERMISSION_DESCRIPTIONS[permission]}${marked.has(permission) ? " (new)" : ""}`,
		),
	];
}

/**
 * Review the permissions of the package just installed or updated at `root`
 * from `source`: nothing to ask when it declares none or the user
 * acknowledged them; an update of the same package that adds none is
 * recorded without asking; otherwise `confirm` asks and the answer is
 * recorded. Throws when the package's manifest is invalid.
 */
export async function reviewPackagePermissions(options: {
	readonly store: ExtensionPermissionStore;
	readonly root: string;
	readonly source: string;
	readonly confirm?: (subject: PackagePermissions, added: readonly ExtensionPermission[]) => Promise<boolean>;
}): Promise<PackagePermissionOutcome> {
	const subject = readPackagePermissions(options.root, options.source);
	if (subject === undefined || subject.permissions.length === 0) return { status: "none" };
	const review = options.store.review(subject);
	if (review.status === "acknowledged") return { status: "acknowledged", subject };
	if (review.status === "carried") {
		options.store.acknowledge(subject);
		return { status: "acknowledged", subject };
	}
	if (options.confirm === undefined) return { status: "unreviewed", subject };
	if (!(await options.confirm(subject, review.added))) return { status: "declined", subject };
	options.store.acknowledge(subject);
	return { status: "acknowledged", subject };
}
