package broker

import (
	"errors"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
)

type attestationRejection struct {
	reason string
	cause  error
}

func (e *attestationRejection) Error() string { return ErrAttestationInvalid.Error() }
func (e *attestationRejection) Unwrap() error { return e.cause }

func AttestationRejectionReason(err error) string {
	if errors.Is(err, ErrAppCheckReplay) {
		return "app_check_replay"
	}
	if errors.Is(err, ErrAppCheckInvalid) {
		return "app_check_invalid"
	}
	var rejected *attestationRejection
	if errors.As(err, &rejected) {
		if rejected.reason == "apple_verification" {
			return "apple_" + appattest.RejectionReason(rejected.cause)
		}
		return rejected.reason
	}
	if errors.Is(err, ErrAttestationInvalid) {
		return "attestation_invalid"
	}
	return "unclassified"
}
