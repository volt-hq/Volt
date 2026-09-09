package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	firestorepb "cloud.google.com/go/firestore/apiv1/firestorepb"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type firestoreFixture struct {
	firestorepb.UnimplementedFirestoreServer
	mu       sync.Mutex
	document *firestorepb.Document
	deletes  int
}

type installationTransport struct {
	t      *testing.T
	status int
	calls  int
}

func (transport *installationTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.calls++
	if request.Method != http.MethodDelete || request.URL.Host != "console.firebase.google.com" ||
		request.URL.Path != "/v1/project/privacy-fixture/instanceId/c"+strings.Repeat("a", 21) {
		transport.t.Fatalf("unexpected installation deletion destination: %s %s", request.Method, request.URL)
	}
	return &http.Response{StatusCode: transport.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}")), Request: request}, nil
}

func TestRegression349InstallationDeletionReceiptRequiresProviderAcceptance(t *testing.T) {
	for _, statusCode := range []int{http.StatusOK, http.StatusForbidden} {
		transport := &installationTransport{t: t, status: statusCode}
		result, err := cloud(context.Background(), "installation-delete", "privacy-fixture", "case", "verified-fixture", "", "", "c"+strings.Repeat("a", 21), option.WithHTTPClient(&http.Client{Transport: transport}))
		if transport.calls != 1 {
			t.Fatalf("provider calls: %d", transport.calls)
		}
		if statusCode == http.StatusForbidden {
			if err == nil || result != nil {
				t.Fatal("provider rejection produced a receipt")
			}
		} else {
			if err != nil {
				t.Fatal(err)
			}
			if result.(map[string]interface{})["status"] != "provider-deletion-request-accepted" {
				t.Fatal("request acceptance mislabeled as completed deletion")
			}
		}
	}
}

func (f *firestoreFixture) BatchGetDocuments(request *firestorepb.BatchGetDocumentsRequest, stream firestorepb.Firestore_BatchGetDocumentsServer) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, name := range request.Documents {
		response := &firestorepb.BatchGetDocumentsResponse{ReadTime: timestamppb.Now()}
		if f.document == nil || name != f.document.Name {
			response.Result = &firestorepb.BatchGetDocumentsResponse_Missing{Missing: name}
		} else {
			response.Result = &firestorepb.BatchGetDocumentsResponse_Found{Found: proto.Clone(f.document).(*firestorepb.Document)}
		}
		if err := stream.Send(response); err != nil {
			return err
		}
	}
	return nil
}

func (f *firestoreFixture) Commit(_ context.Context, request *firestorepb.CommitRequest) (*firestorepb.CommitResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(request.Writes) != 1 {
		return nil, status.Error(codes.InvalidArgument, "expected one deletion")
	}
	write := request.Writes[0]
	if f.document == nil || write.GetDelete() != f.document.Name {
		return nil, status.Error(codes.NotFound, "absent")
	}
	if write.CurrentDocument == nil || !proto.Equal(write.CurrentDocument.GetUpdateTime(), f.document.UpdateTime) {
		return nil, status.Error(codes.FailedPrecondition, "changed")
	}
	f.document = nil
	f.deletes++
	return &firestorepb.CommitResponse{CommitTime: timestamppb.Now(), WriteResults: []*firestorepb.WriteResult{{UpdateTime: timestamppb.Now()}}}, nil
}

// Regression: #349. Exercise the actual Firebase/Firestore SDK against a local
// protocol fixture, including the update-time precondition sent to the server.
func TestRegression349PushDeletionUsesReviewedVersion(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	target := "fcm_" + strings.Repeat("a", 43)
	updated := time.Date(2026, 9, 9, 12, 0, 0, 123456000, time.UTC)
	fixture := &firestoreFixture{document: &firestorepb.Document{
		Name:       "projects/privacy-fixture/databases/(default)/documents/voltPushTargets/" + target,
		CreateTime: timestamppb.New(updated.Add(-time.Hour)),
		UpdateTime: timestamppb.New(updated),
		Fields: map[string]*firestorepb.Value{
			"appId":                   {ValueType: &firestorepb.Value_StringValue{StringValue: "app"}},
			"grantId":                 {ValueType: &firestorepb.Value_StringValue{StringValue: "grant"}},
			"token":                   {ValueType: &firestorepb.Value_StringValue{StringValue: "must-not-export"}},
			"pushTargetAuthTokenHash": {ValueType: &firestorepb.Value_StringValue{StringValue: "must-not-export-either"}},
		},
	}}
	firestorepb.RegisterFirestoreServer(server, fixture)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	t.Setenv("FIRESTORE_EMULATOR_HOST", listener.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := cloud(ctx, "push-plan", "privacy-fixture", "case", "verified-fixture", target, "", "")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "must-not-export") {
		t.Fatal("plan leaked push credentials")
	}
	if _, err := cloud(ctx, "push-delete", "privacy-fixture", "case", "verified-fixture", target, updated.Add(-time.Second).Format(time.RFC3339Nano), ""); err == nil {
		t.Fatal("stale update time accepted")
	}
	if _, err := cloud(ctx, "push-delete", "privacy-fixture", "case", "verified-fixture", target, updated.Format(time.RFC3339Nano), ""); err != nil {
		t.Fatal(err)
	}
	result, err = cloud(ctx, "push-plan", "privacy-fixture", "case", "verified-fixture", target, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]interface{})["status"] != "document-absent" {
		t.Fatal("deletion not verified absent")
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.deletes != 1 {
		t.Fatalf("deletions: %d", fixture.deletes)
	}
}

func TestRegression349RejectUnsafeCloudInputsBeforeConnecting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, input := range []struct{ operation, project, caseID, verification, target, updated, fid string }{
		{"installation-delete", "privacy-fixture", "case", "verified", "", "", "an-fcm-token:wrong"},
		{"installation-delete", "privacy-fixture", "case", "", "", "", "c" + strings.Repeat("a", 21)},
		{"push-delete", "privacy-fixture", "case", "verified", "../../other/collection", "", ""},
		{"push-delete", "privacy-fixture", "case", "verified", "fcm_" + strings.Repeat("a", 43), "", ""},
	} {
		if _, err := cloud(ctx, input.operation, input.project, input.caseID, input.verification, input.target, input.updated, input.fid); err == nil {
			t.Fatalf("unsafe input accepted: %s", input.operation)
		}
	}
}
