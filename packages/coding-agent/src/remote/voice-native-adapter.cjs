// The optional voice media engine: werift (WebRTC in TypeScript) and
// opusscript (Opus in WASM). Both are optional dependencies, so a Volt
// install made without them still runs; voice then reports
// `native_media_unavailable` instead of failing at load.
let werift;
let opusscript;
let loadError;
let loadAttempted = false;

function loadVoiceNativeMedia() {
	if (!loadAttempted) {
		loadAttempted = true;
		try {
			werift = require("werift");
			opusscript = require("opusscript");
		} catch (error) {
			loadError = error;
			werift = undefined;
			opusscript = undefined;
		}
	}
	return { werift, opusscript, loadError };
}

module.exports = {
	loadVoiceNativeMedia,
};
