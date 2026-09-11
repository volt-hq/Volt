package appattest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"regexp"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// Apple App Attestation Root CA, retrieved from Apple's Private PKI repository.
// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
//
//go:embed apple-root.pem
var appleRootPEM []byte

const maxAttestationBytes = 24 * 1024
const maxAssertionBytes = 1024

type Verifier struct {
	roots    *x509.CertPool
	rpID     [32]byte
	aaguid   [16]byte
	decode   cbor.DecMode
	now      func() time.Time
	category uint32
}

type attestationObject struct {
	Format    string `cbor:"fmt"`
	AuthData  []byte `cbor:"authData"`
	Statement struct {
		Certificates [][]byte `cbor:"x5c"`
		Receipt      []byte   `cbor:"receipt"`
	} `cbor:"attStmt"`
}

type assertionObject struct {
	Signature []byte `cbor:"signature"`
	AuthData  []byte `cbor:"authenticatorData"`
}

type coseKey struct {
	Type      int    `cbor:"1,keyasint"`
	Algorithm int    `cbor:"3,keyasint"`
	Curve     int    `cbor:"-1,keyasint"`
	X         []byte `cbor:"-2,keyasint"`
	Y         []byte `cbor:"-3,keyasint"`
}

// NewAppleVerifier accepts only the pinned Apple App Attestation root. Test
// roots are injected through an unexported constructor in this package's tests.
func NewAppleVerifier(appID, environment string, category uint32, now func() time.Time) (*Verifier, error) {
	if (environment == "production" && category != 2 && category != 4) || (environment == "development" && category != 3) {
		return nil, ErrInvalid
	}
	block, rest := pem.Decode(appleRootPEM)
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, ErrInvalid
	}
	root, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, ErrInvalid
	}
	return newVerifier(root, appID, environment, category, now)
}

func newVerifier(root *x509.Certificate, appID, environment string, category uint32, now func() time.Time) (*Verifier, error) {
	if root == nil || !root.IsCA || !regexp.MustCompile(`^[A-Z0-9]{10}\.[A-Za-z0-9.-]{1,200}$`).MatchString(appID) {
		return nil, ErrInvalid
	}
	var aaguid [16]byte
	switch environment {
	case "production":
		copy(aaguid[:], []byte("appattest"))
	case "development":
		copy(aaguid[:], []byte("appattestdevelop"))
	default:
		return nil, ErrInvalid
	}
	decoder, err := (cbor.DecOptions{
		DupMapKey:       cbor.DupMapKeyEnforcedAPF,
		MaxNestedLevels: 4, MaxArrayElements: 16, MaxMapPairs: 16,
		IndefLength: cbor.IndefLengthForbidden, TagsMd: cbor.TagsForbidden,
		ExtraReturnErrors: cbor.ExtraDecErrorUnknownField,
		UTF8:              cbor.UTF8RejectInvalid, FieldNameMatching: cbor.FieldNameMatchingCaseSensitive,
	}).DecMode()
	if err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	return &Verifier{roots: roots, rpID: sha256.Sum256([]byte(appID)), aaguid: aaguid, decode: decoder, now: now, category: category}, nil
}

// VerifyAttestation implements Apple's attestation validation steps, including
// the challenge nonce, RP ID, environment, credential ID and COSE public key.
// Returned public key is X9.62 uncompressed P-256. No receipt data is returned.
func (v *Verifier) VerifyAttestation(keyID string, object []byte, clientDataHash [32]byte, bundleVersion string) ([]byte, error) {
	return v.verifyAttestation(keyID, object, clientDataHash[:], bundleVersion)
}

// The internal byte-slice form also permits checking Apple's published fixture,
// which signs the 24 raw example challenge bytes. Production callers can supply
// only the 32-byte independently computed request hash through VerifyAttestation.
func (v *Verifier) verifyAttestation(keyID string, object, clientDataHash []byte, bundleVersion string) (_ []byte, resultErr error) {
	stage := "object_size"
	defer func() {
		if resultErr != nil {
			resultErr = &rejection{reason: stage}
		}
	}()
	if len(object) == 0 || len(object) > maxAttestationBytes {
		return nil, ErrInvalid
	}
	stage = "object_format"
	var att attestationObject
	if err := v.decode.Unmarshal(object, &att); err != nil || att.Format != "apple-appattest" ||
		len(att.Statement.Certificates) != 2 || len(att.Statement.Receipt) == 0 ||
		len(att.AuthData) < 55 {
		return nil, ErrInvalid
	}
	stage = "leaf_certificate"
	leaf, err := x509.ParseCertificate(att.Statement.Certificates[0])
	if err != nil || leaf.IsCA {
		return nil, ErrInvalid
	}
	stage = "intermediate_certificate"
	intermediate, err := x509.ParseCertificate(att.Statement.Certificates[1])
	if err != nil || !intermediate.IsCA {
		return nil, ErrInvalid
	}
	intermediates := x509.NewCertPool()
	intermediates.AddCert(intermediate)
	stage = "certificate_chain"
	chains, err := leaf.Verify(x509.VerifyOptions{Roots: v.roots, Intermediates: intermediates, CurrentTime: v.now().UTC(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}})
	if err != nil || len(chains) == 0 || len(chains[0]) != 3 || !bytes.Equal(chains[0][1].Raw, intermediate.Raw) {
		return nil, ErrInvalid
	}
	stage = "public_key"
	publicKey, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() {
		return nil, ErrInvalid
	}
	publicBytes := elliptic.Marshal(publicKey.Curve, publicKey.X, publicKey.Y)
	keyHash := sha256.Sum256(publicBytes)
	stage = "key_identifier"
	if base64.StdEncoding.EncodeToString(keyHash[:]) != keyID {
		return nil, ErrInvalid
	}
	// App Attest uses attested credential data (AT), not WebAuthn user presence.
	stage = "app_identifier"
	if !bytes.Equal(att.AuthData[:32], v.rpID[:]) {
		return nil, ErrInvalid
	}
	stage = "authenticator_flags"
	if att.AuthData[32] != 0x40 {
		return nil, ErrInvalid
	}
	stage = "initial_counter"
	if binary.BigEndian.Uint32(att.AuthData[33:37]) != 0 {
		return nil, ErrInvalid
	}
	stage = "attestation_environment"
	if !bytes.Equal(att.AuthData[37:53], v.aaguid[:]) {
		return nil, ErrInvalid
	}
	stage = "credential_identifier"
	credentialLength := int(binary.BigEndian.Uint16(att.AuthData[53:55]))
	if credentialLength != 32 || len(att.AuthData) <= 55+credentialLength || !bytes.Equal(att.AuthData[55:87], keyHash[:]) {
		return nil, ErrInvalid
	}
	stage = "credential_public_key"
	var cose coseKey
	extensions, err := v.decode.UnmarshalFirst(att.AuthData[87:], &cose)
	if err != nil || cose.Type != 2 || cose.Algorithm != -7 || cose.Curve != 1 ||
		len(cose.X) != 32 || len(cose.Y) != 32 || !bytes.Equal(cose.X, publicBytes[1:33]) || !bytes.Equal(cose.Y, publicBytes[33:]) {
		return nil, ErrInvalid
	}
	if stage = v.extensionRejectionReason(extensions, bundleVersion); stage != "" {
		return nil, ErrInvalid
	}
	stage = "certificate_nonce"
	data := append(append([]byte(nil), att.AuthData...), clientDataHash[:]...)
	expectedNonce := sha256.Sum256(data)
	found := false
	for _, extension := range leaf.Extensions {
		if !extension.Id.Equal(asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 2}) {
			continue
		}
		if found {
			return nil, ErrInvalid
		}
		found = true
		var nonce struct {
			Value []byte `asn1:"explicit,tag:1"`
		}
		rest, err := asn1.Unmarshal(extension.Value, &nonce)
		if err != nil || len(rest) != 0 || !bytes.Equal(nonce.Value, expectedNonce[:]) {
			return nil, ErrInvalid
		}
	}
	if !found {
		return nil, ErrInvalid
	}
	return publicBytes, nil
}

// VerifyAssertion validates the signed request; the broker must atomically
// enforce returnedCounter > persistedCounter and consume the challenge.
func (v *Verifier) VerifyAssertion(publicKey, object []byte, clientDataHash [32]byte, bundleVersion string) (_ uint32, resultErr error) {
	stage := "assertion_size"
	defer func() {
		if resultErr != nil {
			resultErr = &rejection{reason: stage}
		}
	}()
	if len(object) == 0 || len(object) > maxAssertionBytes || len(publicKey) != 65 {
		return 0, ErrInvalid
	}
	var assertion assertionObject
	stage = "assertion_format"
	if err := v.decode.Unmarshal(object, &assertion); err != nil || len(assertion.AuthData) < 37 {
		return 0, ErrInvalid
	}
	stage = "assertion_app_identifier"
	if !bytes.Equal(assertion.AuthData[:32], v.rpID[:]) {
		return 0, ErrInvalid
	}
	stage = "assertion_flags"
	// App Attest assertions retain Apple's 0x40 flags byte even though they
	// omit the attested credential section. This is not a WebAuthn assertion.
	if assertion.AuthData[32] != 0x40 {
		return 0, ErrInvalid
	}
	if stage = v.extensionRejectionReason(assertion.AuthData[37:], bundleVersion); stage != "" {
		return 0, ErrInvalid
	}
	stage = "assertion_zero_counter"
	counter := binary.BigEndian.Uint32(assertion.AuthData[33:])
	if counter == 0 {
		return 0, ErrInvalid
	}
	stage = "assertion_public_key"
	x, y := elliptic.Unmarshal(elliptic.P256(), publicKey)
	if x == nil {
		return 0, ErrInvalid
	}
	data := append(append([]byte(nil), assertion.AuthData...), clientDataHash[:]...)
	nonce := sha256.Sum256(data)
	// Apple signs nonce as a message with ECDSA-SHA256. VerifyASN1 expects
	// the message digest, unlike CryptoKit's Data-taking verification API.
	digest := sha256.Sum256(nonce[:])
	stage = "assertion_signature"
	if !ecdsa.VerifyASN1(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, digest[:], assertion.Signature) {
		return 0, ErrInvalid
	}
	return counter, nil
}

func (v *Verifier) validExtensions(data []byte, bundleVersion string) bool {
	return v.extensionRejectionReason(data, bundleVersion) == ""
}

func (v *Verifier) extensionRejectionReason(data []byte, bundleVersion string) string {
	var extensions struct {
		Category      []byte `cbor:"apple_validation_category_01"`
		BundleVersion string `cbor:"apple_bundle_version_01"`
	}
	if len(data) == 0 {
		// Apple introduced these extensions in iOS 27. Earlier authenticators
		// omit them; the nonce/signature still covers all authenticator bytes.
		// Nonempty metadata must pass every check below, even if incomplete.
		return ""
	}
	if len(data) > 256 {
		return "metadata_size"
	}
	if v.decode.Unmarshal(data, &extensions) != nil {
		return "metadata_encoding"
	}
	if len(extensions.Category) != 4 {
		return "validation_category_missing"
	}
	if binary.LittleEndian.Uint32(extensions.Category) != v.category {
		return "validation_category_mismatch"
	}
	if bundleVersion == "" || extensions.BundleVersion != bundleVersion {
		return "bundle_version_mismatch"
	}
	return ""
}
