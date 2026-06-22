import QRCodeTerminal from "qrcode-terminal";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

const IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL = "M";

export interface IrohRemoteTicketQrCode {
	modules: boolean[][];
	size: number;
	version: number;
}

export interface IrohRemoteTicketQrCodeFormatOptions {
	small?: boolean;
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
