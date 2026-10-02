// Package appattest verifies request-bound Apple App Attest evidence.
package appattest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/url"
	"regexp"
)

var ErrInvalid = errors.New("App Attest evidence is invalid")

var nodePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var claimPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var devicePattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Request contains only canonical values. Hash is computed independently by the
// app and broker; neither accepts an opaque hash supplied by its peer to sign.
type Request struct {
	Issuer        string
	ClaimID       string
	HostNodeID    string
	AppNodeID     string
	RefreshHash   [32]byte
	ProofHash     [32]byte
	DeviceID      string
	KeyID         string
	AppCheckHash  [32]byte
	BundleVersion string
}

func (r Request) Validate() error {
	u, err := url.Parse(r.Issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.RawPath != "" ||
		!claimPattern.MatchString(r.ClaimID) || !nodePattern.MatchString(r.HostNodeID) ||
		!nodePattern.MatchString(r.AppNodeID) || !devicePattern.MatchString(r.DeviceID) {
		return ErrInvalid
	}
	key, err := base64.StdEncoding.Strict().DecodeString(r.KeyID)
	if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != r.KeyID {
		return ErrInvalid
	}
	var zero [32]byte
	if r.RefreshHash == zero || r.ProofHash == zero || r.AppCheckHash == zero {
		return ErrInvalid
	}
	if !regexp.MustCompile(`^[0-9]{1,18}(\.[0-9]{1,18}){0,2}$`).MatchString(r.BundleVersion) {
		return ErrInvalid
	}
	return nil
}

// Hash uses a fixed field order and uint32 big-endian byte lengths, avoiding
// JSON ordering, delimiter ambiguity, and locale-dependent encodings.
func (r Request) Hash(purpose string, challenge [32]byte) ([32]byte, error) {
	if err := r.Validate(); err != nil {
		return [32]byte{}, err
	}
	if purpose != "register" && purpose != "approve" {
		return [32]byte{}, ErrInvalid
	}
	h := sha256.New()
	fields := [][]byte{
		[]byte("volt-pairing-app-attest"), []byte(purpose), []byte(r.Issuer),
		[]byte(r.ClaimID), []byte(r.HostNodeID), []byte(r.AppNodeID),
		r.RefreshHash[:], r.ProofHash[:], []byte(r.DeviceID), []byte(r.KeyID),
		r.AppCheckHash[:], []byte(r.BundleVersion), challenge[:],
	}
	for _, field := range fields {
		var size [4]byte
		binary.BigEndian.PutUint32(size[:], uint32(len(field)))
		h.Write(size[:])
		h.Write(field)
	}
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest, nil
}
