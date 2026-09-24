package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

const upgradeTestID = "b6f94706-8d36-4fe1-b5c3-8153e9124ab1"

func upgradeRequest(t *testing.T, handler http.Handler, method, path, body string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/usage-service/upgrades"+path, strings.NewReader(body))
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func upgradeWriteJSON(t *testing.T, root, name string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func upgradeFixture(t *testing.T) (http.Handler, string, map[string]any) {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"catalog", "requests", "status"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CPA_UPGRADE_DIR", root)
	oldID := "sha256:" + strings.Repeat("a", 64)
	release := map[string]any{
		"releaseId": "cli-v7.3.16-custom.1", "component": "cli", "version": "v7.3.16-custom.1",
		"imageTag": "qazwsxedc-coder/cli-proxy-api:v7.3.16-custom.1", "imageId": "sha256:" + strings.Repeat("b", 64),
		"sourceCommit": strings.Repeat("c", 40), "allowedFromImageIds": []string{oldID},
		"rollbackDataCompatible": true, "migrationRequired": false,
		"evidenceFile": "evidence/cli-v7.3.16.json", "evidenceSha256": strings.Repeat("d", 64),
		"validatedAt": time.Now().UTC().Format(time.RFC3339),
	}
	upgradeWriteJSON(t, root, "catalog/releases.json", map[string]any{"schemaVersion": 1, "releases": []any{release}})
	host := map[string]any{
		"schemaVersion": 1, "updatedAt": time.Now().UTC().Format(time.RFC3339), "executorVersion": "1",
		"current": map[string]any{"cli": map[string]any{"version": "v7.3.15-custom.1", "imageId": oldID}, "manager": map[string]any{"version": "v1.13.2-custom.1", "imageId": "sha256:" + strings.Repeat("e", 64)}},
		"latest":  map[string]string{"cli": "v7.3.16", "manager": "v1.13.2"},
	}
	upgradeWriteJSON(t, root, "status/host.json", host)
	return newTestHandler(t, "", false), root, host
}

func upgradeBody(id string) string {
	return fmt.Sprintf(`{"component":"cli","releaseId":"cli-v7.3.16-custom.1","requestId":%q}`, id)
}

func TestUpgradeEndpointsRequireAdminAuthentication(t *testing.T) {
	t.Setenv("CPA_UPGRADE_DIR", "")
	handler := newTestHandler(t, "", false)
	for _, endpoint := range []struct{ method, path string }{{"GET", ""}, {"GET", "/releases"}, {"POST", "/jobs"}, {"GET", "/jobs/current"}, {"GET", "/jobs/" + upgradeTestID}} {
		res := upgradeRequest(t, handler, endpoint.method, endpoint.path, "{}", false)
		if res.Code != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401", endpoint.method, endpoint.path, res.Code)
		}
	}
	res := upgradeRequest(t, handler, "GET", "/releases", "", true)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"enabled":false`) || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("disabled catalog = %d %s", res.Code, res.Body.String())
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled submission = %d", res.Code)
	}
}

func TestUpgradeSubmissionPersistsSingletonAndSurvivesServerRestart(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	res := upgradeRequest(t, handler, "GET", "/releases", "", true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"executorOnline":true`) {
		t.Fatalf("catalog = %d %s", res.Code, res.Body.String())
	}
	res = upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true)
	if res.Code != http.StatusAccepted || !strings.Contains(res.Body.String(), `"state":"queued"`) {
		t.Fatalf("submit = %d %s", res.Code, res.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "requests", "active.json")); err != nil {
		t.Fatal(err)
	}
	restarted := newTestHandler(t, "", false)
	for _, endpoint := range []string{"/jobs/" + upgradeTestID, "/jobs/current"} {
		res := upgradeRequest(t, restarted, "GET", endpoint, "", true)
		if res.Code != 200 || !strings.Contains(res.Body.String(), upgradeTestID) || !strings.Contains(res.Body.String(), `"state":"queued"`) {
			t.Fatalf("recovered %s = %d %s", endpoint, res.Code, res.Body.String())
		}
	}
	res = upgradeRequest(t, restarted, "POST", "/jobs", upgradeBody(upgradeTestID), true)
	if res.Code != 200 {
		t.Fatalf("identical retry = %d %s", res.Code, res.Body.String())
	}
	conflict := upgradeRequest(t, restarted, "POST", "/jobs", upgradeBody("6d706780-8df5-4748-af72-317c4db90c16"), true)
	if conflict.Code != 409 {
		t.Fatalf("other task = %d", conflict.Code)
	}
	changed := strings.Replace(upgradeBody(upgradeTestID), `"cli"`, `"manager"`, 1)
	if res := upgradeRequest(t, restarted, "POST", "/jobs", changed, true); res.Code != 409 {
		t.Fatalf("reused ID with changed payload = %d", res.Code)
	}
}

func TestUpgradeRejectsMalformedAndInjectedRequests(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	for _, body := range []string{
		`{"component":"cli","releaseId":"../../config","requestId":"` + upgradeTestID + `"}`,
		`{"component":"cli;shutdown","releaseId":"cli-v7.3.16-custom.1","requestId":"` + upgradeTestID + `"}`,
		`{"component":"cli","releaseId":"cli-v7.3.16-custom.1","requestId":"../../host"}`,
		strings.TrimSuffix(upgradeBody(upgradeTestID), "}") + `,"command":"docker rm prod"}`,
		upgradeBody(upgradeTestID) + `{}`,
		strings.TrimSuffix(upgradeBody(upgradeTestID), "}") + `,"component":"manager"}`,
		strings.Replace(upgradeBody(upgradeTestID), `"component"`, `"Component"`, 1),
		`null`, `{`, strings.Repeat("x", 5000),
	} {
		if res := upgradeRequest(t, handler, "POST", "/jobs", body, true); res.Code != 400 {
			t.Errorf("malformed request = %d, body %s", res.Code, res.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(root, "requests", "active.json")); !os.IsNotExist(err) {
		t.Fatalf("invalid requests wrote an active job: %v", err)
	}
	res := upgradeRequest(t, handler, "GET", "/jobs/not-a-uuid", "", true)
	if res.Code != 400 {
		t.Fatalf("invalid job path = %d", res.Code)
	}
}

func TestUpgradeStaleWorkerBlocksOnlyNewSubmissions(t *testing.T) {
	handler, root, host := upgradeFixture(t)
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 202 {
		t.Fatal(res.Code)
	}
	host["updatedAt"] = time.Now().Add(-31 * time.Second).UTC().Format(time.RFC3339)
	upgradeWriteJSON(t, root, "status/host.json", host)
	res := upgradeRequest(t, handler, "GET", "/releases", "", true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"executorOnline":false`) || !strings.Contains(res.Body.String(), `"activeJob"`) {
		t.Fatalf("stale status = %d %s", res.Code, res.Body.String())
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 200 {
		t.Fatalf("stale worker lost idempotent job: %d", res.Code)
	}
	if err := os.Remove(filepath.Join(root, "requests", "active.json")); err != nil {
		t.Fatal(err)
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 503 {
		t.Fatalf("stale worker accepted new request: %d", res.Code)
	}
}

func TestUpgradeTerminalAndManualRecoveryStatus(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 202 {
		t.Fatal(res.Code)
	}
	for _, state := range []string{"manual_recovery", "succeeded"} {
		upgradeWriteJSON(t, root, "status/"+upgradeTestID+".json", map[string]any{
			"schemaVersion": 1, "id": upgradeTestID, "component": "cli", "releaseId": "cli-v7.3.16-custom.1",
			"state": state, "step": "checking", "message": "Upgrade status available",
			"createdAt": time.Now().Add(-time.Minute).UTC(), "updatedAt": time.Now().UTC(),
			"oldContainerId": "internal-host-only", "releaseSnapshot": map[string]string{"private": "never-return-this"},
		})
		res := upgradeRequest(t, handler, "GET", "/jobs/"+upgradeTestID, "", true)
		if res.Code != 200 || !strings.Contains(res.Body.String(), `"state":"`+state+`"`) || strings.Contains(res.Body.String(), "never-return-this") || strings.Contains(res.Body.String(), "internal-host-only") {
			t.Fatalf("job projection = %d %s", res.Code, res.Body.String())
		}
		if state == "manual_recovery" {
			if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody("6d706780-8df5-4748-af72-317c4db90c16"), true); res.Code != 409 {
				t.Fatalf("manual recovery did not block new job: %d", res.Code)
			}
		}
	}
	if err := os.Remove(filepath.Join(root, "requests", "active.json")); err != nil {
		t.Fatal(err)
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 200 || !strings.Contains(res.Body.String(), `"state":"succeeded"`) {
		t.Fatalf("completed retry = %d %s", res.Code, res.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "requests", "active.json")); !os.IsNotExist(err) {
		t.Fatalf("retry resubmitted completed job: %v", err)
	}
	changed := strings.Replace(upgradeBody(upgradeTestID), `"cli"`, `"manager"`, 1)
	if res := upgradeRequest(t, handler, "POST", "/jobs", changed, true); res.Code != 409 {
		t.Fatalf("completed ID reused with changed payload: %d", res.Code)
	}
}

func TestUpgradeConcurrentSubmissionsCreateOneJob(t *testing.T) {
	handler, _, _ := upgradeFixture(t)
	var wg sync.WaitGroup
	codes := make(chan int, 12)
	for i := range 12 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
			codes <- upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(id), true).Code
		}(i)
	}
	wg.Wait()
	close(codes)
	accepted := 0
	for code := range codes {
		if code == 202 {
			accepted++
		} else if code != 409 {
			t.Errorf("concurrent submission = %d", code)
		}
	}
	if accepted != 1 {
		t.Fatalf("accepted %d jobs, want 1", accepted)
	}
}

func TestUpgradeCorruptionFailsClosedWithoutLeakingPaths(t *testing.T) {
	for _, file := range []string{"catalog/releases.json", "status/host.json", "requests/active.json"} {
		t.Run(file, func(t *testing.T) {
			handler, root, _ := upgradeFixture(t)
			if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(file)), []byte(`{"private":"never-return-this"`), 0600); err != nil {
				t.Fatal(err)
			}
			for _, method := range []string{"GET", "POST"} {
				path, body := "/releases", ""
				if method == "POST" {
					path, body = "/jobs", upgradeBody(upgradeTestID)
				}
				res := upgradeRequest(t, handler, method, path, body, true)
				if res.Code != 503 || strings.Contains(res.Body.String(), root) || strings.Contains(res.Body.String(), "never-return-this") {
					t.Fatalf("corrupt file = %d %s", res.Code, res.Body.String())
				}
			}
		})
	}
}

func TestUpgradeRejectsSymlinkedProtocolDirectory(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	outside := t.TempDir()
	if err := os.Rename(filepath.Join(root, "catalog"), filepath.Join(outside, "catalog")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "catalog"), filepath.Join(root, "catalog")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if res := upgradeRequest(t, handler, "GET", "/releases", "", true); res.Code != 503 {
		t.Fatalf("symlinked catalog accepted: %d", res.Code)
	}
}

func TestUpgradeCatalogMustBeValidatedFixedVersionMetadata(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown component", func(r map[string]any) { r["component"] = "shell" }},
		{"mutable image", func(r map[string]any) { r["imageTag"] = "qazwsxedc-coder/cli-proxy-api:latest" }},
		{"unbound image", func(r map[string]any) { r["imageId"] = "latest" }},
		{"command injection", func(r map[string]any) { r["imageTag"] = "image:v1;shutdown" }},
		{"evidence traversal", func(r map[string]any) { r["evidenceFile"] = "../outside.json" }},
		{"missing evidence", func(r map[string]any) { delete(r, "evidenceSha256") }},
		{"missing compatibility decision", func(r map[string]any) { delete(r, "rollbackDataCompatible") }},
		{"missing migration decision", func(r map[string]any) { delete(r, "migrationRequired") }},
		{"unknown catalog field", func(r map[string]any) { r["command"] = "docker run arbitrary" }},
		{"wrong image repository", func(r map[string]any) { r["imageTag"] = "someone/cli-proxy-api:v7.3.16-custom.1" }},
		{"image version mismatch", func(r map[string]any) { r["imageTag"] = "qazwsxedc-coder/cli-proxy-api:v7.3.17-custom.1" }},
		{"non-custom release version", func(r map[string]any) { r["version"] = "v7.3.16" }},
		{"uppercase release ID", func(r map[string]any) { r["releaseId"] = "CLI-v7.3.16-custom.1" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, root, _ := upgradeFixture(t)
			data, err := os.ReadFile(filepath.Join(root, "catalog", "releases.json"))
			if err != nil {
				t.Fatal(err)
			}
			var catalog map[string]any
			if err := json.Unmarshal(data, &catalog); err != nil {
				t.Fatal(err)
			}
			tc.change(catalog["releases"].([]any)[0].(map[string]any))
			upgradeWriteJSON(t, root, "catalog/releases.json", catalog)
			if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 503 {
				t.Fatalf("invalid catalog submitted: %d %s", res.Code, res.Body.String())
			}
			if _, err := os.Stat(filepath.Join(root, "requests", "active.json")); !os.IsNotExist(err) {
				t.Fatalf("invalid catalog wrote request: %v", err)
			}
		})
	}
}

func TestUpgradeSubmissionChecksCurrentImageAndReleaseComponent(t *testing.T) {
	handler, root, host := upgradeFixture(t)
	for _, currentID := range []string{"sha256:" + strings.Repeat("f", 64), "sha256:" + strings.Repeat("b", 64)} {
		host["current"].(map[string]any)["cli"].(map[string]any)["imageId"] = currentID
		upgradeWriteJSON(t, root, "status/host.json", host)
		if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 409 {
			t.Fatalf("incompatible/same image accepted: %d", res.Code)
		}
	}
	wrongComponent := strings.Replace(upgradeBody(upgradeTestID), `"cli"`, `"manager"`, 1)
	if res := upgradeRequest(t, handler, "POST", "/jobs", wrongComponent, true); res.Code != 400 {
		t.Fatalf("wrong release component = %d", res.Code)
	}
	missingRelease := strings.Replace(upgradeBody(upgradeTestID), "cli-v7.3.16-custom.1", "not-prepared", 1)
	if res := upgradeRequest(t, handler, "POST", "/jobs", missingRelease, true); res.Code != 404 {
		t.Fatalf("unknown release = %d", res.Code)
	}
}

func TestUpgradeEmptyCatalogDoesNotAdvertiseUpstreamAsPrepared(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	upgradeWriteJSON(t, root, "catalog/releases.json", map[string]any{"schemaVersion": 1, "releases": []any{}})
	res := upgradeRequest(t, handler, "GET", "/releases", "", true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"releases":[]`) || !strings.Contains(res.Body.String(), `"cli":"v7.3.16"`) {
		t.Fatalf("empty prepared catalog = %d %s", res.Code, res.Body.String())
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 404 {
		t.Fatalf("unprepared latest accepted: %d", res.Code)
	}
}

func TestUpgradeMigrationRequiresSeparateMaintenance(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	data, err := os.ReadFile(filepath.Join(root, "catalog", "releases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog map[string]any
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	catalog["releases"].([]any)[0].(map[string]any)["migrationRequired"] = true
	upgradeWriteJSON(t, root, "catalog/releases.json", catalog)
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 409 {
		t.Fatalf("migration release accepted: %d %s", res.Code, res.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "requests", "active.json")); !os.IsNotExist(err) {
		t.Fatalf("migration release wrote request: %v", err)
	}
}

func TestUpgradeJobMissingAndCorruptStatus(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	if res := upgradeRequest(t, handler, "GET", "/jobs/current", "", true); res.Code != 200 || strings.TrimSpace(res.Body.String()) != "null" {
		t.Fatalf("no current job = %d %s", res.Code, res.Body.String())
	}
	if res := upgradeRequest(t, handler, "GET", "/jobs/"+upgradeTestID, "", true); res.Code != 404 {
		t.Fatalf("missing job = %d", res.Code)
	}
	upgradeWriteJSON(t, root, "status/"+upgradeTestID+".json", map[string]any{"schemaVersion": 1, "id": "different-id", "message": "never-return-this"})
	res := upgradeRequest(t, handler, "GET", "/jobs/"+upgradeTestID, "", true)
	if res.Code != 503 || strings.Contains(res.Body.String(), "never-return-this") {
		t.Fatalf("corrupt status = %d %s", res.Code, res.Body.String())
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 503 {
		t.Fatalf("corrupt job ID was reused: %d", res.Code)
	}
}

func TestUpgradeRejectsSymlinkedRequestFileWithoutOverwritingIt(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	outside := filepath.Join(t.TempDir(), "sentinel")
	if err := os.WriteFile(outside, []byte("outside-unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "requests", "active.json")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 503 {
		t.Fatalf("symlinked active file accepted: %d", res.Code)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "outside-unchanged" {
		t.Fatalf("outside file changed: %v", err)
	}
}
