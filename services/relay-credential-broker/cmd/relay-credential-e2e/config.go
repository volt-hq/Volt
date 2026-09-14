//go:build volt_e2e

package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	issuer         = "https://127.0.0.1:18443"
	audience       = "volt-iroh-relay-e2e"
	maxConfigBytes = 16 * 1024
)

var errConfig = errors.New("invalid private E2E configuration")
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type config struct {
	RunID              string `json:"runId"`
	ProofSecret        string `json:"proofSecret"`
	ExpiresAt          int64  `json:"expiresAt"`
	DatabaseURL        string `json:"databaseUrl"`
	SigningKeyPath     string `json:"signingKeyPath"`
	CertificatePath    string `json:"certificatePath"`
	CertificateKeyPath string `json:"certificateKeyPath"`
	ListenAddress      string `json:"listenAddress"`
}

func loadConfig(path string, now time.Time) (config, error) {
	var c config
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return c, errConfig
	}
	// Resolve trusted ancestors once (e.g. macOS /tmp -> /private/tmp).
	// The run directory itself and all leaf files must not be symlinks.
	dir := filepath.Dir(path)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || !ownedSingleFile(info, false) {
		return c, errConfig
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return c, errConfig
	}
	path = filepath.Join(resolved, filepath.Base(path))
	data, err := readPrivateFile(path, maxConfigBytes)
	if err != nil || strictObject(data, &c, "runId", "proofSecret", "expiresAt", "databaseUrl", "signingKeyPath", "certificatePath", "certificateKeyPath", "listenAddress") != nil {
		return config{}, errConfig
	}
	if !canonicalHex(c.RunID, 16) || !canonicalHex(c.ProofSecret, 32) || c.ExpiresAt <= now.Unix() || c.ExpiresAt > now.Add(2*time.Hour).Unix() || validateDatabaseURL(c.DatabaseURL) != nil {
		return config{}, errConfig
	}
	if c.ListenAddress != "127.0.0.1:18443" && c.ListenAddress != "0.0.0.0:18443" {
		return config{}, errConfig
	}
	seen := map[string]bool{path: true}
	for _, asset := range []*string{&c.SigningKeyPath, &c.CertificatePath, &c.CertificateKeyPath} {
		if !filepath.IsAbs(*asset) || filepath.Clean(*asset) != *asset || filepath.Dir(*asset) != dir {
			return config{}, errConfig
		}
		*asset = filepath.Join(resolved, filepath.Base(*asset))
		if seen[*asset] {
			return config{}, errConfig
		}
		seen[*asset] = true
		info, err := os.Lstat(*asset)
		if asset == &c.SigningKeyPath && errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || !privateRegular(info) || info.Size() > 16*1024 {
			return config{}, errConfig
		}
	}
	return c, nil
}

func ownedSingleFile(info os.FileInfo, single bool) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && (!single || stat.Nlink == 1)
}

func privateRegular(info os.FileInfo) bool {
	return info.Mode().IsRegular() && info.Mode().Perm() == 0600 && ownedSingleFile(info, true)
}

func readPrivateFile(path string, limit int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !privateRegular(before) || before.Size() > limit {
		return nil, errConfig
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errConfig
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !privateRegular(after) || !os.SameFile(before, after) {
		return nil, errConfig
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errConfig
	}
	return data, nil
}

func canonicalHex(value string, size int) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == size && hex.EncodeToString(decoded) == value
}

func validateDatabaseURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Opaque != "" || u.Fragment != "" || u.RawPath != "" || u.Path != "/volt_pairing_e2e" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "postgres") || u.User == nil || u.User.Username() == "" {
		return errConfig
	}
	password, ok := u.User.Password()
	if !ok || password == "" {
		return errConfig
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return errConfig
		}
	}
	if u.Host != u.Hostname() && u.Host != u.Hostname()+":"+port {
		return errConfig
	}
	// No host/service/SSL-file overrides, fallback hosts, or runtime parameters.
	if u.RawQuery != "sslmode=disable" {
		return errConfig
	}
	return nil
}

// All fixture objects are flat and fully specified. Reject duplicate, unknown,
// case-aliased and missing keys, nulls, invalid UTF-8, and trailing JSON values.
func strictObject(data []byte, destination interface{}, fields ...string) error {
	if !utf8.Valid(data) {
		return errConfig
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errConfig
	}
	remaining := make(map[string]bool, len(fields))
	for _, field := range fields {
		remaining[field] = true
	}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || !remaining[key] {
			return errConfig
		}
		delete(remaining, key)
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil || strings.TrimSpace(string(raw)) == "null" {
			return errConfig
		}
	}
	if _, err := decoder.Token(); err != nil || len(remaining) != 0 {
		return errConfig
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errConfig
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(destination)
}
