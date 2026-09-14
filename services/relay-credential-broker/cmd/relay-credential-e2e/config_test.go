//go:build volt_e2e

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureConfig(now time.Time) config {
	return config{
		RunID:         strings.Repeat("a", 32),
		ProofSecret:   strings.Repeat("b", 64),
		ExpiresAt:     now.Add(time.Hour).Unix(),
		DatabaseURL:   "postgres://postgres:fixture@127.0.0.1:15433/volt_pairing_e2e?sslmode=disable",
		ListenAddress: "127.0.0.1:18443",
	}
}

func configFile(t *testing.T, mutate func(*config)) (string, config) {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	c := fixtureConfig(time.Now())
	c.SigningKeyPath = filepath.Join(dir, "signing-key")
	c.CertificatePath = filepath.Join(dir, "certificate.pem")
	c.CertificateKeyPath = filepath.Join(dir, "certificate-key.pem")
	for _, path := range []string{c.CertificatePath, c.CertificateKeyPath} {
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if mutate != nil {
		mutate(&c)
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path, c
}

func TestConfigAcceptsOnlyIsolatedAuthority(t *testing.T) {
	for _, address := range []string{"127.0.0.1:18443", "0.0.0.0:18443"} {
		path, _ := configFile(t, func(c *config) { c.ListenAddress = address })
		if _, err := loadConfig(path, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	for name, mutate := range map[string]func(*config){
		"remote": func(c *config) {
			c.DatabaseURL = "postgres://u:p@credentials.volt-cli.dev/volt_pairing_e2e?sslmode=disable"
		},
		"production database":  func(c *config) { c.DatabaseURL = "postgres://u:p@127.0.0.1/volt_credentials?sslmode=disable" },
		"host override":        func(c *config) { c.DatabaseURL += "&host=cloud.example" },
		"service override":     func(c *config) { c.DatabaseURL += "&service=production" },
		"remote listener":      func(c *config) { c.ListenAddress = "192.168.1.2:18443" },
		"http port":            func(c *config) { c.ListenAddress = "127.0.0.1:8085" },
		"expired":              func(c *config) { c.ExpiresAt = time.Now().Unix() },
		"long lifetime":        func(c *config) { c.ExpiresAt = time.Now().Add(3 * time.Hour).Unix() },
		"uppercase run":        func(c *config) { c.RunID = strings.ToUpper(c.RunID) },
		"short secret":         func(c *config) { c.ProofSecret = "ab" },
		"uppercase secret":     func(c *config) { c.ProofSecret = strings.ToUpper(c.ProofSecret) },
		"external signing key": func(c *config) { c.SigningKeyPath = "/tmp/production-key" },
		"aliased files":        func(c *config) { c.SigningKeyPath = c.CertificatePath },
	} {
		t.Run(name, func(t *testing.T) {
			path, _ := configFile(t, mutate)
			if _, err := loadConfig(path, time.Now()); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
}

func TestConfigFileSafeguards(t *testing.T) {
	for _, kind := range []string{"unknown", "issuer", "duplicate", "oversize", "trailing", "mode", "directory mode", "symlink", "asset symlink", "hardlink", "missing field", "null"} {
		t.Run(kind, func(t *testing.T) {
			path, c := configFile(t, nil)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "unknown":
				data = append([]byte(`{"unexpected":true,`), data[1:]...)
			case "issuer":
				data = append([]byte(`{"issuer":"https://credentials.volt-cli.dev",`), data[1:]...)
			case "duplicate":
				data = append([]byte(`{"runId":"`+c.RunID+`",`), data[1:]...)
			case "oversize":
				data = append(data, []byte(strings.Repeat(" ", maxConfigBytes))...)
			case "trailing":
				data = append(data, []byte(`{}`)...)
			case "missing field":
				data = []byte(`{}`)
			case "null":
				data = []byte(strings.Replace(string(data), `"expiresAt":`, `"expiresAt":null,"ignored":`, 1))
			case "mode":
				err = os.Chmod(path, 0644)
			case "directory mode":
				err = os.Chmod(filepath.Dir(path), 0755)
			case "symlink":
				link := filepath.Join(filepath.Dir(path), "link.json")
				err = os.Symlink(path, link)
				path = link
			case "asset symlink":
				err = os.Remove(c.CertificateKeyPath)
				if err == nil {
					err = os.Symlink(c.CertificatePath, c.CertificateKeyPath)
				}
			case "hardlink":
				err = os.Link(path, filepath.Join(filepath.Dir(path), "linked-config"))
			}
			if err != nil {
				t.Fatal(err)
			}
			if kind == "unknown" || kind == "issuer" || kind == "duplicate" || kind == "oversize" || kind == "trailing" || kind == "missing field" || kind == "null" {
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := loadConfig(path, time.Now()); err == nil {
				t.Fatal("unsafe file accepted")
			}
		})
	}
}

func TestDatabaseURLAllowlist(t *testing.T) {
	for _, valid := range []string{
		"postgres://u:p@postgres:5432/volt_pairing_e2e?sslmode=disable",
		"postgresql://u:p@127.0.0.1/volt_pairing_e2e?sslmode=disable",
	} {
		if validateDatabaseURL(valid) != nil {
			t.Fatal("local database rejected")
		}
	}
	for _, invalid := range []string{
		"host=127.0.0.1 dbname=volt_pairing_e2e",
		"postgres://u:p@localhost/volt_pairing_e2e?sslmode=disable",
		"postgres://u:p@127.0.0.1,cloud.example/volt_pairing_e2e?sslmode=disable",
		"postgres://u:p@127.0.0.1/volt_pairing_e2e?sslmode=disable&dbname=production",
		"postgres://u:p@127.0.0.1/volt_pairing_e2e?sslmode=disable#fragment",
		"postgres://u:p@127.0.0.1:0/volt_pairing_e2e?sslmode=disable",
		"postgres://u:p@127.0.0.1:65536/volt_pairing_e2e?sslmode=disable",
		"postgres://u@127.0.0.1/volt_pairing_e2e?sslmode=disable",
		"postgres://u:p@127.0.0.1/volt_pairing_e2e?sslmode=require",
	} {
		if validateDatabaseURL(invalid) == nil {
			t.Fatal("unsafe database accepted")
		}
	}
}
