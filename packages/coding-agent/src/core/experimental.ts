export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.VOLT_EXPERIMENTAL === "1";
}
