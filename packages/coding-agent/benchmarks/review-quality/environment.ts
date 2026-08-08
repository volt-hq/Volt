export const REAL_MODEL_ENV_FLAG = "VOLT_REVIEW_QUALITY_REAL_MODEL";
export const REAL_MODEL_PROVIDER_ENV = "VOLT_REVIEW_QUALITY_PROVIDER";
export const REAL_MODEL_ID_ENV = "VOLT_REVIEW_QUALITY_MODEL";

export type ReviewQualityEnvironment = Readonly<Record<string, string | undefined>>;
