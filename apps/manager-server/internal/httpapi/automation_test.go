package httpapi

import (
	"strings"
	"testing"
)

func TestUpgradeAutomationIsReadOnlyAndReturnsSchedule(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	upgradeWriteJSON(t, root, "status/automation.json", map[string]any{
		"schemaVersion": 1, "enabled": true, "updatedAt": "2026-10-05T00:00:00Z",
		"timezone": "Asia/Shanghai", "nextRunAt": "2026-10-05T05:00:00+08:00",
		"pauseReason": "", "lastResult": nil,
	})
	res := upgradeRequest(t, handler, "GET", "/automation", "", true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"enabled":true`) ||
		!strings.Contains(res.Body.String(), `"nextRunAt":"2026-10-05T05:00:00+08:00"`) {
		t.Fatalf("automation = %d %s", res.Code, res.Body.String())
	}
	res = upgradeRequest(t, handler, "POST", "/automation", "{}", true)
	if res.Code != 405 {
		t.Fatalf("automation mutation = %d", res.Code)
	}
}

func TestUpgradeAutomationDefaultsDisabledWhenExecutorNotInstalled(t *testing.T) {
	t.Setenv("CPA_UPGRADE_DIR", "")
	res := upgradeRequest(t, newTestHandler(t, "", false), "GET", "/automation", "", true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"enabled":false`) {
		t.Fatalf("automation default = %d %s", res.Code, res.Body.String())
	}
}
