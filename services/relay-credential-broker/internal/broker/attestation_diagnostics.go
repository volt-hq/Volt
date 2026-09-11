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
	var rejected *attestationRejection
	if errors.As(err, &rejected) {
		if rejected.reason == "apple_verification" {
			return "apple_" + appattest.RejectionReason(rejected.cause)
		}
		return rejected.reason
	}
	return "unclassified"
}
