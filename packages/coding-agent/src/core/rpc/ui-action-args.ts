import type { UiActionArgumentDescriptor, UiActionScalar } from "./types.ts";

export function validateUiActionArgs(
	args: unknown,
	descriptors: ReadonlyArray<UiActionArgumentDescriptor> = [],
): Record<string, UiActionScalar> {
	const record = getArgsRecord(args);
	const descriptorByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
	const unknownKeys = Object.keys(record).filter((key) => !descriptorByName.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}

	const normalized: Record<string, UiActionScalar> = {};
	for (const descriptor of descriptors) {
		const value = record[descriptor.name];
		if (value === undefined) {
			if (descriptor.required === true) {
				throw new Error(`Missing required UI action argument: ${descriptor.name}`);
			}
			continue;
		}
		normalized[descriptor.name] = validateUiActionArgValue(descriptor, value);
	}
	return normalized;
}

function getArgsRecord(args: unknown): Record<string, unknown> {
	if (args === undefined) {
		return {};
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("UI action args must be an object");
	}
	return args as Record<string, unknown>;
}

function validateUiActionArgValue(descriptor: UiActionArgumentDescriptor, value: unknown): UiActionScalar {
	switch (descriptor.type) {
		case "string":
			if (typeof value !== "string") {
				throw new Error(`UI action argument "${descriptor.name}" must be a string`);
			}
			return value;
		case "boolean":
			if (typeof value !== "boolean") {
				throw new Error(`UI action argument "${descriptor.name}" must be a boolean`);
			}
			return value;
		case "enum":
			return validateEnumArgValue(descriptor, value);
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) {
				throw new Error(`UI action argument "${descriptor.name}" must be an integer`);
			}
			return value;
		default:
			throw new Error(`Unsupported UI action argument type for "${descriptor.name}": ${descriptor.type}`);
	}
}

function validateEnumArgValue(descriptor: UiActionArgumentDescriptor, value: unknown): UiActionScalar {
	if (typeof value !== "string") {
		throw new Error(`UI action argument "${descriptor.name}" must be a string`);
	}
	const allowedValues = (descriptor.options ?? []).map((option) => option.value);
	if (allowedValues.length === 0) {
		throw new Error(`UI action enum argument "${descriptor.name}" has no options`);
	}
	if (!allowedValues.includes(value)) {
		throw new Error(`UI action argument "${descriptor.name}" must be one of: ${allowedValues.join(", ")}`);
	}
	return value;
}
