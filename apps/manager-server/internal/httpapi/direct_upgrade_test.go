package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpgradeDirectCLIRequiresCapabilityAndExactDetectedVersion(t *testing.T) {
	h, root, host := upgradeFixture(t)
	body := fmt.Sprintf(`{"component":"cli","releaseId":"prepare-cli-v7.3.16","requestId":%q}`, upgradeTestID)
	if r := upgradeRequest(t, h, "POST", "/jobs", body, true); r.Code != 404 {
		t.Fatalf("old executor accepted direct upgrade: %d", r.Code)
	}
	upgradeWriteJSON(t, root, "catalog/capabilities.json", map[string]any{"schemaVersion": 1, "prepareOfficialCLI": true})
	r := upgradeRequest(t, h, "GET", "/releases", "", true)
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"prepareRequired":true`) {
		t.Fatalf("missing offer: %d %s", r.Code, r.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "requests/active.json")); !os.IsNotExist(err) {
		t.Fatal("reading offers submitted a job")
	}
	if r := upgradeRequest(t, h, "POST", "/jobs", body, false); r.Code != 401 {
		t.Fatal("unauthorized submission")
	}
	for _, invalid := range []string{strings.Replace(body, "prepare-cli-v7.3.16", "prepare-cli-v99.0.0", 1), strings.Replace(body, `"cli"`, `"manager"`, 1)} {
		if r := upgradeRequest(t, h, "POST", "/jobs", invalid, true); r.Code < 400 {
			t.Fatal("accepted arbitrary target")
		}
	}
	if r := upgradeRequest(t, h, "POST", "/jobs", body, true); r.Code != 202 {
		t.Fatalf("direct submission: %d %s", r.Code, r.Body.String())
	}
	host["latest"] = map[string]string{"cli": "v7.3.17", "manager": "v1.13.2"}
	upgradeWriteJSON(t, root, "status/host.json", host)
	if r := upgradeRequest(t, h, "POST", "/jobs", body, true); r.Code != 200 {
		t.Fatalf("same target retry: %d", r.Code)
	}
	restarted := newTestHandler(t, "", false)
	if r := upgradeRequest(t, restarted, "GET", "/jobs/current", "", true); r.Code != 200 || !strings.Contains(r.Body.String(), "prepare-cli-v7.3.16") {
		t.Fatal("queued target changed")
	}
}

func TestUpgradeDirectCLICapabilityFailsClosed(t *testing.T) {
	h, root, _ := upgradeFixture(t)
	upgradeWriteJSON(t, root, "catalog/capabilities.json", map[string]any{"schemaVersion": 1, "prepareOfficialCLI": true, "command": "arbitrary"})
	if r := upgradeRequest(t, h, "GET", "/releases", "", true); r.Code != http.StatusServiceUnavailable {
		t.Fatalf("invalid capability: %d", r.Code)
	}
}
