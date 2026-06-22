import { Buffer } from "node:buffer";

const MIN_QR_VERSION = 1;
const MAX_QR_VERSION = 40;
const BYTE_MODE_INDICATOR = 0b0100;
const MEDIUM_ERROR_CORRECTION_INDEX = 1;
const MEDIUM_ERROR_CORRECTION_FORMAT_BITS = 0b00;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;
const BLACK_FOREGROUND = "\x1b[38;2;0;0;0m";
const WHITE_FOREGROUND = "\x1b[38;2;255;255;255m";
const BLACK_BACKGROUND = "\x1b[48;2;0;0;0m";
const WHITE_BACKGROUND = "\x1b[48;2;255;255;255m";
const ANSI_RESET = "\x1b[0m";

const ECC_CODEWORDS_PER_BLOCK = [
	[-1, -1, -1, -1],
	[7, 10, 13, 17],
	[10, 16, 22, 28],
	[15, 26, 18, 22],
	[20, 18, 26, 16],
	[26, 24, 18, 22],
	[18, 16, 24, 28],
	[20, 18, 18, 26],
	[24, 22, 22, 26],
	[30, 22, 20, 24],
	[18, 26, 24, 28],
	[20, 30, 28, 24],
	[24, 22, 26, 28],
	[26, 22, 24, 22],
	[30, 24, 20, 24],
	[22, 24, 30, 24],
	[24, 28, 24, 30],
	[28, 28, 28, 28],
	[30, 26, 28, 28],
	[28, 26, 26, 26],
	[28, 26, 30, 28],
	[28, 26, 28, 30],
	[28, 28, 30, 24],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[26, 28, 30, 30],
	[28, 28, 28, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
	[30, 28, 30, 30],
] as const;

const NUM_ERROR_CORRECTION_BLOCKS = [
	[-1, -1, -1, -1],
	[1, 1, 1, 1],
	[1, 1, 1, 1],
	[1, 1, 2, 2],
	[1, 2, 2, 4],
	[1, 2, 4, 4],
	[2, 4, 4, 4],
	[2, 4, 6, 5],
	[2, 4, 6, 6],
	[2, 5, 8, 8],
	[4, 5, 8, 8],
	[4, 5, 8, 11],
	[4, 8, 10, 11],
	[4, 9, 12, 16],
	[4, 9, 16, 16],
	[6, 10, 12, 18],
	[6, 10, 17, 16],
	[6, 11, 16, 19],
	[6, 13, 18, 21],
	[7, 14, 21, 25],
	[8, 16, 20, 25],
	[8, 17, 23, 25],
	[9, 17, 23, 34],
	[9, 18, 25, 30],
	[10, 20, 27, 32],
	[12, 21, 29, 35],
	[12, 23, 34, 37],
	[12, 25, 34, 40],
	[13, 26, 35, 42],
	[14, 28, 38, 45],
	[15, 29, 40, 48],
	[16, 31, 43, 51],
	[17, 33, 45, 54],
	[18, 35, 48, 57],
	[19, 37, 51, 60],
	[19, 38, 53, 63],
	[20, 40, 56, 66],
	[21, 43, 59, 70],
	[22, 45, 62, 74],
	[24, 47, 65, 77],
	[25, 49, 68, 81],
] as const;

export interface IrohRemoteTicketQrCode {
	modules: boolean[][];
	size: number;
	version: number;
}

export interface IrohRemoteTicketQrCodeFormatOptions {
	margin?: number;
}

interface QrBuildState {
	isFunction: boolean[][];
	modules: boolean[][];
	size: number;
	version: number;
}

export function createIrohRemoteTicketQrCode(ticket: string): IrohRemoteTicketQrCode {
	const data = Array.from(Buffer.from(ticket, "utf8"));
	const version = selectQrVersion(data.length);
	const state = createQrBuildState(version);
	drawFunctionPatterns(state);
	addCodewords(state, createAllCodewords(data, version));
	applyBestMask(state);
	return {
		modules: state.modules.map((row) => [...row]),
		size: state.size,
		version,
	};
}

export function formatIrohRemoteTicketQrCode(
	ticket: string,
	options: IrohRemoteTicketQrCodeFormatOptions = {},
): string {
	return formatQrCode(createIrohRemoteTicketQrCode(ticket), options);
}

function selectQrVersion(dataByteLength: number): number {
	for (let version = MIN_QR_VERSION; version <= MAX_QR_VERSION; version++) {
		const byteModeBitLength = 4 + getByteModeCharCountBits(version) + dataByteLength * 8;
		if (byteModeBitLength <= getNumDataCodewords(version) * 8) return version;
	}
	throw new Error("Iroh remote ticket is too large to encode as a QR code");
}

function getByteModeCharCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

function createQrBuildState(version: number): QrBuildState {
	const size = getQrSize(version);
	return {
		isFunction: Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
		modules: Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
		size,
		version,
	};
}

function getQrSize(version: number): number {
	return version * 4 + 17;
}

function getNumRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function getNumRawDataCodewords(version: number): number {
	return Math.floor(getNumRawDataModules(version) / 8);
}

function getNumDataCodewords(version: number): number {
	const blockEccLen = getEccCodewordsPerBlock(version);
	const numBlocks = getNumErrorCorrectionBlocks(version);
	return getNumRawDataCodewords(version) - blockEccLen * numBlocks;
}

function getEccCodewordsPerBlock(version: number): number {
	const row = ECC_CODEWORDS_PER_BLOCK[version];
	if (!row) throw new Error(`Unsupported QR version: ${version}`);
	return row[MEDIUM_ERROR_CORRECTION_INDEX];
}

function getNumErrorCorrectionBlocks(version: number): number {
	const row = NUM_ERROR_CORRECTION_BLOCKS[version];
	if (!row) throw new Error(`Unsupported QR version: ${version}`);
	return row[MEDIUM_ERROR_CORRECTION_INDEX];
}

function drawFunctionPatterns(state: QrBuildState): void {
	drawFinderPattern(state, 3, 3);
	drawFinderPattern(state, state.size - 4, 3);
	drawFinderPattern(state, 3, state.size - 4);
	drawAlignmentPatterns(state);
	drawTimingPatterns(state);
	drawFormatBits(state, 0);
	drawVersionBits(state);
}

function setFunctionModule(state: QrBuildState, x: number, y: number, isBlack: boolean): void {
	state.modules[y][x] = isBlack;
	state.isFunction[y][x] = true;
}

function drawFinderPattern(state: QrBuildState, centerX: number, centerY: number): void {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const x = centerX + dx;
			const y = centerY + dy;
			if (x < 0 || y < 0 || x >= state.size || y >= state.size) continue;
			const distance = Math.max(Math.abs(dx), Math.abs(dy));
			setFunctionModule(state, x, y, distance !== 2 && distance !== 4);
		}
	}
}

function drawAlignmentPatterns(state: QrBuildState): void {
	const positions = getAlignmentPatternPositions(state.version);
	for (const y of positions) {
		for (const x of positions) {
			if (state.isFunction[y][x]) continue;
			drawAlignmentPattern(state, x, y);
		}
	}
}

function drawAlignmentPattern(state: QrBuildState, centerX: number, centerY: number): void {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			const distance = Math.max(Math.abs(dx), Math.abs(dy));
			setFunctionModule(state, centerX + dx, centerY + dy, distance !== 1);
		}
	}
}

function getAlignmentPatternPositions(version: number): number[] {
	if (version === 1) return [];
	const size = getQrSize(version);
	const numAlign = Math.floor(version / 7) + 2;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let position = size - 7; result.length < numAlign; position -= step) {
		result.splice(1, 0, position);
	}
	return result;
}

function drawTimingPatterns(state: QrBuildState): void {
	for (let index = 0; index < state.size; index++) {
		const isBlack = index % 2 === 0;
		if (!state.isFunction[6][index]) setFunctionModule(state, index, 6, isBlack);
		if (!state.isFunction[index][6]) setFunctionModule(state, 6, index, isBlack);
	}
}

function drawFormatBits(state: QrBuildState, mask: number): void {
	const data = (MEDIUM_ERROR_CORRECTION_FORMAT_BITS << 3) | mask;
	let remainder = data;
	for (let index = 0; index < 10; index++) {
		remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
	}
	const bits = ((data << 10) | remainder) ^ 0x5412;

	for (let index = 0; index <= 5; index++) setFunctionModule(state, 8, index, getBit(bits, index));
	setFunctionModule(state, 8, 7, getBit(bits, 6));
	setFunctionModule(state, 8, 8, getBit(bits, 7));
	setFunctionModule(state, 7, 8, getBit(bits, 8));
	for (let index = 9; index < 15; index++) setFunctionModule(state, 14 - index, 8, getBit(bits, index));

	for (let index = 0; index < 8; index++) setFunctionModule(state, state.size - 1 - index, 8, getBit(bits, index));
	for (let index = 8; index < 15; index++) {
		setFunctionModule(state, 8, state.size - 15 + index, getBit(bits, index));
	}
	setFunctionModule(state, 8, state.size - 8, true);
}

function drawVersionBits(state: QrBuildState): void {
	if (state.version < 7) return;
	let remainder = state.version;
	for (let index = 0; index < 12; index++) {
		remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
	}
	const bits = (state.version << 12) | remainder;
	for (let index = 0; index < 18; index++) {
		const bit = getBit(bits, index);
		const x = state.size - 11 + (index % 3);
		const y = Math.floor(index / 3);
		setFunctionModule(state, x, y, bit);
		setFunctionModule(state, y, x, bit);
	}
}

function getBit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0;
}

function createAllCodewords(data: readonly number[], version: number): number[] {
	const dataCodewords = createDataCodewords(data, version);
	const blockEccLen = getEccCodewordsPerBlock(version);
	const numBlocks = getNumErrorCorrectionBlocks(version);
	const rawCodewords = getNumRawDataCodewords(version);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);
	const shortBlockDataLen = shortBlockLen - blockEccLen;
	const rsDivisor = reedSolomonComputeDivisor(blockEccLen);
	const blocks: number[][] = [];
	let offset = 0;

	for (let blockIndex = 0; blockIndex < numBlocks; blockIndex++) {
		const dataLength = shortBlockDataLen + (blockIndex < numShortBlocks ? 0 : 1);
		const blockData = dataCodewords.slice(offset, offset + dataLength);
		offset += dataLength;
		const blockEcc = reedSolomonComputeRemainder(blockData, rsDivisor);
		if (blockIndex < numShortBlocks) blockData.push(0);
		blocks.push(blockData.concat(blockEcc));
	}

	const result: number[] = [];
	const blockLength = blocks[0]?.length ?? 0;
	for (let index = 0; index < blockLength; index++) {
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			if (index === shortBlockDataLen && blockIndex < numShortBlocks) continue;
			const codeword = blocks[blockIndex][index];
			if (codeword !== undefined) result.push(codeword);
		}
	}
	return result;
}

function createDataCodewords(data: readonly number[], version: number): number[] {
	const capacityBits = getNumDataCodewords(version) * 8;
	const bits: number[] = [];
	appendBits(bits, BYTE_MODE_INDICATOR, 4);
	appendBits(bits, data.length, getByteModeCharCountBits(version));
	for (const byte of data) appendBits(bits, byte, 8);
	appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);

	const result: number[] = [];
	for (let index = 0; index < bits.length; index += 8) {
		let codeword = 0;
		for (let bitIndex = 0; bitIndex < 8; bitIndex++) codeword = (codeword << 1) | bits[index + bitIndex];
		result.push(codeword);
	}
	for (let padByte = 0xec; result.length < getNumDataCodewords(version); padByte ^= 0xec ^ 0x11) {
		result.push(padByte);
	}
	return result;
}

function appendBits(bits: number[], value: number, length: number): void {
	if (length < 0 || length > 31 || value >>> length !== 0) {
		throw new Error("QR bit value is out of range");
	}
	for (let index = length - 1; index >= 0; index--) bits.push((value >>> index) & 1);
}

function reedSolomonComputeDivisor(degree: number): number[] {
	const result = Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let index = 0; index < degree; index++) {
		for (let coefficient = 0; coefficient < result.length; coefficient++) {
			result[coefficient] = reedSolomonMultiply(result[coefficient], root);
			if (coefficient + 1 < result.length) result[coefficient] ^= result[coefficient + 1];
		}
		root = reedSolomonMultiply(root, 0x02);
	}
	return result;
}

function reedSolomonComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
	const result = Array<number>(divisor.length).fill(0);
	for (const byte of data) {
		const factor = byte ^ result[0];
		result.copyWithin(0, 1);
		result[result.length - 1] = 0;
		for (let index = 0; index < result.length; index++) {
			result[index] ^= reedSolomonMultiply(divisor[index], factor);
		}
	}
	return result;
}

function reedSolomonMultiply(left: number, right: number): number {
	let result = 0;
	for (let index = 7; index >= 0; index--) {
		result = (result << 1) ^ ((result >>> 7) * 0x11d);
		result ^= ((right >>> index) & 1) * left;
	}
	return result;
}

function addCodewords(state: QrBuildState, codewords: readonly number[]): void {
	let bitIndex = 0;
	for (let right = state.size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vertical = 0; vertical < state.size; vertical++) {
			for (let column = 0; column < 2; column++) {
				const x = right - column;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? state.size - 1 - vertical : vertical;
				if (state.isFunction[y][x]) continue;
				const codeword = codewords[Math.floor(bitIndex / 8)];
				state.modules[y][x] = codeword === undefined ? false : getBit(codeword, 7 - (bitIndex % 8));
				bitIndex++;
			}
		}
	}
}

function applyBestMask(state: QrBuildState): void {
	let bestMask = 0;
	let bestPenalty = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(state, mask);
		drawFormatBits(state, mask);
		const penalty = calculatePenalty(state.modules);
		if (penalty < bestPenalty) {
			bestMask = mask;
			bestPenalty = penalty;
		}
		applyMask(state, mask);
	}
	applyMask(state, bestMask);
	drawFormatBits(state, bestMask);
}

function applyMask(state: QrBuildState, mask: number): void {
	for (let y = 0; y < state.size; y++) {
		for (let x = 0; x < state.size; x++) {
			if (!state.isFunction[y][x] && getMaskBit(mask, x, y)) state.modules[y][x] = !state.modules[y][x];
		}
	}
}

function getMaskBit(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			throw new Error(`Unsupported QR mask: ${mask}`);
	}
}

function calculatePenalty(modules: readonly (readonly boolean[])[]): number {
	return (
		calculateRunPenalty(modules) +
		calculateBlockPenalty(modules) +
		calculateFinderLikePenalty(modules) +
		calculateBalancePenalty(modules)
	);
}

function calculateRunPenalty(modules: readonly (readonly boolean[])[]): number {
	let penalty = 0;
	for (const row of modules) penalty += calculateLineRunPenalty(row);
	for (let x = 0; x < modules.length; x++) {
		const column = modules.map((row) => row[x]);
		penalty += calculateLineRunPenalty(column);
	}
	return penalty;
}

function calculateLineRunPenalty(line: readonly boolean[]): number {
	let penalty = 0;
	let runColor = line[0] ?? false;
	let runLength = 0;
	for (const cell of line) {
		if (cell === runColor) {
			runLength++;
			continue;
		}
		if (runLength >= 5) penalty += PENALTY_N1 + runLength - 5;
		runColor = cell;
		runLength = 1;
	}
	if (runLength >= 5) penalty += PENALTY_N1 + runLength - 5;
	return penalty;
}

function calculateBlockPenalty(modules: readonly (readonly boolean[])[]): number {
	let penalty = 0;
	for (let y = 0; y < modules.length - 1; y++) {
		for (let x = 0; x < modules.length - 1; x++) {
			const color = modules[y][x];
			if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
				penalty += PENALTY_N2;
			}
		}
	}
	return penalty;
}

function calculateFinderLikePenalty(modules: readonly (readonly boolean[])[]): number {
	let penalty = 0;
	for (const row of modules) penalty += calculateFinderLikeLinePenalty(row);
	for (let x = 0; x < modules.length; x++) {
		const column = modules.map((row) => row[x]);
		penalty += calculateFinderLikeLinePenalty(column);
	}
	return penalty;
}

function calculateFinderLikeLinePenalty(line: readonly boolean[]): number {
	let penalty = 0;
	for (let index = 0; index <= line.length - 11; index++) {
		if (matchesFinderLikePattern(line, index)) penalty += PENALTY_N3;
	}
	return penalty;
}

function matchesFinderLikePattern(line: readonly boolean[], offset: number): boolean {
	return (
		matchesPattern(line, offset, [true, false, true, true, true, false, true, false, false, false, false]) ||
		matchesPattern(line, offset, [false, false, false, false, true, false, true, true, true, false, true])
	);
}

function matchesPattern(line: readonly boolean[], offset: number, pattern: readonly boolean[]): boolean {
	for (let index = 0; index < pattern.length; index++) {
		if (line[offset + index] !== pattern[index]) return false;
	}
	return true;
}

function calculateBalancePenalty(modules: readonly (readonly boolean[])[]): number {
	let darkModules = 0;
	for (const row of modules) {
		for (const cell of row) {
			if (cell) darkModules++;
		}
	}
	const total = modules.length * modules.length;
	return (Math.ceil(Math.abs(darkModules * 20 - total * 10) / total) - 1) * PENALTY_N4;
}

function formatQrCode(qrCode: IrohRemoteTicketQrCode, options: IrohRemoteTicketQrCodeFormatOptions): string {
	const margin = options.margin ?? 2;
	if (!Number.isInteger(margin) || margin < 0) throw new Error("QR code margin must be a non-negative integer");
	const min = -margin;
	const max = qrCode.size + margin;
	const lines: string[] = [];
	for (let y = min; y < max; y += 2) {
		let line = "";
		for (let x = min; x < max; x++) {
			line += getHalfBlockCell(getQrModule(qrCode, x, y), getQrModule(qrCode, x, y + 1));
		}
		lines.push(`${line}${ANSI_RESET}`);
	}
	return lines.join("\n");
}

function getQrModule(qrCode: IrohRemoteTicketQrCode, x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= qrCode.size || y >= qrCode.size) return false;
	return qrCode.modules[y][x];
}

function getHalfBlockCell(upperBlack: boolean, lowerBlack: boolean): string {
	const foreground = upperBlack ? BLACK_FOREGROUND : WHITE_FOREGROUND;
	const background = lowerBlack ? BLACK_BACKGROUND : WHITE_BACKGROUND;
	return `${foreground}${background}▀`;
}
