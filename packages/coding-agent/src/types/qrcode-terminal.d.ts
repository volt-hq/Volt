declare module "qrcode-terminal" {
	export type QrCodeTerminalErrorCorrectionLevel = "L" | "M" | "Q" | "H";

	export interface QrCodeTerminalGenerateOptions {
		small?: boolean;
	}

	export interface QrCodeTerminal {
		error: number;
		generate(input: string, callback: (output: string) => void): void;
		generate(input: string, options: QrCodeTerminalGenerateOptions, callback: (output: string) => void): void;
		setErrorLevel(error: QrCodeTerminalErrorCorrectionLevel): void;
	}

	const qrCodeTerminal: QrCodeTerminal;
	export default qrCodeTerminal;
}

declare module "qrcode-terminal/vendor/QRCode/index.js" {
	export default class QRCode {
		modules: boolean[][];
		constructor(typeNumber: number, errorCorrectLevel: number);
		addData(data: string): void;
		getModuleCount(): number;
		make(): void;
	}
}

declare module "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js" {
	const errorCorrectLevel: {
		H: number;
		L: number;
		M: number;
		Q: number;
	};
	export default errorCorrectLevel;
}
