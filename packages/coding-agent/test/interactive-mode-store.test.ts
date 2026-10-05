import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { StoreCatalog, StoreCatalogPackage } from "../src/store/catalog.ts";
import { testCatalog, testCatalogEntry } from "./store-catalog-fixtures.ts";

type StoreCatalogBrowserContext = {
	loadStoreCatalog: (required: boolean) => Promise<StoreCatalog | undefined>;
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	showExtensionInput: (title: string, placeholder?: string) => Promise<string | undefined>;
	showStatus: (message: string) => void;
	showStoreText: (text: string) => void;
	showStorePackageActions: (input: string, catalog: StoreCatalog) => Promise<void>;
	formatStorePackageOption: (pkg: StoreCatalogPackage, index: number) => string;
};

type InteractiveModeStorePrivate = {
	showStoreCatalogBrowser(this: StoreCatalogBrowserContext, query?: string, catalog?: StoreCatalog): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeStorePrivate;

function createCatalog(): StoreCatalog {
	return testCatalog(testCatalogEntry("rtk"));
}

function createStoreCatalogBrowserContext(catalog: StoreCatalog): StoreCatalogBrowserContext {
	return {
		loadStoreCatalog: vi.fn(async () => catalog),
		showExtensionSelector: vi.fn(async () => undefined),
		showExtensionInput: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showStoreText: vi.fn(),
		showStorePackageActions: vi.fn(async () => {}),
		formatStorePackageOption: (pkg, index) => `${index + 1}. ${pkg.id} - ${pkg.name}`,
	};
}

describe("InteractiveMode store browser", () => {
	it("lists catalog packages immediately without prompting for an initial search", async () => {
		const catalog = createCatalog();
		const context = createStoreCatalogBrowserContext(catalog);

		await interactiveModePrototype.showStoreCatalogBrowser.call(context);

		expect(context.loadStoreCatalog).toHaveBeenCalledWith(true);
		expect(context.showExtensionInput).not.toHaveBeenCalled();
		expect(context.showExtensionSelector).toHaveBeenCalledWith("Store packages", [
			"1. rtk - RTK Output Compression",
			"Search",
			"Cancel",
		]);
	});
});
