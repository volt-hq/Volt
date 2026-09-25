import { Buffer } from "node:buffer";
import png from "@jimp/js-png";
import QRCodeTerminal from "qrcode-terminal";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

const IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL = "M";
export const IROH_REMOTE_QR_QUIET_ZONE_MODULES = 4;
const BLACK_PIXEL = Buffer.from([0, 0, 0, 0xff]);

export interface IrohRemoteTicketQrCode {
	modules: boolean[][];
	size: number;
	version: number;
}

export interface IrohRemoteTicketQrCodeFormatOptions {
	small?: boolean;
}

export interface IrohRemoteTicketQrCodePngOptions {
	/** Edge length of one module in pixels. Integer sizes keep every module the same width when displayed 1:1. */
	modulePixels: number;
	/** Canvas size. The code and its quiet zone are centered; any extra margin stays white. */
	widthPx: number;
	heightPx: number;
}

export function createIrohRemoteTicketQrCode(ticket: string): IrohRemoteTicketQrCode {
	const qrCode = new QRCode(-1, QRErrorCorrectLevel[IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL]);
	qrCode.addData(ticket);
	qrCode.make();
	const size = qrCode.getModuleCount();
	return {
		modules: qrCode.modules.map((row) => row.map((module) => module === true)),
		size,
		version: Math.floor((size - 17) / 4),
	};
}

/** Encode a QR code as a base64 PNG with square, integer-sized modules. */
export function encodeIrohRemoteTicketQrCodePng(
	qrCode: IrohRemoteTicketQrCode,
	{ modulePixels, widthPx, heightPx }: IrohRemoteTicketQrCodePngOptions,
): string {
	const sidePx = (qrCode.size + IROH_REMOTE_QR_QUIET_ZONE_MODULES * 2) * modulePixels;
	if (!Number.isInteger(modulePixels) || modulePixels < 1 || sidePx > widthPx || sidePx > heightPx) {
		throw new RangeError(`QR code needs a ${sidePx}px square; canvas is ${widthPx}x${heightPx}px`);
	}
	const data = Buffer.alloc(widthPx * heightPx * 4, 0xff);
	const quietZonePx = IROH_REMOTE_QR_QUIET_ZONE_MODULES * modulePixels;
	const left = Math.floor((widthPx - sidePx) / 2) + quietZonePx;
	const top = Math.floor((heightPx - sidePx) / 2) + quietZonePx;
	for (let row = 0; row < qrCode.size; row++) {
		for (let column = 0; column < qrCode.size; column++) {
			if (!qrCode.modules[row]![column]) continue;
			for (let y = top + row * modulePixels; y < top + (row + 1) * modulePixels; y++) {
				const start = (y * widthPx + left + column * modulePixels) * 4;
				data.fill(BLACK_PIXEL, start, start + modulePixels * 4);
			}
		}
	}
	return png().encode({ data, width: widthPx, height: heightPx }).toString("base64");
}

export function formatIrohRemoteTicketQrCode(
	ticket: string,
	options: IrohRemoteTicketQrCodeFormatOptions = {},
): string {
	return formatIrohRemoteTicketQrCodeTerminal(ticket, options);
}

export function formatIrohRemoteTicketQrCodeTerminal(
	ticket: string,
	options: IrohRemoteTicketQrCodeFormatOptions = {},
): string {
	let output = "";
	QRCodeTerminal.setErrorLevel(IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL);
	QRCodeTerminal.generate(ticket, { small: options.small ?? true }, (qrCode) => {
		output = qrCode;
	});
	return output;
}
