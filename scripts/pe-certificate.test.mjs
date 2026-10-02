import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readPeCertificateTable, stripPeCertificateTable } from "./pe-certificate.mjs";

const PE32 = 0x10b;
const PE32_PLUS = 0x20b;
const OPTIONAL_HEADER = 0x98;
const SIZE_OF_HEADERS = 0x200;
const CERTIFICATE_OFFSET = 0x400;

const directory = mkdtempSync(join(tmpdir(), "volt-pe-certificate-"));
after(() => rmSync(directory, { recursive: true, force: true }));
let fileCount = 0;

function securityEntry(magic) {
	return OPTIONAL_HEADER + (magic === PE32_PLUS ? 112 : 96) + 4 * 8;
}

// Builds a minimal PE image: headers, one body region, then an optional certificate table and trailing bytes.
function buildPe({ magic = PE32_PLUS, rvaCount = 16, certificate, table, trailing = 0 } = {}) {
	const headers = Buffer.alloc(SIZE_OF_HEADERS);
	headers.write("MZ", 0, "latin1");
	headers.writeUInt32LE(0x80, 0x3c);
	headers.write("PE\0\0", 0x80, "latin1");
	headers.writeUInt16LE(magic, OPTIONAL_HEADER);
	headers.writeUInt32LE(SIZE_OF_HEADERS, OPTIONAL_HEADER + 60);
	headers.writeUInt32LE(rvaCount, OPTIONAL_HEADER + (magic === PE32_PLUS ? 108 : 92));
	const entry = table ?? (certificate ? { offset: CERTIFICATE_OFFSET, size: certificate.length } : undefined);
	if (entry) {
		headers.writeUInt32LE(entry.offset, securityEntry(magic));
		headers.writeUInt32LE(entry.size, securityEntry(magic) + 4);
	}
	const body = Buffer.alloc(CERTIFICATE_OFFSET - SIZE_OF_HEADERS, 0xcc);
	return Buffer.concat([headers, body, certificate ?? Buffer.alloc(0), Buffer.alloc(trailing, 0xee)]);
}

function winCertificate(length) {
	const certificate = Buffer.alloc(length, 0xab);
	certificate.writeUInt32LE(length, 0);
	certificate.writeUInt16LE(0x0200, 4);
	certificate.writeUInt16LE(0x0002, 6);
	return certificate;
}

function writePe(bytes) {
	fileCount += 1;
	const path = join(directory, `image-${fileCount}.exe`);
	writeFileSync(path, bytes);
	return path;
}

for (const [name, magic] of [
	["PE32+", PE32_PLUS],
	["PE32", PE32],
]) {
	test(`strips a ${name} certificate table that ends at the end of the file`, () => {
		const original = buildPe({ magic, certificate: winCertificate(64) });
		assert.deepEqual(readPeCertificateTable(original), { offset: CERTIFICATE_OFFSET, size: 64 });
		const path = writePe(original);

		assert.deepEqual(stripPeCertificateTable(path), { offset: CERTIFICATE_OFFSET, size: 64 });

		const stripped = readFileSync(path);
		assert.equal(stripped.length, CERTIFICATE_OFFSET);
		assert.deepEqual(readPeCertificateTable(stripped), { offset: 0, size: 0 });
		const expected = Buffer.from(original.subarray(0, CERTIFICATE_OFFSET));
		expected.fill(0, securityEntry(magic), securityEntry(magic) + 8);
		assert.deepEqual(stripped, expected);
	});
}

test("leaves an executable without a certificate table byte-identical", () => {
	const original = buildPe();
	assert.deepEqual(readPeCertificateTable(original), { offset: 0, size: 0 });
	const path = writePe(original);

	assert.equal(stripPeCertificateTable(path), undefined);
	assert.deepEqual(readFileSync(path), original);
});

test("refuses to strip a table followed by trailing data and leaves the file unchanged", () => {
	const original = buildPe({ certificate: winCertificate(64), trailing: 16 });
	const path = writePe(original);

	assert.throws(() => stripPeCertificateTable(path), /does not end at the end of the/);
	assert.deepEqual(readFileSync(path), original);
});

test("refuses to strip a table that overlaps the PE headers", () => {
	const original = buildPe({ table: { offset: 0x40, size: CERTIFICATE_OFFSET - 0x40 } });
	const path = writePe(original);

	assert.throws(() => stripPeCertificateTable(path), /overlaps the PE headers/);
	assert.deepEqual(readFileSync(path), original);
});

test("reports a stale #510-shaped entry with an empty header and refuses to strip it", () => {
	const atEnd = buildPe({ certificate: Buffer.alloc(64) });
	assert.deepEqual(readPeCertificateTable(atEnd), { offset: CERTIFICATE_OFFSET, size: 64 });
	const atEndPath = writePe(atEnd);
	assert.throws(() => stripPeCertificateTable(atEndPath), /WIN_CERTIFICATE length 0 is invalid/);
	assert.deepEqual(readFileSync(atEndPath), atEnd);

	const midFile = buildPe({ table: { offset: SIZE_OF_HEADERS, size: 64 } });
	assert.deepEqual(readPeCertificateTable(midFile), { offset: SIZE_OF_HEADERS, size: 64 });
	const midFilePath = writePe(midFile);
	assert.throws(() => stripPeCertificateTable(midFilePath), /does not end at the end of the/);
	assert.deepEqual(readFileSync(midFilePath), midFile);
});

test("rejects input that is not a supported PE image", () => {
	assert.throws(() => readPeCertificateTable(Buffer.from("#!/bin/sh\necho volt\n")), /missing MZ signature/);

	const badSignature = buildPe();
	badSignature.write("NE", 0x80, "latin1");
	assert.throws(() => readPeCertificateTable(badSignature), /missing PE\\0\\0 signature/);

	const badMagic = buildPe();
	badMagic.writeUInt16LE(0x107, OPTIONAL_HEADER);
	assert.throws(() => readPeCertificateTable(badMagic), /Unsupported PE optional header magic 0x107/);

	assert.throws(() => readPeCertificateTable(buildPe().subarray(0, 0x90)), /truncated/);

	const elfPath = writePe(Buffer.from("\x7fELF\x02\x01\x01", "latin1"));
	assert.throws(() => stripPeCertificateTable(elfPath), /missing MZ signature/);
});

test("treats an image with fewer than five data directories as having no certificate table", () => {
	const original = buildPe({ rvaCount: 4, certificate: winCertificate(64) });
	assert.deepEqual(readPeCertificateTable(original), { offset: 0, size: 0 });
	const path = writePe(original);

	assert.equal(stripPeCertificateTable(path), undefined);
	assert.deepEqual(readFileSync(path), original);
});
