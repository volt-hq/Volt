package appattest

import "errors"

// Only verifier-owned labels cross the logging boundary. Never retain the
// rejected object, certificate, key ID, request hash or decoder error text.
type rejection struct{ reason string }

func (e *rejection) Error() string { return ErrInvalid.Error() }
func (e *rejection) Unwrap() error { return ErrInvalid }

func RejectionReason(err error) string {
	var rejected *rejection
	if errors.As(err, &rejected) {
		return rejected.reason
	}
	return "unclassified"
}
