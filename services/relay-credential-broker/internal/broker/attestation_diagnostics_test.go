package broker

import (
	"errors"
	"fmt"
	"testing"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
)

func TestRegression387AttestationDiagnosticBoundary(t *testing.T) {
	v, err := appattest.NewAppleVerifier("FLCDL5CJU2.com.hansjm10.volt", "production", 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, cause := v.VerifyAttestation("untrusted-key", nil, [32]byte{}, "5")
	rejected := &attestationRejection{reason: "apple_verification", cause: fmt.Errorf("%w: %w", ErrAttestationInvalid, cause)}
	if !errors.Is(rejected, ErrAttestationInvalid) || AttestationRejectionReason(rejected) != "apple_object_size" {
		t.Fatal("lost typed rejection")
	}
	if rejected.Error() != ErrAttestationInvalid.Error() {
		t.Fatal("public error changed")
	}
	rejected.cause = fmt.Errorf("%w: receipt=secret token=secret", ErrAttestationInvalid)
	if AttestationRejectionReason(rejected) != "apple_unclassified" {
		t.Fatal("arbitrary verifier detail exposed")
	}
	if AttestationRejectionReason(errors.New("secret")) != "unclassified" {
		t.Fatal("arbitrary error exposed")
	}
	rejected.reason = "registration_challenge"
	if AttestationRejectionReason(rejected) != "registration_challenge" {
		t.Fatal("lost challenge rejection stage")
	}
}
