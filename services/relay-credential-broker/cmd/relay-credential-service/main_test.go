package main

import (
	"encoding/base64"
	"encoding/pem"
	"os"
	"testing"
)

func TestLoadConfigSelectsCloudKMSSigning(t *testing.T) {
	setMinimumEnvironment(t)
	t.Setenv("VOLT_CREDENTIAL_SIGNING_MODE", "kms")
	t.Setenv("VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION", "projects/volt/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/2")
	t.Setenv("VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS", "projects/volt/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/1, projects/volt/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/3")

	configuration, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if configuration.SigningMode != "kms" || configuration.SigningKeyPath != "" {
		t.Fatalf("unexpected Cloud KMS signing configuration: %+v", configuration)
	}
	if len(configuration.KMSRetiringKeyVersions) != 2 {
		t.Fatalf("retiring key versions = %v, want two", configuration.KMSRetiringKeyVersions)
	}
	if len(configuration.AppStoreEnvironments) != 1 || configuration.AppStoreEnvironments[0] != "Production" {
		t.Fatalf("unsafe default App Store environments: %v", configuration.AppStoreEnvironments)
	}
	if configuration.MaxBootstrapRequestsPerMin != 60 || configuration.MaxApprovalRequestsPerMin != 120 || configuration.MaxExchangeRequestsPerMin != 600 {
		t.Fatalf("unexpected enrollment request budgets: %+v", configuration)
	}
}

func TestLoadConfigSelectsExplicitLocalSigning(t *testing.T) {
	setMinimumEnvironment(t)
	t.Setenv("VOLT_CREDENTIAL_SIGNING_MODE", "local")
	configuration, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if configuration.SigningMode != "local" || configuration.SigningKeyPath != defaultSigningKey {
		t.Fatalf("unexpected local signing configuration: %+v", configuration)
	}
}

func TestLoadConfigRejectsDevelopmentEntitlementForProductionIssuer(t *testing.T) {
	setMinimumEnvironment(t)
	t.Setenv("VOLT_CREDENTIAL_SIGNING_MODE", "local")
	t.Setenv("VOLT_CREDENTIAL_ISSUER", "https://credentials.volt-cli.dev")
	t.Setenv("VOLT_APP_STORE_MODE", "development")

	if _, err := loadConfig(); err == nil {
		t.Fatal("production issuer accepted development App Store authority")
	}
}

func TestLoadConfigRejectsMixedOrIncompleteSigningModes(t *testing.T) {
	tests := []struct {
		name        string
		mode        string
		localPath   string
		activeKMS   string
		retiringKMS string
	}{
		{name: "missing mode"},
		{name: "unsupported mode", mode: "automatic"},
		{name: "missing active KMS key", mode: "kms"},
		{name: "local file in KMS mode", mode: "kms", localPath: "/tmp/signing-key", activeKMS: "kms-version"},
		{name: "empty retiring KMS version", mode: "kms", activeKMS: "kms-version", retiringKMS: "first,,second"},
		{name: "KMS key in local mode", mode: "local", activeKMS: "kms-version"},
		{name: "retiring key in local mode", mode: "local", retiringKMS: "kms-version"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setMinimumEnvironment(t)
			t.Setenv("VOLT_CREDENTIAL_SIGNING_MODE", test.mode)
			t.Setenv("VOLT_CREDENTIAL_SIGNING_KEY_FILE", test.localPath)
			t.Setenv("VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION", test.activeKMS)
			t.Setenv("VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS", test.retiringKMS)
			if _, err := loadConfig(); err == nil {
				t.Fatal("unsafe signing configuration was accepted")
			}
		})
	}
}

func setMinimumEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"VOLT_CREDENTIAL_LISTEN",
		"VOLT_CREDENTIAL_ISSUER",
		"VOLT_CREDENTIAL_AUDIENCE",
		"VOLT_CREDENTIAL_SIGNING_MODE",
		"VOLT_CREDENTIAL_SIGNING_KEY_FILE",
		"VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION",
		"VOLT_CREDENTIAL_KMS_RETIRING_KEY_VERSIONS",
		"VOLT_FIREBASE_PROJECT_NUMBER",
		"VOLT_ALLOWED_FIREBASE_APP_IDS",
		"VOLT_APP_ATTEST_APP_ID",
		"VOLT_APP_STORE_MODE",
		"VOLT_DEVELOPMENT_APP_STORE_PROOF",
		"VOLT_APP_STORE_PRIVATE_KEY",
		"VOLT_APP_STORE_KEY_ID",
		"VOLT_APP_STORE_ISSUER_ID",
		"VOLT_APP_STORE_BUNDLE_ID",
		"VOLT_APP_STORE_APP_APPLE_ID",
		"VOLT_APP_STORE_SUBSCRIPTION_GROUP_ID",
		"VOLT_APP_STORE_PRODUCT_IDS",
		"VOLT_APP_STORE_ENVIRONMENTS",
		"VOLT_APP_STORE_RECONCILE_INTERVAL",
		"VOLT_APP_STORE_ROOT_CERTIFICATES_BASE64",
		"VOLT_CREDENTIAL_CLAIM_TTL",
		"VOLT_CREDENTIAL_ACCESS_TTL",
		"VOLT_CREDENTIAL_REFRESH_INACTIVITY_TTL",
		"VOLT_CREDENTIAL_REFRESH_MIN_INTERVAL",
		"VOLT_CREDENTIAL_MAX_CLAIMS",
		"VOLT_CREDENTIAL_MAX_ENDPOINTS",
		"VOLT_CREDENTIAL_MAX_APP_ENDPOINTS_PER_GRANT",
		"VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS",
		"VOLT_CREDENTIAL_MAX_BOOTSTRAP_REQUESTS_PER_MINUTE",
		"VOLT_CREDENTIAL_MAX_APPROVAL_REQUESTS_PER_MINUTE",
		"VOLT_CREDENTIAL_MAX_EXCHANGE_REQUESTS_PER_MINUTE",
	} {
		t.Setenv(name, "")
	}
	t.Setenv("VOLT_CREDENTIAL_DATABASE_URL", "postgres://test.invalid/volt")
	t.Setenv("VOLT_APP_CHECK_MODE", "development")
	t.Setenv("VOLT_DEVELOPMENT_APP_CHECK_TOKEN", "development-app-check-token-value")
	t.Setenv("VOLT_APP_STORE_MODE", "development")
	t.Setenv("VOLT_DEVELOPMENT_APP_STORE_PROOF", "development-app-store-proof-value")
}

// Regression: #387. Sandbox purchases do not imply development App Attest keys.
func TestRegression387AppAttestDeploymentAuthority(t *testing.T) {
	for _, fixture := range []struct {
		issuer, environment string
		category            uint32
	}{
		{"https://credentials-canary.volt-cli.dev", "Sandbox", 2},
		{"https://credentials.volt-cli.dev", "Production", 4},
	} {
		t.Run(fixture.environment, func(t *testing.T) {
			setMinimumEnvironment(t)
			t.Setenv("VOLT_CREDENTIAL_SIGNING_MODE", "local")
			t.Setenv("VOLT_CREDENTIAL_ISSUER", fixture.issuer)
			t.Setenv("VOLT_APP_CHECK_MODE", "firebase")
			t.Setenv("VOLT_FIREBASE_PROJECT_NUMBER", "123456")
			t.Setenv("VOLT_ALLOWED_FIREBASE_APP_IDS", "test-app")
			t.Setenv("VOLT_APP_STORE_MODE", "apple")
			t.Setenv("VOLT_APP_STORE_APP_APPLE_ID", "123456")
			t.Setenv("VOLT_APP_STORE_KEY_ID", "TESTKEY")
			t.Setenv("VOLT_APP_STORE_PRIVATE_KEY", "test-only-config-placeholder")
			t.Setenv("VOLT_APP_STORE_ISSUER_ID", "test-issuer")
			t.Setenv("VOLT_APP_STORE_SUBSCRIPTION_GROUP_ID", "test-group")
			t.Setenv("VOLT_APP_STORE_ENVIRONMENTS", fixture.environment)
			root, err := os.ReadFile("../../internal/appattest/apple-root.pem")
			if err != nil {
				t.Fatal(err)
			}
			block, _ := pem.Decode(root)
			t.Setenv("VOLT_APP_STORE_ROOT_CERTIFICATES_BASE64", base64.StdEncoding.EncodeToString(block.Bytes))
			if _, err := loadConfig(); err == nil {
				t.Fatal("missing App ID accepted")
			}
			t.Setenv("VOLT_APP_ATTEST_APP_ID", "ABCDEFGHIJ.wrong.bundle")
			if _, err := loadConfig(); err == nil {
				t.Fatal("mismatched App ID accepted")
			}
			t.Setenv("VOLT_APP_ATTEST_APP_ID", "ABCDEFGHIJ.com.hansjm10.volt")
			cfg, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.AppAttestEnvironment != "production" || cfg.AppAttestCategory != fixture.category {
				t.Fatal("incorrect App Attest environment/category")
			}
			t.Setenv("VOLT_APP_STORE_ENVIRONMENTS", "Production,Sandbox")
			if _, err := loadConfig(); err == nil {
				t.Fatal("mixed receipt environments accepted")
			}
		})
	}
}
