import { type Component, Container } from "./tui.ts";

/**
 * Minimal shape of a declarative node. The registry user defines the concrete node union (type names and
 * props); the reconciler only reads `type` and `key`. Nodes are treated as immutable: passing the same node
 * object again skips its whole subtree.
 */
export interface ViewNode {
	readonly type: string;
	readonly key?: string | undefined;
}

/** Maps one node type to a retained component. `Child` is the node union accepted as children. */
export interface ViewNodeDefinition<
	N extends ViewNode,
	C extends Component = Component,
	Child extends ViewNode = ViewNode,
> {
	/** Create the component for a node that has no retained component yet. */
	create(node: N): C;
	/** Apply a changed node to the retained component in place. Without it, a changed node recreates the component. */
	update?(component: C, node: N, previous: N): void;
	/** Child nodes to reconcile into retained child components. Requires `mount`. */
	children?(node: N): readonly Child[] | undefined;
	/** Attach the reconciled child components (in node order) after the node was created or changed. */
	mount?(component: C, children: readonly Component[], node: N): void;
	/** Release a component that leaves the tree. Defaults to calling the component's own `dispose()` if it has one. */
	dispose?(component: C): void;
}

/** The node of `N` with type `T`, or `N` itself when node types are plain strings. */
export type ViewNodeOfType<N extends ViewNode, T extends string> = string extends N["type"]
	? N
	: Extract<N, { type: T }>;

type StoredDefinition = ViewNodeDefinition<ViewNode, Component, ViewNode>;

/** Node-type registry used by {@link ViewReconciler}. Definitions can be registered or replaced at any time. */
export class ViewRegistry<N extends ViewNode = ViewNode> {
	private readonly definitions = new Map<string, StoredDefinition>();

	/** Register or replace the definition for a node type. Retained components of a replaced type are recreated. */
	register<T extends N["type"], C extends Component>(
		type: T,
		definition: ViewNodeDefinition<ViewNodeOfType<N, T>, C, N>,
	): void {
		if (definition.children && !definition.mount) {
			throw new Error(`View node type "${type}" defines children() without mount()`);
		}
		this.definitions.set(type, definition);
	}

	unregister(type: N["type"]): boolean {
		return this.definitions.delete(type);
	}

	has(type: string): boolean {
		return this.definitions.has(type);
	}

	get(type: string): StoredDefinition | undefined {
		return this.definitions.get(type);
	}
}

interface ViewInstance {
	readonly key: string;
	readonly explicitKey: string | undefined;
	readonly type: string;
	readonly definition: StoredDefinition;
	readonly component: Component;
	node: ViewNode;
	children: ViewInstance[];
}

function instanceKey(node: ViewNode, index: number): string {
	return node.key === undefined ? `#${index}` : `=${node.key}`;
}

function disposeComponent(component: Component): void {
	const disposable = component as Partial<{ dispose: unknown }>;
	if (typeof disposable.dispose === "function") disposable.dispose.call(component);
}

/**
 * Retains components for a keyed node tree. Each {@link ViewReconciler.update} matches nodes to retained
 * components by key (or position for unkeyed nodes) and type, updates matches in place, creates new nodes,
 * and disposes removed ones. Renders its root components vertically in either screen mode.
 */
export class ViewReconciler<N extends ViewNode = ViewNode> extends Container {
	private readonly registry: ViewRegistry<N>;
	private instances: ViewInstance[] = [];

	constructor(registry: ViewRegistry<N>) {
		super();
		this.registry = registry;
	}

	/** Reconcile the retained tree against new root nodes. */
	update(nodes: readonly N[]): void {
		this.instances = this.reconcileList(this.instances, nodes, "root");
		this.children = this.instances.map((instance) => instance.component);
	}

	/** The retained component at a path of explicit keys, starting at the roots. */
	getComponent(keyPath: readonly string[]): Component | undefined {
		let level = this.instances;
		let found: ViewInstance | undefined;
		for (const key of keyPath) {
			found = level.find((instance) => instance.explicitKey === key);
			if (!found) return undefined;
			level = found.children;
		}
		return found?.component;
	}

	/** Dispose every retained component. */
	dispose(): void {
		for (const instance of this.instances) this.disposeInstance(instance);
		this.instances = [];
		this.children = [];
	}

	override addChild(_component: Component): void {
		throw new Error("ViewReconciler children are managed by update()");
	}

	override removeChild(_component: Component): void {
		throw new Error("ViewReconciler children are managed by update()");
	}

	override clear(): void {
		this.dispose();
	}

	private reconcileList(previous: readonly ViewInstance[], nodes: readonly ViewNode[], path: string): ViewInstance[] {
		const planned = nodes.map((node, index) => {
			const definition = this.registry.get(node.type);
			if (!definition) throw new Error(`No view definition registered for node type "${node.type}" at ${path}`);
			return { node, definition, key: instanceKey(node, index) };
		});
		const keys = new Set<string>();
		for (const { node, key } of planned) {
			if (keys.has(key)) throw new Error(`Duplicate view node key "${node.key}" at ${path}`);
			keys.add(key);
		}

		const unmatched = new Map(previous.map((instance) => [instance.key, instance]));
		const next = planned.map(({ node, definition, key }) => {
			const existing = unmatched.get(key);
			if (!existing || existing.type !== node.type || existing.definition !== definition) {
				return this.createInstance(node, key, definition, path);
			}
			unmatched.delete(key);
			return this.updateInstance(existing, node, path);
		});
		for (const stale of unmatched.values()) this.disposeInstance(stale);
		return next;
	}

	private createInstance(node: ViewNode, key: string, definition: StoredDefinition, path: string): ViewInstance {
		const instance: ViewInstance = {
			key,
			explicitKey: node.key,
			type: node.type,
			definition,
			component: definition.create(node),
			node,
			children: [],
		};
		this.reconcileChildren(instance, path);
		return instance;
	}

	private updateInstance(instance: ViewInstance, node: ViewNode, path: string): ViewInstance {
		if (instance.node === node) return instance;
		const { definition } = instance;
		if (!definition.update) {
			this.disposeInstance(instance);
			return this.createInstance(node, instance.key, definition, path);
		}
		const previous = instance.node;
		instance.node = node;
		definition.update(instance.component, node, previous);
		this.reconcileChildren(instance, path);
		return instance;
	}

	private reconcileChildren(instance: ViewInstance, path: string): void {
		const { definition, node } = instance;
		if (!definition.mount) return;
		const childPath = `${path}/${node.type}${node.key === undefined ? "" : `[${node.key}]`}`;
		instance.children = this.reconcileList(instance.children, definition.children?.(node) ?? [], childPath);
		definition.mount(
			instance.component,
			instance.children.map((child) => child.component),
			node,
		);
	}

	private disposeInstance(instance: ViewInstance): void {
		for (const child of instance.children) this.disposeInstance(child);
		instance.children = [];
		if (instance.definition.dispose) instance.definition.dispose(instance.component);
		else disposeComponent(instance.component);
	}
}
