package codexnativespeed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func bridgeFixture(t *testing.T) (*Service, string, time.Time) {
	t.Helper()
	root := t.TempDir()
	for _, name := range []string{"catalog", "requests", "status"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	for name, value := range map[string]any{
		"catalog/" + fileName: heartbeat{SchemaVersion: 1, UpdatedAt: now},
		"status/" + fileName:  status{SchemaVersion: 1, Mode: ptr(ModeStandard), State: "ready", UpdatedAt: now},
	} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return New(root), root, now
}

func TestConcurrentNativeSpeedRequestsPublishOneCompleteLatestIntent(t *testing.T) {
	service, root, now := bridgeFixture(t)
	var group sync.WaitGroup
	var resultsMu sync.Mutex
	var results []Result
	for i := range 24 {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			mode := "fast"
			if i%2 == 1 {
				mode = "standard"
			}
			result, err := service.Put([]byte(`{"mode":"`+mode+`"}`), now)
			if err != nil {
				t.Errorf("parallel request: %v", err)
				return
			}
			resultsMu.Lock()
			results = append(results, result)
			resultsMu.Unlock()
		}(i)
	}
	group.Wait()
	data, err := os.ReadFile(filepath.Join(root, "requests", fileName))
	if err != nil {
		t.Fatal(err)
	}
	var req request
	if err := json.Unmarshal(data, &req); err != nil || !validRequest(&req) {
		t.Fatalf("torn request: %s (%v)", data, err)
	}
	if len(results) != 24 {
		t.Fatalf("only %d requests succeeded", len(results))
	}
	known := false
	for _, result := range results {
		if result.RequestID != nil && *result.RequestID == req.RequestID {
			known = true
		}
	}
	if !known {
		t.Fatal("persisted request ID was never accepted")
	}
	result := service.Get(now)
	if result.State != "pending" || result.RequestID == nil || *result.RequestID != req.RequestID {
		t.Fatalf("current result = %#v", result)
	}
	files, err := os.ReadDir(filepath.Join(root, "requests"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Name() != fileName {
		t.Fatalf("temporary requests remain: %v", files)
	}
}

func TestNativeSpeedPreservesPriorRequestOnInvalidInput(t *testing.T) {
	service, root, now := bridgeFixture(t)
	if _, err := service.Put([]byte(`{"mode":"fast"}`), now); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "requests", fileName)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Put([]byte(`{"mode":"fast","command":"write secret"}`), now); err != ErrInvalid {
		t.Fatalf("invalid request = %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("invalid input replaced existing request")
	}
	if strings.Contains(string(after), "secret") {
		t.Fatal("unvalidated request field persisted")
	}
}

func TestNativeSpeedMissingAndOversizedStatusCannotBeReportedAsApplied(t *testing.T) {
	service, root, now := bridgeFixture(t)
	path := filepath.Join(root, "status", fileName)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	result := service.Get(now)
	if result.State == "applied" || result.Mode != nil {
		t.Fatalf("missing status = %#v", result)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat(" ", maxFileBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	result = service.Get(now)
	if result.Available {
		t.Fatalf("oversized status = %#v", result)
	}
}
