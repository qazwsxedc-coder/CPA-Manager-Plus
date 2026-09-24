package httpapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func checkBody(id string) string { return fmt.Sprintf(`{"requestId":%q}`, id) }

func checkStatus(id, state string) map[string]any {
	return map[string]any{"schemaVersion": 1, "id": id, "state": state,
		"createdAt": time.Now().Add(-time.Second).UTC(), "updatedAt": time.Now().UTC(), "message": "Version check complete"}
}

func TestUpgradeChecksRequireAdminAndReadsNeverEnqueue(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	for _, endpoint := range []struct{ method, path string }{{"POST", "/checks"}, {"GET", "/checks/current"}} {
		res := upgradeRequest(t, handler, endpoint.method, endpoint.path, checkBody(upgradeTestID), false)
		if res.Code != 401 {
			t.Fatalf("unauthenticated %s = %d", endpoint.path, res.Code)
		}
	}
	for range 3 {
		res := upgradeRequest(t, handler, "GET", "/checks/current", "", true)
		if res.Code != 200 || strings.TrimSpace(res.Body.String()) != "null" || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("empty check status = %d %s", res.Code, res.Body.String())
		}
		if res := upgradeRequest(t, handler, "GET", "/releases", "", true); res.Code != 200 {
			t.Fatal(res.Code)
		}
	}
	files, err := os.ReadDir(filepath.Join(root, "requests"))
	if err != nil || len(files) != 0 {
		t.Fatalf("reads created requests: %v %v", files, err)
	}
}

func TestUpgradeChecksPersistDeduplicateAndSurviveRestart(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	res := upgradeRequest(t, handler, "POST", "/checks", checkBody(upgradeTestID), true)
	if res.Code != 202 || !strings.Contains(res.Body.String(), `"state":"queued"`) {
		t.Fatalf("submit = %d %s", res.Code, res.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(root, "requests", "check.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted map[string]any
	if err := json.Unmarshal(data, &persisted); err != nil || len(persisted) != 3 || persisted["id"] != upgradeTestID || persisted["schemaVersion"] != float64(1) || persisted["createdAt"] == nil {
		t.Fatalf("unexpected host request: %s %v", data, err)
	}
	restarted := newTestHandler(t, "", false)
	for _, endpoint := range []struct{ method, path string }{{"POST", "/checks"}, {"GET", "/checks/current"}} {
		res := upgradeRequest(t, restarted, endpoint.method, endpoint.path, checkBody(upgradeTestID), true)
		if res.Code != 200 || !strings.Contains(res.Body.String(), `"state":"queued"`) {
			t.Fatalf("retry/restart = %d %s", res.Code, res.Body.String())
		}
	}
	if res := upgradeRequest(t, restarted, "POST", "/checks", checkBody("6d706780-8df5-4748-af72-317c4db90c16"), true); res.Code != 409 {
		t.Fatalf("duplicate click = %d", res.Code)
	}
	for _, state := range []string{"running", "succeeded", "failed"} {
		upgradeWriteJSON(t, root, "status/check.json", checkStatus(upgradeTestID, state))
		res := upgradeRequest(t, restarted, "GET", "/checks/current", "", true)
		if res.Code != 200 || !strings.Contains(res.Body.String(), `"state":"`+state+`"`) {
			t.Fatalf("status = %d %s", res.Code, res.Body.String())
		}
	}
	if err := os.Remove(filepath.Join(root, "requests", "check.json")); err != nil {
		t.Fatal(err)
	}
	res = upgradeRequest(t, restarted, "POST", "/checks", checkBody(upgradeTestID), true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"state":"failed"`) {
		t.Fatalf("terminal retry = %d %s", res.Code, res.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "requests", "check.json")); !os.IsNotExist(err) {
		t.Fatalf("terminal retry queued: %v", err)
	}
	res = upgradeRequest(t, restarted, "POST", "/checks", checkBody("6d706780-8df5-4748-af72-317c4db90c16"), true)
	if res.Code != 202 || !strings.Contains(res.Body.String(), `"state":"queued"`) {
		t.Fatalf("new check = %d %s", res.Code, res.Body.String())
	}
	res = upgradeRequest(t, restarted, "GET", "/checks/current", "", true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"state":"queued"`) {
		t.Fatalf("old status hid new request: %d %s", res.Code, res.Body.String())
	}
}

func TestUpgradeChecksRejectUntrustedInputs(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	for _, body := range []string{`null`, `{}`, `{`, `{"requestId":null}`, `{"requestId":1}`, `{"requestId":"../../host"}`,
		`{"RequestId":"` + upgradeTestID + `"}`, checkBody(upgradeTestID) + `{}`,
		`{"requestId":"` + upgradeTestID + `","requestId":"` + upgradeTestID + `"}`,
		`{"requestId":"` + upgradeTestID + `","repository":"evil/repo"}`,
		`{"requestId":"` + upgradeTestID + `","command":"docker rm prod"}`, strings.Repeat("x", 5000)} {
		if res := upgradeRequest(t, handler, "POST", "/checks", body, true); res.Code != 400 {
			t.Fatalf("invalid input accepted: %d %s", res.Code, res.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(root, "requests", "check.json")); !os.IsNotExist(err) {
		t.Fatalf("invalid input queued: %v", err)
	}
}

func TestUpgradeChecksBlockOfflineHostAndActiveUpgrade(t *testing.T) {
	for _, mode := range []string{"offline", "upgrade"} {
		t.Run(mode, func(t *testing.T) {
			handler, root, host := upgradeFixture(t)
			want := 409
			if mode == "offline" {
				host["updatedAt"] = time.Now().Add(-time.Minute).UTC()
				upgradeWriteJSON(t, root, "status/host.json", host)
				want = 503
			} else if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 202 {
				t.Fatal(res.Code)
			}
			res := upgradeRequest(t, handler, "POST", "/checks", checkBody(upgradeTestID), true)
			if res.Code != want {
				t.Fatalf("blocked check = %d want %d", res.Code, want)
			}
			if _, err := os.Stat(filepath.Join(root, "requests", "check.json")); !os.IsNotExist(err) {
				t.Fatalf("blocked check queued: %v", err)
			}
		})
	}
}

func TestUpgradeChecksPendingRequestBlocksUpgrade(t *testing.T) {
	handler, _, _ := upgradeFixture(t)
	if res := upgradeRequest(t, handler, "POST", "/checks", checkBody(upgradeTestID), true); res.Code != 202 {
		t.Fatal(res.Code)
	}
	if res := upgradeRequest(t, handler, "POST", "/jobs", upgradeBody(upgradeTestID), true); res.Code != 409 {
		t.Fatalf("upgrade accepted during check: %d", res.Code)
	}
}

func TestUpgradeChecksConcurrentClicksCreateOneRequest(t *testing.T) {
	handler, _, _ := upgradeFixture(t)
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes <- upgradeRequest(t, handler, "POST", "/checks", checkBody(fmt.Sprintf("00000000-0000-4000-8000-%012d", i)), true).Code
		}(i)
	}
	wg.Wait()
	close(codes)
	accepted := 0
	for code := range codes {
		if code == 202 {
			accepted++
		} else if code != 409 {
			t.Errorf("concurrent click = %d", code)
		}
	}
	if accepted != 1 {
		t.Fatalf("created %d checks", accepted)
	}
}

func TestUpgradeChecksFailClosedOnCorruptOrSymlinkedFiles(t *testing.T) {
	for _, file := range []string{"requests/check.json", "status/check.json"} {
		for _, mode := range []string{"corrupt", "symlink"} {
			t.Run(file+"/"+mode, func(t *testing.T) {
				handler, root, _ := upgradeFixture(t)
				outside := filepath.Join(t.TempDir(), "sentinel")
				if err := os.WriteFile(outside, []byte("never-return-this"), 0600); err != nil {
					t.Fatal(err)
				}
				if mode == "corrupt" {
					upgradeWriteJSON(t, root, file, map[string]string{"private": "never-return-this"})
				} else if err := os.Symlink(outside, filepath.Join(root, filepath.FromSlash(file))); err != nil {
					t.Skipf("symlink creation unavailable: %v", err)
				}
				for _, endpoint := range []struct{ method, path string }{{"POST", "/checks"}, {"GET", "/checks/current"}} {
					res := upgradeRequest(t, handler, endpoint.method, endpoint.path, checkBody(upgradeTestID), true)
					if res.Code != 503 || strings.Contains(res.Body.String(), "never-return-this") || strings.Contains(res.Body.String(), root) {
						t.Fatalf("untrusted file = %d %s", res.Code, res.Body.String())
					}
				}
				data, err := os.ReadFile(outside)
				if err != nil || string(data) != "never-return-this" {
					t.Fatalf("outside file changed: %v", err)
				}
			})
		}
	}
}
