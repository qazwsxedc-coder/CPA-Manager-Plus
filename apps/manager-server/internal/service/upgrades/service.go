// Package upgrades bridges authenticated Manager requests to the host executor.
// It never runs commands, changes catalog/status files, or removes active jobs.
package upgrades

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalid             = errors.New("invalid upgrade request")
	ErrUnavailable         = errors.New("upgrade executor unavailable")
	ErrConflict            = errors.New("upgrade request conflicts with current state")
	ErrNotFound            = errors.New("upgrade resource not found")
	uuidPattern            = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	namePattern            = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	releasePattern         = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)
	fixedVersionPattern    = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+-custom\.[0-9]+$`)
	officialVersionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
	versionPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$`)
	imagePattern           = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	commitPattern          = regexp.MustCompile(`^[0-9a-f]{40}$`)
	shaPattern             = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Release struct {
	ReleaseID              string    `json:"releaseId"`
	Component              string    `json:"component"`
	Version                string    `json:"version"`
	ImageTag               string    `json:"imageTag"`
	ImageSource            string    `json:"imageSource,omitempty"`
	ImageDigest            string    `json:"imageDigest,omitempty"`
	ImageID                string    `json:"imageId"`
	SourceCommit           string    `json:"sourceCommit"`
	AllowedFromImageIDs    []string  `json:"allowedFromImageIds"`
	RollbackDataCompatible *bool     `json:"rollbackDataCompatible"`
	MigrationRequired      *bool     `json:"migrationRequired"`
	MigrationMode          string    `json:"migrationMode,omitempty"`
	EvidenceFile           string    `json:"evidenceFile"`
	EvidenceSHA256         string    `json:"evidenceSha256"`
	ValidatedAt            time.Time `json:"validatedAt"`
}

// Optional fields default only when omitted. Explicit null/empty values are
// invalid, and custom unmarshalling must retain the strict catalog field check.
func (r *Release) UnmarshalJSON(data []byte) error {
	type releaseJSON Release
	var decoded releaseJSON
	if err := decodeJSON(data, &decoded, true); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"imageSource", "imageDigest", "migrationMode"} {
		if raw, present := fields[key]; present {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil || value == "" {
				return ErrInvalid
			}
		}
	}
	*r = Release(decoded)
	return nil
}

type catalog struct {
	SchemaVersion int       `json:"schemaVersion"`
	Releases      []Release `json:"releases"`
}

type Installed struct {
	Version string `json:"version"`
	ImageID string `json:"imageId"`
}

type Current struct {
	CLI     Installed `json:"cli"`
	Manager Installed `json:"manager"`
}

type Latest struct {
	CLI     string `json:"cli"`
	Manager string `json:"manager"`
}

type host struct {
	SchemaVersion   int       `json:"schemaVersion"`
	UpdatedAt       time.Time `json:"updatedAt"`
	ExecutorVersion string    `json:"executorVersion"`
	Current         Current   `json:"current"`
	Latest          Latest    `json:"latest"`
}

type Request struct {
	Component string `json:"component"`
	ReleaseID string `json:"releaseId"`
	RequestID string `json:"requestId"`
}

func DecodeRequest(data []byte) (Request, error) {
	var request Request
	var fields map[string]json.RawMessage
	if err := decodeJSON(data, &fields, true); err != nil || len(fields) != 3 {
		return request, ErrInvalid
	}
	for _, key := range []string{"component", "releaseId", "requestId"} {
		if _, ok := fields[key]; !ok {
			return request, ErrInvalid
		}
	}
	if err := decodeJSON(data, &request, true); err != nil {
		return request, ErrInvalid
	}
	return request, nil
}

type active struct {
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"id"`
	Component     string    `json:"component"`
	ReleaseID     string    `json:"releaseId"`
	CreatedAt     time.Time `json:"createdAt"`
}

// Job is an explicit public projection. Host-private recovery metadata is ignored.
type Job struct {
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"id"`
	Component     string    `json:"component"`
	ReleaseID     string    `json:"releaseId"`
	State         string    `json:"state"`
	Step          string    `json:"step"`
	Message       string    `json:"message"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	FromVersion   string    `json:"fromVersion,omitempty"`
	ToVersion     string    `json:"toVersion,omitempty"`
	BackupPath    string    `json:"backupPath,omitempty"`
	ErrorCode     string    `json:"errorCode,omitempty"`
}

type Overview struct {
	Enabled        bool      `json:"enabled"`
	ExecutorOnline bool      `json:"executorOnline"`
	Current        Current   `json:"current"`
	Latest         Latest    `json:"latest"`
	Releases       []Release `json:"releases"`
	ActiveJob      *Job      `json:"activeJob,omitempty"`
}

type Service struct {
	dir string
	mu  sync.Mutex
}

func New(dir string) *Service { return &Service{dir: strings.TrimSpace(dir)} }

func validComponent(value string) bool { return value == "cli" || value == "manager" }

func (s *Service) Overview() (Overview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Overview{Releases: []Release{}}
	if s.dir == "" {
		return out, nil
	}
	l, err := openLayout(s.dir)
	if err != nil {
		return out, ErrUnavailable
	}
	defer l.close()
	c, h, err := l.catalogAndHost()
	if err != nil {
		return out, err
	}
	job, err := l.currentJob()
	if err != nil {
		return out, err
	}
	return Overview{Enabled: true, ExecutorOnline: h.online(), Current: h.Current, Latest: h.Latest, Releases: c.Releases, ActiveJob: job}, nil
}

func (s *Service) Job(id string) (*Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != "current" && !uuidPattern.MatchString(id) {
		return nil, ErrInvalid
	}
	l, err := openLayout(s.dir)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer l.close()
	if id == "current" {
		return l.currentJob()
	}
	job, err := l.readJob(id)
	if err != nil || job != nil {
		return job, err
	}
	a, err := l.readActive()
	if err != nil {
		return nil, err
	}
	if a == nil || a.ID != id {
		return nil, ErrNotFound
	}
	return a.queued(), nil
}

// Submit durably creates the singleton request before returning Accepted.
// An incomplete write is deliberately left for inspection, never deleted here.
func (s *Service) Submit(request Request) (*Job, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validComponent(request.Component) || !releasePattern.MatchString(request.ReleaseID) || !uuidPattern.MatchString(request.RequestID) {
		return nil, false, ErrInvalid
	}
	l, err := openLayout(s.dir)
	if err != nil {
		return nil, false, ErrUnavailable
	}
	defer l.close()
	if job, err := l.existing(request); err != nil || job != nil {
		return job, false, err
	}
	c, h, err := l.catalogAndHost()
	if err != nil || !h.online() {
		return nil, false, ErrUnavailable
	}
	var selected *Release
	for i := range c.Releases {
		if c.Releases[i].ReleaseID == request.ReleaseID {
			selected = &c.Releases[i]
			break
		}
	}
	if selected == nil {
		return nil, false, ErrNotFound
	}
	if selected.Component != request.Component {
		return nil, false, ErrInvalid
	}
	if *selected.MigrationRequired && !selected.automaticMigration() {
		return nil, false, ErrConflict
	}
	current := h.Current.CLI
	if request.Component == "manager" {
		current = h.Current.Manager
	}
	allowed := false
	for _, id := range selected.AllowedFromImageIDs {
		if id == current.ImageID {
			allowed = true
		}
	}
	if !allowed || current.ImageID == selected.ImageID {
		return nil, false, ErrConflict
	}
	// Recheck after reading the catalog: the host may have just published a final
	// status and removed active.json. A retry must not create that job again.
	if job, err := l.existing(request); err != nil || job != nil {
		return job, false, err
	}
	a := active{SchemaVersion: 1, ID: request.RequestID, Component: request.Component, ReleaseID: request.ReleaseID, CreatedAt: time.Now().UTC()}
	data, err := json.Marshal(a)
	if err != nil {
		return nil, false, ErrUnavailable
	}
	f, err := l.requests.OpenFile("active.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, fs.ErrExist) {
		job, readErr := l.existing(request)
		if readErr == nil && job == nil {
			readErr = ErrConflict
		}
		return job, false, readErr
	}
	if err != nil {
		return nil, false, ErrUnavailable
	}
	n, writeErr := f.Write(data)
	if writeErr == nil && n != len(data) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		return nil, false, ErrUnavailable
	}
	return a.queued(), true, nil
}

func (h host) online() bool {
	age := time.Since(h.UpdatedAt)
	return !h.UpdatedAt.IsZero() && age >= -5*time.Second && age <= 30*time.Second
}

func (a active) queued() *Job {
	return &Job{SchemaVersion: 1, ID: a.ID, Component: a.Component, ReleaseID: a.ReleaseID, State: "queued", Step: "queued", Message: "Waiting for host executor", CreatedAt: a.CreatedAt, UpdatedAt: a.CreatedAt}
}

type layout struct{ root, catalog, requests, status *os.Root }

func openLayout(dir string) (*layout, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return nil, ErrUnavailable
	}
	// Reject symlink/junction ancestors as well as protocol directories. os.Root
	// then anchors all access and rejects traversal even during rename races.
	for p := filepath.Clean(dir); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil || !plainDir(info) {
			return nil, ErrUnavailable
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	r, err := os.OpenRoot(dir)
	if err != nil {
		return nil, ErrUnavailable
	}
	l := &layout{root: r}
	for _, item := range []struct {
		name string
		dest **os.Root
	}{{"catalog", &l.catalog}, {"requests", &l.requests}, {"status", &l.status}} {
		before, err := r.Lstat(item.name)
		if err != nil || !plainDir(before) {
			l.close()
			return nil, ErrUnavailable
		}
		sub, err := r.OpenRoot(item.name)
		if err != nil {
			l.close()
			return nil, ErrUnavailable
		}
		*item.dest = sub
		after, err := sub.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			l.close()
			return nil, ErrUnavailable
		}
	}
	return l, nil
}

func plainDir(info fs.FileInfo) bool {
	return info != nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode()&os.ModeIrregular == 0
}

func (l *layout) close() {
	for _, root := range []*os.Root{l.catalog, l.requests, l.status, l.root} {
		if root != nil {
			_ = root.Close()
		}
	}
}

func readJSON(root *os.Root, name string, limit int64, target any, strict bool) error {
	before, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return ErrUnavailable
	}
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return ErrUnavailable
	}
	return decodeJSON(data, target, strict)
}

// decodeJSON rejects trailing values and duplicate keys rather than silently
// accepting ambiguous request or manifest fields.
func decodeJSON(data []byte, target any, strict bool) error {
	check := json.NewDecoder(bytes.NewReader(data))
	if err := checkValue(check); err != nil {
		return ErrInvalid
	}
	if _, err := check.Token(); err != io.EOF {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if strict {
		d.DisallowUnknownFields()
	}
	if err := d.Decode(target); err != nil {
		return ErrInvalid
	}
	return nil
}

func checkValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]bool)
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return ErrInvalid
			}
			seen[name] = true
			if err := checkValue(d); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := checkValue(d); err != nil {
				return err
			}
		}
	default:
		return ErrInvalid
	}
	_, err = d.Token()
	return err
}

func (l *layout) catalogAndHost() (catalog, host, error) {
	var c catalog
	var h host
	if err := readJSON(l.catalog, "releases.json", 2<<20, &c, true); err != nil {
		return c, h, ErrUnavailable
	}
	if c.SchemaVersion != 1 || c.Releases == nil || len(c.Releases) > 256 {
		return c, h, ErrUnavailable
	}
	seen := make(map[string]bool)
	for _, r := range c.Releases {
		if !r.valid() || seen[r.ReleaseID] {
			return c, h, ErrUnavailable
		}
		seen[r.ReleaseID] = true
	}
	if err := readJSON(l.status, "host.json", 64<<10, &h, false); err != nil {
		return c, h, ErrUnavailable
	}
	if h.SchemaVersion != 1 || h.ExecutorVersion != "1" || h.UpdatedAt.IsZero() || !validInstalled(h.Current.CLI) || !validInstalled(h.Current.Manager) || !optionalVersion(h.Latest.CLI) || !optionalVersion(h.Latest.Manager) {
		return c, h, ErrUnavailable
	}
	return c, h, nil
}

func validInstalled(i Installed) bool {
	return versionPattern.MatchString(i.Version) && imagePattern.MatchString(i.ImageID)
}
func optionalVersion(v string) bool { return v == "" || versionPattern.MatchString(v) }

func (r Release) valid() bool {
	if !releasePattern.MatchString(r.ReleaseID) || !validComponent(r.Component) || len(r.Version) > 96 || !imagePattern.MatchString(r.ImageID) || !commitPattern.MatchString(r.SourceCommit) || !shaPattern.MatchString(r.EvidenceSHA256) || r.ValidatedAt.IsZero() || r.RollbackDataCompatible == nil || r.MigrationRequired == nil || len(r.AllowedFromImageIDs) == 0 || len(r.AllowedFromImageIDs) > 256 {
		return false
	}
	repository := "qazwsxedc-coder/cli-proxy-api"
	if r.Component == "manager" {
		repository = "qazwsxedc-coder/cpa-manager-plus"
	}
	switch r.ImageSource {
	case "", "custom": // Existing schema-1 manifests default to custom images.
		if !fixedVersionPattern.MatchString(r.Version) {
			return false
		}
	case "official":
		if r.Component != "cli" || !officialVersionPattern.MatchString(r.Version) || r.ImageDigest == "" {
			return false
		}
		repository = "eceasy/cli-proxy-api"
	default:
		return false
	}
	if r.ImageTag != repository+":"+r.Version {
		return false
	}
	if r.ImageDigest != "" && (!strings.HasPrefix(r.ImageDigest, repository+"@") || !imagePattern.MatchString(strings.TrimPrefix(r.ImageDigest, repository+"@"))) {
		return false
	}
	switch r.MigrationMode {
	case "": // Legacy migration manifests remain visible but Submit rejects them.
	case "none":
		if *r.MigrationRequired {
			return false
		}
	case "automatic-additive":
		if !r.automaticMigration() {
			return false
		}
	default:
		return false
	}
	for _, id := range r.AllowedFromImageIDs {
		if !imagePattern.MatchString(id) {
			return false
		}
	}
	if r.EvidenceFile == "" || len(r.EvidenceFile) > 512 || strings.ContainsAny(r.EvidenceFile, `\:`) || path.IsAbs(r.EvidenceFile) || path.Clean(r.EvidenceFile) != r.EvidenceFile {
		return false
	}
	for _, part := range strings.Split(r.EvidenceFile, "/") {
		if part == "." || part == ".." || !namePattern.MatchString(part) {
			return false
		}
	}
	return true
}

func (r Release) automaticMigration() bool {
	return r.Component == "manager" && r.MigrationMode == "automatic-additive" &&
		r.MigrationRequired != nil && *r.MigrationRequired &&
		r.RollbackDataCompatible != nil && !*r.RollbackDataCompatible
}

func (l *layout) readActive() (*active, error) {
	var a active
	err := readJSON(l.requests, "active.json", 4096, &a, true)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil || a.SchemaVersion != 1 || !uuidPattern.MatchString(a.ID) || !validComponent(a.Component) || !releasePattern.MatchString(a.ReleaseID) || a.CreatedAt.IsZero() {
		return nil, ErrUnavailable
	}
	return &a, nil
}

func (l *layout) readJob(id string) (*Job, error) {
	var j Job
	err := readJSON(l.status, id+".json", 64<<10, &j, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil || j.SchemaVersion != 1 || j.ID != id || !validComponent(j.Component) || !releasePattern.MatchString(j.ReleaseID) || j.CreatedAt.IsZero() || j.UpdatedAt.IsZero() || !optionalVersion(j.FromVersion) || !optionalVersion(j.ToVersion) || len(j.Step) > 128 || len(j.Message) > 2048 || len(j.BackupPath) > 1024 || len(j.ErrorCode) > 128 {
		return nil, ErrUnavailable
	}
	switch j.State {
	case "queued", "preflight", "backup", "installing", "checking", "succeeded", "failed", "rolled_back", "manual_recovery":
	default:
		return nil, ErrUnavailable
	}
	return &j, nil
}

func (l *layout) currentJob() (*Job, error) {
	a, err := l.readActive()
	if err != nil || a == nil {
		return nil, err
	}
	j, err := l.readJob(a.ID)
	if err != nil {
		return nil, err
	}
	if j == nil {
		return a.queued(), nil
	}
	if j.Component != a.Component || j.ReleaseID != a.ReleaseID {
		return nil, ErrUnavailable
	}
	return j, nil
}

func (l *layout) existing(r Request) (*Job, error) {
	j, err := l.readJob(r.RequestID)
	if err != nil {
		return nil, err
	}
	if j != nil {
		if j.Component != r.Component || j.ReleaseID != r.ReleaseID {
			return nil, ErrConflict
		}
		return j, nil
	}
	a, err := l.readActive()
	if err != nil || a == nil {
		return nil, err
	}
	if a.ID != r.RequestID || a.Component != r.Component || a.ReleaseID != r.ReleaseID {
		return nil, ErrConflict
	}
	return l.currentJob()
}
