/**
 * The TUI's `/store` and `/extensions` commands: browsing the store catalog,
 * installing, updating, and removing packages in the settings files of the
 * conversation's cwd (D3), reviewing their permissions, and enabling,
 * configuring, and choosing the remote commands of the conversation's
 * extensions through its client. The conversation loads a package change as
 * it reloads, which the commands offer.
 */

import type { ExtensionState, ExtensionSummary } from "@hansjm10/volt-protocol";
import { sanitizeText } from "@hansjm10/volt-tui";
import type { ProtocolClient } from "../../client/protocol-client.ts";
import { getAgentDir } from "../../config.ts";
import {
	ExtensionPermissionStore,
	type PackagePermissionOutcome,
	permissionRequestLines,
	reviewPackagePermissions,
} from "../../core/extensions/permissions.ts";
import { type ConfiguredPackage, DefaultPackageManager } from "../../core/package-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	findCatalogPackage,
	loadDefaultStoreCatalog,
	STORE_CATALOG_SCHEMA_VERSION,
	type StoreCatalog,
	type StoreCatalogPackage,
	searchCatalogPackages,
} from "../../store/catalog.ts";
import { inspectStorePackage } from "../../store/inspector.ts";
import { buildStoreInstallPlan, type StoreInstallScope } from "../../store/install-plan.ts";
import {
	formatStoreInstallPlanTarget,
	formatStoreProgressMessage,
	formatStoreSourceSummary,
	renderCatalogSearch,
	renderStoreInstallPlan,
	renderStoreShow,
} from "../../store/render.ts";
import { resolveStoreSource } from "../../store/resolver.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	findStoreCatalogRevision,
	type StoreScopeTarget,
	storeReviewSource,
	storeUpdateTouches,
} from "../../store/targets.ts";
import { ExtensionRemoteCommandsComponent } from "./components/extension-remote-commands.ts";
import { ExtensionSettingsComponent } from "./components/extension-settings.ts";
import type { ConversationPresenter } from "./conversation-presenter.ts";

/** How `/extensions` shows an extension's state. */
const EXTENSION_STATE_LABELS: Readonly<Record<ExtensionState, string>> = {
	active: "enabled",
	disabled: "disabled",
	failed: "failed",
	activating: "enabling",
	deactivating: "disabling",
};

/** The conversation the commands act on, and where they show. */
export interface PackageCommandsHost {
	readonly presenter: ConversationPresenter;
	/** Settles once the TUI's client connected. */
	connected(): Promise<void>;
	/** The client of the conversation the TUI shows. */
	client(): ProtocolClient;
	/** The TUI's settings, which packages install into; read again when the TUI rereads its settings. */
	settings(): SettingsManager;
	/** The working directory the TUI's settings were read for. */
	cwd(): string;
	/** Reload the conversation so it loads a package change (`/reload`). */
	reload(): Promise<void>;
}

export class PackageCommands {
	private readonly host: PackageCommandsHost;
	private readonly presenter: ConversationPresenter;

	constructor(host: PackageCommandsHost) {
		this.host = host;
		this.presenter = host.presenter;
	}

	/**
	 * The package manager the TUI installs with (D3): packages are the TUI's to
	 * install, into the settings files of the conversation's cwd it reads
	 * itself; the conversation loads them as it reloads.
	 */
	private getStorePackageManager(): DefaultPackageManager {
		const packageManager = new DefaultPackageManager({
			cwd: this.host.cwd(),
			agentDir: getAgentDir(),
			settingsManager: this.host.settings(),
		});
		packageManager.setProgressCallback((event) => {
			if (event.type === "start" && event.message) {
				this.presenter.showStatus(formatStoreProgressMessage(event.source, event.message));
			}
		});
		return packageManager;
	}

	private async loadStoreCatalog(required: boolean): Promise<StoreCatalog | undefined> {
		try {
			const result = await loadDefaultStoreCatalog({ agentDir: getAgentDir() });
			for (const warning of result.warnings) {
				this.presenter.showWarning(warning);
			}
			return result.catalog;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (required) {
				this.presenter.showError(message);
				return undefined;
			}
			this.presenter.showWarning(`${message}; continuing without catalog metadata.`);
			return { schemaVersion: STORE_CATALOG_SCHEMA_VERSION, packages: [] };
		}
	}

	private formatStorePackageOption(pkg: StoreCatalogPackage, index: number): string {
		return `${index + 1}. ${pkg.id} - ${pkg.name}`;
	}

	private getStorePackageTitle(input: string, catalog: StoreCatalog): string {
		const pkg = findCatalogPackage(catalog, input);
		return pkg ? `${pkg.id} - ${pkg.name}` : input;
	}

	async handleStoreInteractiveCommand(args: string): Promise<void> {
		const parts = args.split(/\s+/).filter((part) => part.length > 0);
		const command = parts[0];
		const input = parts.slice(1).join(" ");

		if (!command) {
			await this.showStoreCatalogBrowser();
			return;
		}
		if (command === "search") {
			await this.showStoreCatalogBrowser(input);
			return;
		}
		if (command === "show") {
			if (!input) {
				this.presenter.showWarning("Usage: /store show <id|source>");
				return;
			}
			await this.showStorePackageDetails(input);
			return;
		}
		if (command === "install") {
			if (!input) {
				this.presenter.showWarning("Usage: /store install <id|source>");
				return;
			}
			await this.showStoreInstallFlow(input);
			return;
		}
		if (command === "remove") {
			if (!input) {
				this.presenter.showWarning("Usage: /store remove <id|source>");
				return;
			}
			await this.showStoreRemoveFlow(input);
			return;
		}
		if (command === "update") {
			await this.showStoreUpdateFlow(input || undefined);
			return;
		}

		await this.showStoreCatalogBrowser(args);
	}

	private async promptStoreCatalogSearch(catalog: StoreCatalog): Promise<void> {
		const value = await this.presenter.input("Store search", "Search packages");
		if (value === undefined) {
			this.presenter.showStatus("Store search cancelled");
			return;
		}
		await this.showStoreCatalogBrowser(value.trim(), catalog);
	}

	private async showStoreCatalogBrowser(query = "", catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(true));
		if (!storeCatalog) {
			return;
		}

		const matches = searchCatalogPackages(storeCatalog, query).slice(0, 50);
		if (matches.length === 0) {
			this.presenter.showText(renderCatalogSearch(matches, query));
			return;
		}

		const labels = new Map<string, StoreCatalogPackage>();
		const options = matches.map((pkg, index) => {
			const label = this.formatStorePackageOption(pkg, index);
			labels.set(label, pkg);
			return label;
		});
		const searchLabel = query.trim() ? "Search again" : "Search";
		options.push(searchLabel, "Cancel");

		const selection = await this.presenter.select("Store packages", options);
		if (!selection || selection === "Cancel") {
			return;
		}
		if (selection === searchLabel) {
			await this.promptStoreCatalogSearch(storeCatalog);
			return;
		}

		const pkg = labels.get(selection);
		if (pkg) {
			await this.showStorePackageActions(pkg.id, storeCatalog);
		}
	}

	private async showStorePackageActions(input: string, catalog: StoreCatalog): Promise<void> {
		const title = this.getStorePackageTitle(input, catalog);
		const action = await this.presenter.select(`Store: ${title}`, [
			"Show details",
			"Install for user",
			"Install for project",
			"Remove",
			"Update",
			"Back",
		]);
		if (!action || action === "Back") {
			return;
		}
		if (action === "Show details") {
			await this.showStorePackageDetails(input, catalog);
			await this.showStorePackageActions(input, catalog);
			return;
		}
		if (action === "Install for user") {
			await this.showStoreInstallFlow(input, "user", catalog);
			return;
		}
		if (action === "Install for project") {
			await this.showStoreInstallFlow(input, "project", catalog);
			return;
		}
		if (action === "Remove") {
			await this.showStoreRemoveFlow(input, undefined, catalog);
			return;
		}
		if (action === "Update") {
			await this.showStoreUpdateFlow(input, catalog);
		}
	}

	private async showStorePackageDetails(input: string, catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			this.presenter.showStatus(`Inspecting ${input}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: false });
			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.host.cwd(),
				npmCommand: this.host.settings().getNpmCommand(),
			});
			this.presenter.showText(renderStoreShow(resolved, inspection));
		} catch (error: unknown) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreInstallFlow(
		input: string,
		scope: StoreInstallScope = "user",
		catalog?: StoreCatalog,
	): Promise<void> {
		if (scope === "project" && !this.host.settings().isProjectTrusted()) {
			this.presenter.showWarning(
				"Project is not trusted. Use /trust, then restart volt before installing project packages.",
			);
			return;
		}

		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			this.presenter.showStatus(`Preparing store install for ${formatStoreSourceSummary(input)}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: true });
			const packageManager = this.getStorePackageManager();
			const catalogId = resolved.catalogPackage?.id;
			const installed =
				catalogId === undefined
					? undefined
					: findStoreCatalogRevision(packageManager, resolved.source, catalogId, scope);
			if (installed !== undefined) {
				this.presenter.showWarning(
					`${catalogId} is installed from ${formatStoreSourceSummary(installed.source)}; update it with /store update ${catalogId}`,
				);
				return;
			}
			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.host.cwd(),
				npmCommand: this.host.settings().getNpmCommand(),
			});
			const plan = buildStoreInstallPlan({
				resolved,
				inspection,
				scope,
				scriptPolicy: "never",
			});
			const targetLabel = formatStoreInstallPlanTarget(plan);
			this.presenter.showText(renderStoreInstallPlan(plan));

			const confirmed = await this.presenter.confirm(
				"Store install",
				`Install ${targetLabel} to ${scope} scope? Package lifecycle scripts will be disabled.`,
			);
			if (!confirmed) {
				this.presenter.showStatus("Store install cancelled");
				return;
			}

			await packageManager.installAndPersist(plan.source, {
				local: scope === "project",
				scripts: "never",
			});
			await this.host.settings().flush();
			if (this.reportStoreSettingsErrors(packageManager, plan.source, scope)) {
				return;
			}
			if (
				!(await this.confirmPackagePermissions(
					packageManager,
					// A local package is found where it was installed from.
					storeReviewSource(plan.source, this.host.cwd()),
					scope,
					"Declining removes the package.",
					{ installed: true },
				))
			) {
				await packageManager.removeAndPersist(plan.source, { local: scope === "project" });
				await this.host.settings().flush();
				this.reportStoreSettingsErrors(packageManager, plan.source, scope);
				this.presenter.showStatus(`Removed ${targetLabel}: its permissions were not acknowledged`);
				return;
			}
			await this.offerStoreReload(`Installed ${targetLabel}`);
		} catch (error: unknown) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreRemoveFlow(input: string, local?: boolean, catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: false });
			const packageManager = this.getStorePackageManager();
			const selection = chooseStoreRemoveTarget(
				packageManager,
				resolved.source,
				local ?? false,
				resolved.catalogPackage?.id,
			);
			if (selection.conflict === "both-scopes") {
				this.presenter.showWarning(
					"Package is installed in both user and project scopes. Use /extensions to pick one.",
				);
				return;
			}
			if (selection.conflict === "several-refs") {
				this.presenter.showWarning(`${input} is installed at several refs. Name the ref to remove.`);
				return;
			}
			if (!selection.target) {
				this.presenter.showWarning(`No matching package found for ${input}`);
				return;
			}
			await this.removeInstalledStorePackage(
				packageManager,
				selection.target,
				selection.target.actionSource ?? selection.target.source,
			);
		} catch (error: unknown) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreUpdateFlow(input?: string, catalog?: StoreCatalog): Promise<void> {
		const packageManager = this.getStorePackageManager();
		if (!input) {
			const confirmed = await this.presenter.confirm("Store update", "Update all installed packages?");
			if (!confirmed) {
				this.presenter.showStatus("Store update cancelled");
				return;
			}
			try {
				await packageManager.update(undefined, { scripts: "never" });
				await this.reviewUpdatedPackages(packageManager);
				await this.offerStoreReload("Updated packages");
			} catch (error: unknown) {
				this.presenter.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		const catalogPackage = findCatalogPackage(storeCatalog, input);
		if (!catalogPackage) {
			const inputLabel = formatStoreSourceSummary(input);
			const confirmed = await this.presenter.confirm("Store update", `Update ${inputLabel}?`);
			if (!confirmed) {
				this.presenter.showStatus("Store update cancelled");
				return;
			}
			try {
				await packageManager.update(input, { scripts: "never" });
				await this.reviewUpdatedPackages(packageManager, input);
				await this.offerStoreReload(`Updated ${inputLabel}`);
			} catch (error: unknown) {
				this.presenter.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		try {
			this.presenter.showStatus(`Preparing store update for ${input}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: true });
			const selection = chooseStoreUpdateTarget(packageManager, resolved.source, false, catalogPackage.id);
			if (selection.conflict === "both-scopes") {
				this.presenter.showWarning(
					"Package is installed in both user and project scopes. Use /extensions to pick one.",
				);
				return;
			}
			if (!selection.target) {
				this.presenter.showWarning(`No matching installed package found for catalog ID ${input}`);
				return;
			}
			// Already the catalog pin: update it in place.
			if (storeUpdateTouches(packageManager, selection.target, resolved.source)) {
				const targetLabel = formatStoreSourceSummary(selection.target.source);
				const confirmed = await this.presenter.confirm("Store update", `Update ${targetLabel}?`);
				if (!confirmed) {
					this.presenter.showStatus("Store update cancelled");
					return;
				}
				const updateSource = selection.target.actionSource ?? selection.target.source;
				await packageManager.update(updateSource, {
					local: selection.target.scope === "project",
					scripts: "never",
				});
				await this.reviewUpdatedPackages(packageManager, updateSource);
				await this.offerStoreReload(`Updated ${targetLabel}`);
				return;
			}

			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.host.cwd(),
				npmCommand: this.host.settings().getNpmCommand(),
			});
			const plan = buildStoreInstallPlan({
				resolved,
				inspection,
				scope: selection.target.scope,
				scriptPolicy: "never",
			});
			const currentLabel = formatStoreSourceSummary(selection.target.source);
			const targetLabel = formatStoreInstallPlanTarget(plan);
			this.presenter.showText(renderStoreInstallPlan(plan));
			const confirmed = await this.presenter.confirm(
				"Store update",
				`Update ${currentLabel} to ${targetLabel}? Package lifecycle scripts will be disabled.`,
			);
			if (!confirmed) {
				this.presenter.showStatus("Store update cancelled");
				return;
			}
			const target = selection.target;
			const local = target.scope === "project";
			// The new pin installs beside the installed one, which stays configured until the new pin is acknowledged.
			await packageManager.install(plan.source, { local, scripts: "never" });
			if (
				!(await this.confirmPackagePermissions(
					packageManager,
					plan.source,
					target.scope,
					`Declining keeps ${currentLabel}.`,
					{ installed: true },
				))
			) {
				// The new pin was never configured: dropping its checkout leaves the installed pin as it was.
				await packageManager.removeAndPersist(plan.source, { local });
				this.presenter.showStatus(`Kept ${currentLabel}: the update's permissions were not acknowledged`);
				return;
			}
			// The new pin takes over the installed one's settings entry, and the installed pin's checkout goes.
			packageManager.addSourceToSettings(plan.source, { local, scripts: "never", replace: target.source });
			await packageManager.removeAndPersist(target.actionSource ?? target.source, { local });
			await this.host.settings().flush();
			if (this.reportStoreSettingsErrors(packageManager, plan.source, target.scope)) {
				return;
			}
			await this.offerStoreReload(`Updated ${currentLabel} to ${targetLabel}`);
		} catch (error: unknown) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * `/extensions`: the conversation's extensions with their state, each
	 * opening its actions (enable or disable, detail and settings, remote commands);
	 * `/extensions <id>` opens one's detail; `/extensions enable|disable <id>`
	 * toggles one.
	 */
	async handleExtensionsInteractiveCommand(args: string): Promise<void> {
		const [verb, id, ...rest] = args.split(/\s+/).filter((part) => part.length > 0);
		if (verb === "enable" || verb === "disable") {
			if (id === undefined || rest.length > 0) {
				this.presenter.showWarning(`Usage: /extensions ${verb} <id>`);
				return;
			}
			await this.setExtensionEnabled(id, verb === "enable");
			return;
		}
		if (verb !== undefined) {
			await this.showExtensionDetail(args.trim());
			return;
		}
		let summaries: ExtensionSummary[];
		try {
			await this.host.connected();
			summaries = (await this.host.client().query("extensions")).extensions;
		} catch (error) {
			this.presenter.showError(
				`Could not list extensions: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const labels = new Map<string, ExtensionSummary>();
		const options = summaries.map((summary) => {
			const unacknowledged =
				summary.permissions.length > 0 && !summary.permissionsAcknowledged ? " · permissions not acknowledged" : "";
			const label = `${summary.displayName} (${summary.id}) · ${EXTENSION_STATE_LABELS[summary.state]}${summary.hasSettings ? " · settings" : ""}${unacknowledged}`;
			labels.set(label, summary);
			return label;
		});
		const packagesLabel = "Installed packages";
		options.push(packagesLabel, "Cancel");
		const selection = await this.presenter.select("Extensions", options);
		if (!selection || selection === "Cancel") return;
		if (selection === packagesLabel) {
			await this.showInstalledPackages();
			return;
		}
		const selected = labels.get(selection);
		if (selected !== undefined) await this.showExtensionActions(selected);
	}

	/**
	 * What to do with one extension: enable or disable it, open its detail and
	 * settings, or, while it runs, choose which of its commands paired devices may run.
	 */
	private async showExtensionActions(summary: ExtensionSummary): Promise<void> {
		const toggle = summary.enabled ? "Disable" : "Enable";
		const detailLabel = summary.hasSettings ? "Details and settings" : "Details";
		const remoteLabel = "Remote commands";
		const selection = await this.presenter.select(`${summary.displayName} (${summary.id})`, [
			toggle,
			detailLabel,
			...(summary.state === "active" ? [remoteLabel] : []),
			"Cancel",
		]);
		if (selection === toggle) await this.setExtensionEnabled(summary.id, !summary.enabled);
		else if (selection === detailLabel) await this.showExtensionDetail(summary.id);
		else if (selection === remoteLabel) this.showExtensionRemoteCommands(summary);
	}

	/** Which of a running extension's commands paired devices may run, read and saved through the host. */
	private showExtensionRemoteCommands(summary: ExtensionSummary): void {
		const client = this.host.client();
		const id = summary.id;
		this.presenter.showSelector((done) => {
			const component = new ExtensionRemoteCommandsComponent(
				summary,
				{
					load: async () => (await client.query("extension_remote_commands", { id })).commands,
					save: async (commands) => {
						await client.intent("set_extension_remote_commands", { id, commands: [...commands] });
					},
				},
				{ onClose: done, requestRender: () => this.presenter.requestRender() },
			);
			void component.start();
			return { component, focus: component };
		});
	}

	/**
	 * Enable or disable the extension `id` through the host's intent, in the
	 * scope that decides it: a trusted project's when it stores the choice,
	 * else the user's global settings. Enabling asks to acknowledge permissions
	 * not acknowledged yet.
	 */
	private async setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
		const settings = this.host.settings();
		// The host or another client may have stored the choice since the TUI read its settings.
		await settings.reload();
		const scope =
			settings.isProjectTrusted() && settings.getStoredExtensionEnabled(id, "project") !== undefined
				? "project"
				: "global";
		let state: ExtensionState | undefined;
		try {
			await this.host.connected();
			const client = this.host.client();
			await client.intent("set_extension_enabled", { id, enabled, scope });
			state = (await client.query("extensions")).extensions.find((extension) => extension.id === id)?.state;
		} catch (error) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (enabled) {
			if (state === "active") this.presenter.showStatus(`Enabled ${id}`);
			else this.presenter.showWarning(`${id} did not start (${state ?? "unknown"}); see its error in /extensions`);
		} else if (state === "active") {
			this.presenter.showWarning(`${id} stays enabled: another settings scope enables it`);
		} else {
			this.presenter.showStatus(
				state === "deactivating" ? `Disabled ${id}; its tools leave once the current turn ends` : `Disabled ${id}`,
			);
		}
	}

	/** An extension's detail and settings form, reading and saving through the host's query and intent. */
	private async showExtensionDetail(id: string): Promise<void> {
		let detail: ExtensionSummary | undefined;
		try {
			await this.host.connected();
			detail = (await this.host.client().query("extensions")).extensions.find((extension) => extension.id === id);
		} catch (error) {
			this.presenter.showError(
				`Could not list extensions: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (!detail) {
			this.presenter.showWarning(`No extension "${id}" in this conversation`);
			return;
		}
		const client = this.host.client();
		this.presenter.showSelector((done) => {
			const component = new ExtensionSettingsComponent(
				detail,
				{
					load: () => client.query("extension_settings", { id }),
					save: async (scope, values) => {
						await client.intent("set_extension_settings", { id, scope, values });
					},
				},
				{ onClose: done, requestRender: () => this.presenter.requestRender() },
			);
			void component.start();
			return { component, focus: component };
		});
	}

	/**
	 * Ask the user to acknowledge the permissions of the package just installed
	 * or updated from `source` in `scope`, unless they already did (an update
	 * that adds none is recorded without asking). True unless the user declined,
	 * or the package was just `installed` and cannot be found.
	 */
	private async confirmPackagePermissions(
		packageManager: DefaultPackageManager,
		source: string,
		scope: StoreInstallScope,
		consequence: string,
		options: { installed?: boolean } = {},
	): Promise<boolean> {
		const root = packageManager.getInstalledPath(source, scope);
		if (root === undefined) {
			// A package just installed that cannot be found cannot be reviewed: it must not stay to run unreviewed.
			if (options.installed)
				this.presenter.showWarning("Could not find the installed package to review its permissions");
			return options.installed !== true;
		}
		let outcome: PackagePermissionOutcome;
		try {
			outcome = await reviewPackagePermissions({
				store: new ExtensionPermissionStore(getAgentDir()),
				root,
				source,
				confirm: (subject, added) =>
					this.presenter.confirm(
						"Extension permissions",
						[...permissionRequestLines(subject, added), "", `Acknowledge these permissions? ${consequence}`].join(
							"\n",
						),
					),
			});
		} catch (error: unknown) {
			// The message can carry text from the package: show it inert, and treat it as declined.
			this.presenter.showWarning(
				`Could not review the package's permissions: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
			);
			return false;
		}
		return outcome.status !== "declined";
	}

	/** After an update, review the permissions of the configured packages it updated (`source`, by identity, or all). */
	private async reviewUpdatedPackages(packageManager: DefaultPackageManager, source?: string): Promise<void> {
		for (const pkg of packageManager.listConfiguredPackages()) {
			if (source !== undefined && !storeUpdateTouches(packageManager, pkg, source)) continue;
			const acknowledged = await this.confirmPackagePermissions(
				packageManager,
				pkg.source,
				pkg.scope,
				"Declining leaves it installed with its permissions unacknowledged.",
			);
			if (!acknowledged) {
				this.presenter.showWarning(
					`${formatStoreSourceSummary(pkg.source)} asks for permissions you did not acknowledge; remove it with /store remove`,
				);
			}
		}
	}

	private async showInstalledPackages(): Promise<void> {
		const packageManager = this.getStorePackageManager();
		const packages = packageManager.listConfiguredPackages();
		if (packages.length === 0) {
			this.presenter.showStatus("No packages installed");
			return;
		}

		const labels = new Map<string, ConfiguredPackage>();
		const options = packages.map((pkg, index) => {
			const filtered = pkg.filtered ? " filtered" : "";
			const label = `${index + 1}. ${pkg.scope} - ${formatStoreSourceSummary(pkg.source)}${filtered}`;
			labels.set(label, pkg);
			return label;
		});
		options.push("Update all", "Cancel");

		const selection = await this.presenter.select("Installed packages", options);
		if (!selection || selection === "Cancel") {
			return;
		}
		if (selection === "Update all") {
			await this.showStoreUpdateFlow();
			return;
		}

		const pkg = labels.get(selection);
		if (pkg) {
			await this.showInstalledStorePackageActions(packageManager, pkg);
		}
	}

	private async showInstalledStorePackageActions(
		packageManager: DefaultPackageManager,
		pkg: ConfiguredPackage,
	): Promise<void> {
		const sourceLabel = formatStoreSourceSummary(pkg.source);
		const action = await this.presenter.select(`${pkg.scope}: ${sourceLabel}`, [
			"Show details",
			"Update",
			"Remove",
			"Back",
		]);
		if (!action || action === "Back") {
			return;
		}
		if (action === "Show details") {
			this.presenter.showText(
				[
					"Installed package",
					`Source: ${sourceLabel}`,
					`Scope: ${pkg.scope}`,
					`Filtered: ${pkg.filtered ? "yes" : "no"}`,
					`Installed path: ${pkg.installedPath ?? "not installed"}`,
				].join("\n"),
			);
			await this.showInstalledStorePackageActions(packageManager, pkg);
			return;
		}
		if (action === "Update") {
			await this.updateInstalledStorePackage(packageManager, pkg);
			return;
		}
		if (action === "Remove") {
			await this.removeInstalledStorePackage(
				packageManager,
				{ source: pkg.source, scope: pkg.scope },
				pkg.actionSource,
			);
		}
	}

	private async updateInstalledStorePackage(
		packageManager: DefaultPackageManager,
		pkg: ConfiguredPackage,
	): Promise<void> {
		const sourceLabel = formatStoreSourceSummary(pkg.source);
		const confirmed = await this.presenter.confirm("Store update", `Update ${sourceLabel}?`);
		if (!confirmed) {
			this.presenter.showStatus("Store update cancelled");
			return;
		}
		try {
			await packageManager.update(pkg.actionSource, { local: pkg.scope === "project", scripts: "never" });
			await this.reviewUpdatedPackages(packageManager, pkg.actionSource);
			await this.offerStoreReload(`Updated ${sourceLabel}`);
		} catch (error: unknown) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async removeInstalledStorePackage(
		packageManager: DefaultPackageManager,
		target: StoreScopeTarget,
		removeSource = target.source,
	): Promise<void> {
		if (target.scope === "project" && !this.host.settings().isProjectTrusted()) {
			this.presenter.showWarning(
				"Project is not trusted. Use /trust, then restart volt before removing project packages.",
			);
			return;
		}
		const targetLabel = formatStoreSourceSummary(target.source);
		const confirmed = await this.presenter.confirm(
			"Store remove",
			`Remove ${targetLabel} from ${target.scope} scope?`,
		);
		if (!confirmed) {
			this.presenter.showStatus("Store remove cancelled");
			return;
		}
		try {
			const removed = await packageManager.removeAndPersist(removeSource, {
				local: target.scope === "project",
			});
			await this.host.settings().flush();
			if (this.reportStoreSettingsErrors(packageManager, removeSource, target.scope)) {
				return;
			}
			if (!removed) {
				this.presenter.showWarning(`No matching package found for ${targetLabel}`);
				return;
			}
			await this.offerStoreReload(`Removed ${targetLabel}`);
		} catch (error: unknown) {
			this.presenter.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private reportStoreSettingsErrors(
		packageManager: DefaultPackageManager,
		source: string,
		scope: StoreInstallScope,
	): boolean {
		const settingsErrors = this.host.settings().drainErrors();
		if (settingsErrors.length === 0) {
			return false;
		}
		const installedPath = packageManager.getInstalledPath(source, scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			this.presenter.showWarning(`${errorScope} settings: ${error.message}`);
		}
		if (installedPath) {
			this.presenter.showWarning(`Package was installed at ${installedPath}, but settings persistence failed.`);
		}
		return true;
	}

	/**
	 * After a package install, update, or removal: the conversation loads the
	 * change as it reloads (`/reload`), which the user may leave for later.
	 */
	private async offerStoreReload(message: string): Promise<void> {
		const action = await this.presenter.select(`${message}. Reload to load the change?`, ["Reload now", "Later"]);
		if (action === "Reload now") {
			await this.host.reload();
			return;
		}
		this.presenter.showStatus(`${message}. Run /reload to load the change.`);
	}
}
