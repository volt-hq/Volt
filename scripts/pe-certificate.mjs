// Reads and removes the Authenticode certificate table of a PE (Windows) executable.
//
// The certificate table is referenced by data directory 4 (IMAGE_DIRECTORY_ENTRY_SECURITY), whose
// "address" is a file offset rather than an RVA. Authenticode places the table at the end of the
// file, so removing it means zeroing the directory entry and truncating the file at that offset.
// Standalone builds copy the signed official node.exe, so the inherited table must be removed
// before the SEA blob is injected (volt-hq/Volt#510).

import { readFileSync, writeFileSync } from "node:fs";

const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const SECURITY_DIRECTORY_INDEX = 4;
const WIN_CERTIFICATE_HEADER_SIZE = 8;

function readUInt32(bytes, position, field) {
	if (position + 4 > bytes.length) throw new Error(`PE file is truncated before ${field}`);
	return bytes.readUInt32LE(position);
}

function readUInt16(bytes, position, field) {
	if (position + 2 > bytes.length) throw new Error(`PE file is truncated before ${field}`);
	return bytes.readUInt16LE(position);
}

function locateSecurityDirectory(bytes) {
	if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
		throw new Error("Not a PE file: missing MZ signature");
	}
	const peHeader = readUInt32(bytes, 0x3c, "e_lfanew");
	if (readUInt32(bytes, peHeader, "the PE signature") !== 0x00004550) {
		throw new Error("Not a PE file: missing PE\\0\\0 signature");
	}
	const optionalHeader = peHeader + 24;
	const magic = readUInt16(bytes, optionalHeader, "the optional header magic");
	if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) {
		throw new Error(`Unsupported PE optional header magic 0x${magic.toString(16)}`);
	}
	const sizeOfHeaders = readUInt32(bytes, optionalHeader + 60, "SizeOfHeaders");
	const numberOfRvaAndSizes = readUInt32(
		bytes,
		optionalHeader + (magic === PE32_PLUS_MAGIC ? 108 : 92),
		"NumberOfRvaAndSizes",
	);
	if (numberOfRvaAndSizes <= SECURITY_DIRECTORY_INDEX) return { entry: undefined, sizeOfHeaders };
	const entry = optionalHeader + (magic === PE32_PLUS_MAGIC ? 112 : 96) + SECURITY_DIRECTORY_INDEX * 8;
	readUInt32(bytes, entry + 4, "the security data directory");
	return { entry, sizeOfHeaders };
}

/**
 * Returns the certificate table's file offset and size from the PE security data directory.
 * A size of 0 means the executable has no certificate table.
 */
export function readPeCertificateTable(bytes) {
	const { entry } = locateSecurityDirectory(bytes);
	if (entry === undefined) return { offset: 0, size: 0 };
	return { offset: bytes.readUInt32LE(entry), size: bytes.readUInt32LE(entry + 4) };
}

/**
 * Removes the certificate table from the PE file at `path` in place. Returns the removed
 * `{ offset, size }`, or undefined when the file has no certificate table. Throws without
 * modifying the file unless the table is a non-empty WIN_CERTIFICATE block that ends exactly
 * at the end of the file.
 */
export function stripPeCertificateTable(path) {
	const bytes = readFileSync(path);
	const { entry, sizeOfHeaders } = locateSecurityDirectory(bytes);
	if (entry === undefined) return undefined;
	const offset = bytes.readUInt32LE(entry);
	const size = bytes.readUInt32LE(entry + 4);
	if (size === 0) return undefined;
	const describe = `certificate table (${size} bytes at offset ${offset}) in ${path}`;
	if (offset < sizeOfHeaders || offset < entry + 8) {
		throw new Error(`Refusing to strip ${describe}: it overlaps the PE headers`);
	}
	if (offset + size !== bytes.length) {
		throw new Error(`Refusing to strip ${describe}: it does not end at the end of the ${bytes.length}-byte file`);
	}
	if (size < WIN_CERTIFICATE_HEADER_SIZE) {
		throw new Error(`Refusing to strip ${describe}: it is smaller than a WIN_CERTIFICATE header`);
	}
	const certificateLength = bytes.readUInt32LE(offset);
	if (certificateLength === 0 || certificateLength > size) {
		throw new Error(`Refusing to strip ${describe}: WIN_CERTIFICATE length ${certificateLength} is invalid`);
	}
	const stripped = Buffer.from(bytes.subarray(0, offset));
	stripped.fill(0, entry, entry + 8);
	writeFileSync(path, stripped);
	return { offset, size };
}
