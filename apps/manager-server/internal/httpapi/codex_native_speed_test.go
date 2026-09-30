package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

const nativeSpeedPath = "/usage-service/codex-native-speed"
const nativeSpeedFile = "codex-native-speed.json"

func nativeSpeedRequest(t *testing.T, handler http.Handler, method, body string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, nativeSpeedPath, strings.NewReader(body))
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func nativeSpeedFixture(t *testing.T) (http.Handler, string) {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"catalog", "requests", "status"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CPA_CODEX_NATIVE_SPEED_DIR", root)
	nativeSpeedHeartbeat(t, root, time.Now().UTC())
	nativeSpeedStatus(t, root, nil, "standard", "ready", nil)
	return newTestHandler(t, "", false), root
}

func nativeSpeedHeartbeat(t *testing.T, root string, updatedAt time.Time) {
	t.Helper()
	upgradeWriteJSON(t, root, "catalog/"+nativeSpeedFile, map[string]any{
		"schemaVersion": 1, "updatedAt": updatedAt.Format(time.RFC3339Nano),
	})
}

func nativeSpeedStatus(t *testing.T, root string, id any, mode, state string, code any) {
	t.Helper()
	upgradeWriteJSON(t, root, "status/"+nativeSpeedFile, map[string]any{
		"schemaVersion": 1, "requestId": id, "mode": mode, "state": state, "code": code,
		"updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func nativeSpeedResult(t *testing.T, res *httptest.ResponseRecorder, wantStatus int) map[string]any {
	t.Helper()
	if res.Code != wantStatus {
		t.Fatalf("response = %d %s, want %d", res.Code, res.Body.String(), wantStatus)
	}
	if res.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("native speed response must not be cached")
	}
	var result map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 6 {
		t.Fatalf("unexpected public fields: %s", res.Body.String())
	}
	return result
}

func TestCodexNativeSpeedRequiresAdminAndExplicitOptIn(t *testing.T) {
	t.Setenv("CPA_CODEX_NATIVE_SPEED_DIR", "")
	handler := newTestHandler(t, "", false)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		res := nativeSpeedRequest(t, handler, method, `{"mode":"fast"}`, false)
		if res.Code != http.StatusUnauthorized || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unauthenticated %s = %d %s", method, res.Code, res.Body.String())
		}
	}
	result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if result["available"] != false || result["mode"] != nil || result["requestId"] != nil {
		t.Fatalf("disabled result = %#v", result)
	}
	if res := nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled mutation = %d %s", res.Code, res.Body.String())
	}
}

func TestCodexNativeSpeedPublishesLatestRequestAndConfirmsMatchingHostReadback(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	initial := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if initial["available"] != true || initial["mode"] != "standard" || initial["state"] != "ready" {
		t.Fatalf("initial result = %#v", initial)
	}
	first := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true), http.StatusAccepted)
	if first["state"] != "pending" || first["mode"] != "standard" || first["requestId"] == nil {
		t.Fatalf("pending result = %#v", first)
	}
	requestBytes, err := os.ReadFile(filepath.Join(root, "requests", nativeSpeedFile))
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(requestBytes, &request); err != nil {
		t.Fatal(err)
	}
	if len(request) != 4 || request["mode"] != "fast" || request["requestId"] != first["requestId"] || request["schemaVersion"] != float64(1) {
		t.Fatalf("request = %s", requestBytes)
	}
	if _, err := time.Parse(time.RFC3339Nano, request["createdAt"].(string)); err != nil {
		t.Fatal(err)
	}
	// A late result for an older request cannot confirm the latest click.
	second := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"standard"}`, true), http.StatusAccepted)
	if first["requestId"] == second["requestId"] {
		t.Fatal("new request must have a distinct server-generated ID")
	}
	nativeSpeedStatus(t, root, first["requestId"], "fast", "applied", nil)
	stale := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if stale["state"] != "pending" || stale["requestId"] != second["requestId"] {
		t.Fatalf("old result confirmed new request: %#v", stale)
	}
	nativeSpeedStatus(t, root, second["requestId"], "standard", "applied", nil)
	restarted := newTestHandler(t, "", false)
	confirmed := nativeSpeedResult(t, nativeSpeedRequest(t, restarted, http.MethodGet, "", true), http.StatusOK)
	if confirmed["state"] != "applied" || confirmed["mode"] != "standard" || confirmed["requestId"] != second["requestId"] {
		t.Fatalf("readback = %#v", confirmed)
	}
	files, err := os.ReadDir(filepath.Join(root, "requests"))
	if err != nil || len(files) != 1 || files[0].Name() != nativeSpeedFile {
		t.Fatalf("publication left extra files: %#v %v", files, err)
	}
}

func TestCodexNativeSpeedRejectsInvalidBodiesWithoutPublishing(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	for _, body := range []string{
		`{}`, `{"mode":"priority"}`, `{"mode":"FAST"}`, `{"Mode":"fast"}`, `{"mode":null}`,
		`{"mode":"fast","path":"C:/secret/config.toml"}`, `{"mode":"fast","requestId":"external"}`,
		`{"mode":"fast","createdAt":"2026-01-01T00:00:00Z"}`, `{"mode":"fast","mode":"standard"}`,
		`{"mode":"fast"} {}`, `[]`, strings.Repeat(" ", 4097) + `{"mode":"fast"}`,
	} {
		res := nativeSpeedRequest(t, handler, http.MethodPut, body, true)
		if res.Code != http.StatusBadRequest {
			t.Errorf("body %q = %d %s", body[:min(len(body), 100)], res.Code, res.Body.String())
		}
	}
	if _, err := os.Lstat(filepath.Join(root, "requests", nativeSpeedFile)); !os.IsNotExist(err) {
		t.Fatalf("invalid request was published: %v", err)
	}
}

func TestCodexNativeSpeedOfflineHostRejectsMutationAndHidesBridgePath(t *testing.T) {
	for _, heartbeat := range []time.Time{time.Now().UTC().Add(-16 * time.Second), time.Now().UTC().Add(time.Minute)} {
		t.Run(heartbeat.Format(time.RFC3339Nano), func(t *testing.T) {
			handler, root := nativeSpeedFixture(t)
			nativeSpeedHeartbeat(t, root, heartbeat)
			result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
			if result["available"] != false || result["mode"] != nil {
				t.Fatalf("offline host result = %#v", result)
			}
			res := nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true)
			if res.Code != http.StatusServiceUnavailable || strings.Contains(res.Body.String(), root) {
				t.Fatalf("offline mutation = %d %s", res.Code, res.Body.String())
			}
			if _, err := os.Lstat(filepath.Join(root, "requests", nativeSpeedFile)); !os.IsNotExist(err) {
				t.Fatal("offline host accepted a request")
			}
		})
	}
}

func TestCodexNativeSpeedRejectsMalformedOrUnsafeHostFiles(t *testing.T) {
	for _, body := range []string{
		`{"schemaVersion":1,"updatedAt":"bad"}`,
		`{"schemaVersion":1,"schemaVersion":1,"updatedAt":"2026-09-30T00:00:00Z"}`,
		strings.Repeat(" ", 65537),
	} {
		handler, root := nativeSpeedFixture(t)
		if err := os.WriteFile(filepath.Join(root, "catalog", nativeSpeedFile), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
		if result["available"] != false {
			t.Fatalf("unsafe host is available: %#v", result)
		}
	}
	handler, root := nativeSpeedFixture(t)
	path := filepath.Join(root, "catalog", nativeSpeedFile)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if result["available"] != false {
		t.Fatal("directory was accepted as a heartbeat file")
	}
}

func TestCodexNativeSpeedNeverConfirmsWrongModeOrExpiredRequest(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	pending := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true), http.StatusAccepted)
	nativeSpeedStatus(t, root, pending["requestId"], "standard", "applied", nil)
	wrong := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if wrong["state"] == "applied" {
		t.Fatalf("wrong mode confirmed: %#v", wrong)
	}
	upgradeWriteJSON(t, root, "requests/"+nativeSpeedFile, map[string]any{
		"schemaVersion": 1, "requestId": pending["requestId"], "mode": "fast",
		"createdAt": time.Now().UTC().Add(-3 * time.Minute).Format(time.RFC3339Nano),
	})
	expired := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if expired["state"] != "error" || expired["code"] != "native_request_expired" {
		t.Fatalf("expired result = %#v", expired)
	}
}

func TestCodexNativeSpeedHostErrorIsBoundedAndCannotEchoSecrets(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	pending := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true), http.StatusAccepted)
	nativeSpeedStatus(t, root, pending["requestId"], "standard", "error", "native_config_changed")
	failed := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if failed["state"] != "error" || failed["code"] != "native_config_changed" {
		t.Fatalf("safe error result = %#v", failed)
	}
	nativeSpeedStatus(t, root, pending["requestId"], "standard", "error", "secret-value-from-config")
	res := nativeSpeedRequest(t, handler, http.MethodGet, "", true)
	if strings.Contains(res.Body.String(), "secret-value") || strings.Contains(res.Body.String(), root) {
		t.Fatalf("host error leaked: %s", res.Body.String())
	}
	if result := nativeSpeedResult(t, res, http.StatusOK); result["available"] != false {
		t.Fatalf("invalid host error accepted: %#v", result)
	}
}

func TestCodexNativeSpeedShowsUnknownAndStartupErrorsWithoutInventingConfirmation(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	for _, state := range []string{"ready", "error"} {
		var code any
		if state == "error" {
			code = "native_config_invalid"
		}
		upgradeWriteJSON(t, root, "status/"+nativeSpeedFile, map[string]any{
			"schemaVersion": 1, "requestId": nil, "mode": nil, "state": state, "code": code,
			"updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
		})
		result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
		if result["available"] != true || result["mode"] != nil || result["requestId"] != nil || result["state"] != state || result["code"] != code {
			t.Fatalf("startup state = %#v", result)
		}
	}
	result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true), http.StatusAccepted)
	if result["state"] != "pending" || result["mode"] != nil || result["code"] != nil {
		t.Fatalf("recovery request = %#v", result)
	}
}

func TestCodexNativeSpeedRejectsOldStatusAndFutureRequest(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	upgradeWriteJSON(t, root, "status/"+nativeSpeedFile, map[string]any{
		"schemaVersion": 1, "requestId": nil, "mode": "standard", "state": "ready", "code": nil,
		"updatedAt": time.Now().UTC().Add(-16 * time.Second).Format(time.RFC3339Nano),
	})
	result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if result["available"] != false || result["mode"] != nil {
		t.Fatalf("old status = %#v", result)
	}
	nativeSpeedStatus(t, root, nil, "standard", "ready", nil)
	upgradeWriteJSON(t, root, "requests/"+nativeSpeedFile, map[string]any{
		"schemaVersion": 1, "requestId": upgradeTestID, "mode": "fast",
		"createdAt": time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano),
	})
	result = nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if result["available"] != false || result["code"] != "native_request_invalid" {
		t.Fatalf("future request = %#v", result)
	}
}

func TestCodexNativeSpeedRetainsConfirmedReceiptBeyondRequestTTL(t *testing.T) {
	handler, root := nativeSpeedFixture(t)
	upgradeWriteJSON(t, root, "requests/"+nativeSpeedFile, map[string]any{
		"schemaVersion": 1, "requestId": upgradeTestID, "mode": "fast",
		"createdAt": time.Now().UTC().Add(-3 * time.Minute).Format(time.RFC3339Nano),
	})
	nativeSpeedStatus(t, root, upgradeTestID, "fast", "applied", nil)
	result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
	if result["state"] != "applied" || result["mode"] != "fast" || result["code"] != nil {
		t.Fatalf("confirmed receipt expired: %#v", result)
	}
}

func TestCodexNativeSpeedRejectsFileAndDirectorySymlinks(t *testing.T) {
	for _, target := range []string{"file", "directory"} {
		t.Run(target, func(t *testing.T) {
			handler, root := nativeSpeedFixture(t)
			outside := t.TempDir()
			path := filepath.Join(root, "catalog", nativeSpeedFile)
			if target == "directory" {
				path = filepath.Join(root, "requests")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			} else {
				outside = filepath.Join(outside, nativeSpeedFile)
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(outside, data, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			}
			result := nativeSpeedResult(t, nativeSpeedRequest(t, handler, http.MethodGet, "", true), http.StatusOK)
			if result["available"] != false {
				t.Fatalf("symlink bridge accepted: %#v", result)
			}
			if res := nativeSpeedRequest(t, handler, http.MethodPut, `{"mode":"fast"}`, true); res.Code != http.StatusServiceUnavailable {
				t.Fatalf("symlink mutation = %d %s", res.Code, res.Body.String())
			}
		})
	}
}
