package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func upgradeChangeRelease(t *testing.T, root string, change func(map[string]any)) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "catalog", "releases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog map[string]any
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	release := catalog["releases"].([]any)[0].(map[string]any)
	change(release)
	upgradeWriteJSON(t, root, "catalog/releases.json", catalog)
	return release
}

func officialUpgradeRelease(r map[string]any) {
	r["version"] = "v7.3.16"
	r["imageSource"] = "official"
	r["imageTag"] = "eceasy/cli-proxy-api:v7.3.16"
	// A registry manifest digest is distinct from the local image content ID.
	r["imageDigest"] = "eceasy/cli-proxy-api@sha256:" + strings.Repeat("d", 64)
	r["migrationMode"] = "none"
}

func additiveManagerRelease(r map[string]any) {
	r["component"] = "manager"
	r["version"] = "v1.13.3-custom.1"
	r["imageTag"] = "qazwsxedc-coder/cpa-manager-plus:v1.13.3-custom.1"
	r["allowedFromImageIds"] = []string{"sha256:" + strings.Repeat("e", 64)}
	r["migrationRequired"] = true
	r["migrationMode"] = "automatic-additive"
	r["rollbackDataCompatible"] = false
}

func TestUpgradeProtocolAcceptsOfficialCLIAndAdditiveManager(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"legacy custom", func(map[string]any) {}},
		{"explicit custom", func(r map[string]any) { r["imageSource"] = "custom"; r["migrationMode"] = "none" }},
		{"official cli", officialUpgradeRelease},
		{"additive manager", additiveManagerRelease},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, root, _ := upgradeFixture(t)
			release := upgradeChangeRelease(t, root, tc.change)
			res := upgradeRequest(t, handler, "GET", "/releases", "", true)
			if res.Code != 200 {
				t.Fatalf("valid catalog rejected: %d %s", res.Code, res.Body.String())
			}
			for _, field := range []string{"imageSource", "imageDigest", "migrationMode"} {
				if value, ok := release[field].(string); ok && !strings.Contains(res.Body.String(), `"`+field+`":"`+value+`"`) {
					t.Fatalf("catalog omitted %s", field)
				}
			}
			body, _ := json.Marshal(map[string]any{"component": release["component"], "releaseId": release["releaseId"], "requestId": upgradeTestID})
			res = upgradeRequest(t, handler, "POST", "/jobs", string(body), true)
			if res.Code != 202 {
				t.Fatalf("prepared release rejected: %d %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestUpgradeProtocolRejectsUntrustedSourcesAndUnsafeMigrationClaims(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown source", func(r map[string]any) { r["imageSource"] = "registry" }},
		{"null source", func(r map[string]any) { r["imageSource"] = nil }},
		{"empty source", func(r map[string]any) { r["imageSource"] = "" }},
		{"null digest", func(r map[string]any) { r["imageDigest"] = nil }},
		{"empty digest", func(r map[string]any) { r["imageDigest"] = "" }},
		{"null migration mode", func(r map[string]any) { r["migrationMode"] = nil }},
		{"empty migration mode", func(r map[string]any) { r["migrationMode"] = "" }},
		{"official manager", func(r map[string]any) { officialUpgradeRelease(r); r["component"] = "manager" }},
		{"official custom suffix", func(r map[string]any) {
			officialUpgradeRelease(r)
			r["version"] = "v7.3.16-custom.1"
			r["imageTag"] = "eceasy/cli-proxy-api:v7.3.16-custom.1"
		}},
		{"official missing digest", func(r map[string]any) { officialUpgradeRelease(r); delete(r, "imageDigest") }},
		{"official mutable tag", func(r map[string]any) { officialUpgradeRelease(r); r["imageTag"] = "eceasy/cli-proxy-api:latest" }},
		{"official other tag repository", func(r map[string]any) { officialUpgradeRelease(r); r["imageTag"] = "other/cli-proxy-api:v7.3.16" }},
		{"official other digest repository", func(r map[string]any) {
			officialUpgradeRelease(r)
			r["imageDigest"] = "other/cli-proxy-api@sha256:" + strings.Repeat("d", 64)
		}},
		{"official invalid digest", func(r map[string]any) {
			officialUpgradeRelease(r)
			r["imageDigest"] = "eceasy/cli-proxy-api@sha256:latest"
		}},
		{"custom cannot borrow official digest", func(r map[string]any) { r["imageDigest"] = "eceasy/cli-proxy-api@sha256:" + strings.Repeat("d", 64) }},
		{"unknown migration mode", func(r map[string]any) { r["migrationMode"] = "run-script" }},
		{"cli cannot migrate", func(r map[string]any) {
			r["migrationRequired"] = true
			r["migrationMode"] = "automatic-additive"
			r["rollbackDataCompatible"] = false
		}},
		{"automatic requires migration declaration", func(r map[string]any) { additiveManagerRelease(r); r["migrationRequired"] = false }},
		{"automatic cannot promise data rollback", func(r map[string]any) { additiveManagerRelease(r); r["rollbackDataCompatible"] = true }},
		{"none cannot migrate", func(r map[string]any) { additiveManagerRelease(r); r["migrationMode"] = "none" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, root, _ := upgradeFixture(t)
			release := upgradeChangeRelease(t, root, tc.change)
			if res := upgradeRequest(t, handler, "GET", "/releases", "", true); res.Code != 503 {
				t.Fatalf("unsafe catalog accepted: %d", res.Code)
			}
			body, _ := json.Marshal(map[string]any{"component": release["component"], "releaseId": release["releaseId"], "requestId": upgradeTestID})
			if res := upgradeRequest(t, handler, "POST", "/jobs", string(body), true); res.Code != 503 {
				t.Fatalf("unsafe release accepted: %d", res.Code)
			}
			if _, err := os.Stat(filepath.Join(root, "requests", "active.json")); !os.IsNotExist(err) {
				t.Fatalf("unsafe release wrote request: %v", err)
			}
		})
	}
}

func TestUpgradeProtocolLegacyManagerMigrationStillRequiresAuthorization(t *testing.T) {
	handler, root, _ := upgradeFixture(t)
	release := upgradeChangeRelease(t, root, func(r map[string]any) { additiveManagerRelease(r); delete(r, "migrationMode") })
	if res := upgradeRequest(t, handler, "GET", "/releases", "", true); res.Code != 200 {
		t.Fatalf("legacy catalog compatibility lost: %d", res.Code)
	}
	body, _ := json.Marshal(map[string]any{"component": release["component"], "releaseId": release["releaseId"], "requestId": upgradeTestID})
	if res := upgradeRequest(t, handler, "POST", "/jobs", string(body), true); res.Code != 409 {
		t.Fatalf("legacy migration submitted without explicit mode: %d", res.Code)
	}
}
