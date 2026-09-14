//go:build volt_e2e

// This executable replaces only external Apple/Firebase trust boundaries. It
// must never be deployed or compiled into the ordinary credential service.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/database"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/httpapi"
)

func main() {
	// Deliberately discard, rather than inspect, inherited production authority.
	// In particular pgx otherwise reads PG* variables and service-file settings.
	os.Clearenv()
	path := flag.String("config", "", "absolute path to private run-local JSON configuration")
	flag.Parse()
	if *path == "" || flag.NArg() != 0 {
		_, _ = io.WriteString(os.Stderr, "exactly --config <private-file> is required\n")
		os.Exit(2)
	}
	if err := run(*path); err != nil {
		// No database URL, secrets, proof, or request data in startup errors.
		_, _ = io.WriteString(os.Stderr, "E2E credential broker failed: "+err.Error()+"\n")
		os.Exit(1)
	}
}

func run(path string) error {
	c, err := loadConfig(path, time.Now())
	if err != nil {
		return errConfig
	}
	certPEM, err := readPrivateFile(c.CertificatePath, 16*1024)
	if err != nil {
		return errConfig
	}
	keyPEM, err := readPrivateFile(c.CertificateKeyPath, 16*1024)
	if err != nil {
		return errConfig
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return errors.New("invalid run-local TLS certificate")
	}
	signer, err := credential.LoadOrCreateSigner(issuer, audience, c.SigningKeyPath)
	if err != nil {
		return errors.New("cannot load run-local signing key")
	}
	defer signer.Close()

	// Configuration has no arbitrary pgx query options; forbid even the default
	// ~/.pgpass read. main cleared the process environment before reaching here.
	poolConfig, err := pgxpool.ParseConfig(c.DatabaseURL + "&passfile=%2Fdev%2Fnull&connect_timeout=5")
	if err != nil {
		return errConfig
	}
	poolConfig.MaxConns = 8
	poolConfig.ConnConfig.LookupFunc = func(ctx context.Context, host string) ([]string, error) {
		if host == "127.0.0.1" {
			return []string{host}, nil
		}
		if host != "postgres" {
			return nil, errConfig
		}
		addresses, err := net.DefaultResolver.LookupHost(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, errConfig
		}
		for _, address := range addresses {
			ip := net.ParseIP(address)
			if ip == nil || (!ip.IsPrivate() && !ip.IsLoopback()) {
				return nil, errConfig
			}
		}
		return addresses, nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, expire := context.WithDeadline(ctx, time.Unix(c.ExpiresAt, 0))
	defer expire()
	startup, cancelStartup := context.WithTimeout(ctx, 30*time.Second)
	defer cancelStartup()
	pool, err := pgxpool.NewWithConfig(startup, poolConfig)
	if err != nil {
		return errors.New("cannot open isolated PostgreSQL")
	}
	defer pool.Close()
	if pool.Ping(startup) != nil {
		return errors.New("cannot connect to isolated PostgreSQL")
	}
	if database.Migrate(startup, pool) != nil {
		return errors.New("cannot migrate isolated PostgreSQL")
	}
	handler, err := newHandler(c, pool, signer, time.Now)
	if err != nil {
		return errors.New("cannot configure E2E HTTP broker")
	}
	server := &http.Server{
		Addr:              c.ListenAddress,
		Handler:           handler,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}},
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServeTLS("", "") }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if server.Shutdown(shutdown) != nil {
			_ = server.Close()
		}
		<-serverErrors
		return nil
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("E2E TLS listener failed")
		}
		return nil
	}
}

func newHandler(c config, pool *pgxpool.Pool, signer *credential.Signer, now func() time.Time) (http.Handler, error) {
	service, err := broker.New(pool, signer, broker.Config{
		CredentialIssuer:        issuer,
		AttestationVerifier:     syntheticAttestationVerifier{},
		ClaimTTL:                10 * time.Minute,
		AccessTokenTTL:          15 * time.Minute,
		RefreshInactivityTTL:    24 * time.Hour,
		RefreshMinInterval:      5 * time.Second,
		MaxClaims:               100,
		MaxEndpoints:            200,
		MaxAppEndpointsPerGrant: 8,
	}, now)
	if err != nil {
		return nil, err
	}
	verifier := newProofVerifier(c, pool, now)
	handler, err := httpapi.NewServer(service, signer, verifier, verifier, httpapi.Config{
		CredentialIssuer:              issuer,
		MaxConcurrentRequests:         8,
		RefreshMinInterval:            5 * time.Second,
		EntitlementReconcileInterval:  time.Hour,
		MaxBootstrapRequestsPerMinute: 100,
		MaxApprovalRequestsPerMinute:  300,
		MaxExchangeRequestsPerMinute:  300,
		ReadinessCheck:                pool.Ping,
		Now:                           now,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if now().Unix() >= c.ExpiresAt {
			http.Error(w, "E2E run expired", http.StatusServiceUnavailable)
			return
		}
		handler.ServeHTTP(w, r)
	}), nil
}
