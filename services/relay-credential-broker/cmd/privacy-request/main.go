// privacy-request is an offline operator tool; it is never a public endpoint.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"time"

	"cloud.google.com/go/firestore"
	firebase "firebase.google.com/go/v4"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/privacyrequest"
	"golang.org/x/oauth2"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func main() {
	operation := flag.String("operation", "broker-plan", "broker-plan, broker-apply, push-plan, push-delete, installation-delete")
	scopePath := flag.String("scope", "", "reviewed broker scope JSON path")
	fingerprint := flag.String("fingerprint", "", "reviewed broker plan fingerprint (required to apply)")
	project := flag.String("project", "", "explicit Firebase project")
	caseID := flag.String("case", "", "private case reference")
	verification := flag.String("verification", "", "private ownership verification reference")
	target := flag.String("push-target", "", "exact voltPushTargets document ID")
	updated := flag.String("update-time", "", "reviewed push-plan updateTime, required to delete")
	fid := flag.String("installation", "", "verified Firebase installation ID, never an FCM token")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var result interface{}
	var err error
	if *operation == "broker-plan" || *operation == "broker-apply" {
		result, err = broker(ctx, *operation, *scopePath, *fingerprint)
	} else {
		var options []option.ClientOption
		if token := os.Getenv("VOLT_PRIVACY_ACCESS_TOKEN"); token != "" {
			options = append(options, option.WithTokenSource(oauth2.StaticTokenSource(&oauth2.Token{AccessToken: token})))
		}
		result, err = cloud(ctx, *operation, *project, *caseID, *verification, *target, *updated, *fid, options...)
	}
	if err != nil {
		// Provider/database errors may contain credentials or personal records.
		// No success receipt is emitted on error, including ambiguous commit errors.
		fmt.Fprintln(os.Stderr, "Privacy operation failed; do not mark the case complete. Re-query the affected system before retrying. Check scope, credentials, provider access and the runbook.")
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		os.Exit(1)
	}
}

func broker(ctx context.Context, operation, path, fingerprint string) (interface{}, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var scope privacyrequest.Scope
	decoder := json.NewDecoder(io.LimitReader(file, 128*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&scope); err != nil {
		return nil, err
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("trailing scope data")
	}
	if err := scope.Validate(); err != nil {
		return nil, err
	}
	dsn := os.Getenv("VOLT_PRIVACY_DATABASE_URL")
	if dsn == "" {
		return nil, errors.New("explicit privacy database URL required")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.RuntimeParams["search_path"] = pgx.Identifier{scope.Schema}.Sanitize()
	config.ConnConfig.RuntimeParams["timezone"] = "UTC"
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	defer pool.Close()
	var plan privacyrequest.Plan
	if operation == "broker-plan" {
		plan, err = privacyrequest.Preview(ctx, pool, scope)
	} else {
		plan, err = privacyrequest.Apply(ctx, pool, scope, fingerprint)
	}
	if err != nil {
		return nil, err
	}
	return struct {
		Operation string              `json:"operation"`
		At        time.Time           `json:"at"`
		Plan      privacyrequest.Plan `json:"plan"`
	}{operation, time.Now().UTC(), plan}, nil
}

func cloud(ctx context.Context, operation, project, caseID, verification, target, updated, fid string, options ...option.ClientOption) (interface{}, error) {
	if caseID == "" || verification == "" || !regexp.MustCompile(`^[a-z][a-z0-9-]{4,61}[a-z0-9]$`).MatchString(project) {
		return nil, errors.New("explicit project, case and verification references required")
	}
	if operation != "push-plan" && operation != "push-delete" && operation != "installation-delete" {
		return nil, errors.New("unknown operation")
	}
	if operation == "installation-delete" {
		if !regexp.MustCompile(`^[cdef][A-Za-z0-9_-]{21}$`).MatchString(fid) || target != "" || updated != "" {
			return nil, errors.New("exact current Firebase installation ID required")
		}
	} else if !regexp.MustCompile(`^fcm_[A-Za-z0-9_-]{43}$`).MatchString(target) || fid != "" {
		return nil, errors.New("exact push target document ID required")
	}
	var updateTime time.Time
	if operation == "push-delete" {
		var err error
		updateTime, err = time.Parse(time.RFC3339Nano, updated)
		if err != nil {
			return nil, err
		}
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: project}, options...)
	if err != nil {
		return nil, err
	}
	receipt := map[string]interface{}{"operation": operation, "project": project, "case": caseID, "verification": verification, "at": time.Now().UTC()}
	if operation == "installation-delete" {
		client, err := app.InstanceID(ctx)
		if err != nil {
			return nil, err
		}
		if err := client.DeleteInstanceID(ctx, fid); err != nil {
			return nil, err
		}
		receipt["installation"] = fid
		receipt["status"] = "provider-deletion-request-accepted"
		return receipt, nil
	}
	client, err := app.Firestore(ctx)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	receipt["environment"] = "provider"
	if os.Getenv("FIRESTORE_EMULATOR_HOST") != "" {
		receipt["environment"] = "emulator"
	}
	doc := client.Collection("voltPushTargets").Doc(target)
	receipt["pushTarget"] = target
	if operation == "push-delete" {
		if _, err := doc.Delete(ctx, firestore.LastUpdateTime(updateTime)); err != nil {
			return nil, err
		}
		receipt["status"] = "document-deleted"
		receipt["reviewedUpdateTime"] = updateTime
		return receipt, nil
	}
	snapshot, err := doc.Get(ctx)
	if status.Code(err) == codes.NotFound {
		receipt["status"] = "document-absent"
		return receipt, nil
	}
	if err != nil {
		return nil, err
	}
	receipt["status"] = "review-required"
	receipt["updateTime"] = snapshot.UpdateTime
	// Never output the FCM token or push authorization token/hash.
	data := snapshot.Data()
	for _, field := range []string{"appId", "grantId", "createdAt", "expiresAt", "enabled"} {
		if value, ok := data[field]; ok {
			receipt[field] = value
		}
	}
	return receipt, nil
}
