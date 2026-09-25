package upgrades

import (
	"errors"
	"io/fs"
	"strconv"
	"strings"
)

// Offers describe a fixed detected version, not a certified image. Only the
// host may download, verify and register the artifact after explicit consent.
func (l *layout) offers(h host) ([]Release, error) {
	var capability struct {
		SchemaVersion      int  `json:"schemaVersion"`
		PrepareOfficialCLI bool `json:"prepareOfficialCLI"`
	}
	err := readJSON(l.catalog, "capabilities.json", 4096, &capability, true)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil || capability.SchemaVersion != 1 {
		return nil, ErrUnavailable
	}
	if !capability.PrepareOfficialCLI || !newerOfficial(h.Latest.CLI, h.Current.CLI.Version) {
		return nil, nil
	}
	no := false
	return []Release{{ReleaseID: "prepare-cli-" + h.Latest.CLI, Component: "cli", Version: h.Latest.CLI, ImageTag: "eceasy/cli-proxy-api:" + h.Latest.CLI, ImageSource: "official", PrepareRequired: true, AllowedFromImageIDs: []string{h.Current.CLI.ImageID}, MigrationRequired: &no, RollbackDataCompatible: &no}}, nil
}

func newerOfficial(latest, current string) bool {
	current = strings.Split(current, "-custom.")[0]
	if !officialVersionPattern.MatchString(latest) || !officialVersionPattern.MatchString(current) {
		return false
	}
	a, b := strings.Split(latest[1:], "."), strings.Split(current[1:], ".")
	for i := range a {
		x, ex := strconv.ParseUint(a[i], 10, 32)
		y, ey := strconv.ParseUint(b[i], 10, 32)
		if ex != nil || ey != nil {
			return false
		}
		if x != y {
			return x > y
		}
	}
	return false
}
