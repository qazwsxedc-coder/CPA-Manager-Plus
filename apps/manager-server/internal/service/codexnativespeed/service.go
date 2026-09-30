package codexnativespeed

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	fileName       = "codex-native-speed.json"
	heartbeatTTL   = 15 * time.Second
	requestTTL     = 2 * time.Minute
	maxFileBytes   = 64 << 10
	maxRequestBody = 4096
)

var (
	ErrUnavailable = errors.New("native speed bridge unavailable")
	ErrInvalid     = errors.New("invalid native speed request")
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type Mode string

const (
	ModeFast     Mode = "fast"
	ModeStandard Mode = "standard"
)

type Result struct {
	Available bool    `json:"available"`
	Mode      *Mode   `json:"mode"`
	RequestID *string `json:"requestId"`
	State     string  `json:"state"`
	Code      *string `json:"code"`
	UpdatedAt *string `json:"updatedAt"`
}

type request struct {
	SchemaVersion int       `json:"schemaVersion"`
	RequestID     string    `json:"requestId"`
	Mode          Mode      `json:"mode"`
	CreatedAt     time.Time `json:"createdAt"`
}

type heartbeat struct {
	SchemaVersion int       `json:"schemaVersion"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type status struct {
	SchemaVersion int       `json:"schemaVersion"`
	RequestID     *string   `json:"requestId"`
	Mode          *Mode     `json:"mode"`
	State         string    `json:"state"`
	Code          *string   `json:"code"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type putBody struct {
	Mode Mode `json:"mode"`
}

type Service struct {
	dir string
	mu  sync.Mutex
}

func New(dir string) *Service { return &Service{dir: strings.TrimSpace(dir)} }

func (s *Service) Get(now time.Time) Result {
	if s.dir == "" {
		return Result{State: "disabled"}
	}
	l, err := openLayout(s.dir)
	if err != nil {
		return Result{State: "unavailable", Code: ptr("native_bridge_unavailable")}
	}
	defer l.close()
	h, err := readJSON(l.catalog, fileName, &heartbeat{})
	if err != nil {
		return Result{State: "unavailable", Code: ptr("native_bridge_unavailable")}
	}
	hb := h.(*heartbeat)
	if hb.SchemaVersion != 1 || !online(hb.UpdatedAt, now) {
		return Result{State: "unavailable", Code: ptr("native_bridge_unavailable")}
	}
	var st *status
	if value, readErr := readOptionalJSON(l.status, fileName, &status{}); readErr != nil {
		return Result{State: "unavailable", Code: ptr("native_bridge_unavailable")}
	} else if value != nil {
		st = value.(*status)
		if !validStatus(st) || !online(st.UpdatedAt, now) {
			return Result{State: "unavailable", Code: ptr("native_bridge_unavailable")}
		}
	}
	var req *request
	if value, readErr := readOptionalJSON(l.requests, fileName, &request{}); readErr != nil {
		return Result{State: "unavailable", Code: ptr("native_bridge_unavailable")}
	} else if value != nil {
		req = value.(*request)
		if !validRequest(req) || now.Sub(req.CreatedAt) < -5*time.Second {
			return Result{State: "unavailable", Code: ptr("native_request_invalid")}
		}
	}
	result := Result{Available: true, State: "ready"}
	if st != nil {
		result.Mode, result.UpdatedAt = st.Mode, ptr(st.UpdatedAt.UTC().Format(time.RFC3339Nano))
		result.RequestID, result.State, result.Code = st.RequestID, st.State, st.Code
	}
	if req == nil {
		return result
	}
	result.RequestID = ptr(req.RequestID)
	// The request is an intent, not evidence that Codex persisted the mode.
	// A fresh matching receipt wins over the TTL for unprocessed requests.
	matching := st != nil && st.RequestID != nil && *st.RequestID == req.RequestID && !st.UpdatedAt.Before(req.CreatedAt)
	if matching && st.State == "applied" && st.Mode != nil && *st.Mode == req.Mode {
		result.State, result.Mode = "applied", st.Mode
		return result
	}
	if matching && st.State == "error" && st.Code != nil && safeCode(*st.Code) {
		result.State, result.Code = "error", st.Code
		return result
	}
	if now.Sub(req.CreatedAt) > requestTTL {
		result.State, result.Code = "error", ptr("native_request_expired")
		return result
	}
	result.State, result.Code = "pending", nil
	return result
}

func (s *Service) Put(data []byte, now time.Time) (Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dir == "" {
		return Result{}, ErrUnavailable
	}
	if len(data) > maxRequestBody {
		return Result{}, ErrInvalid
	}
	var body putBody
	if err := decodeJSON(data, &body, true); err != nil || !validMode(body.Mode) {
		return Result{}, ErrInvalid
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) != 1 || fields["mode"] == nil {
		return Result{}, ErrInvalid
	}
	current := s.Get(now)
	if !current.Available {
		return Result{}, ErrUnavailable
	}
	requestID, err := randomID()
	if err != nil {
		return Result{}, ErrUnavailable
	}
	req := request{SchemaVersion: 1, RequestID: requestID, Mode: body.Mode, CreatedAt: now.UTC()}
	l, err := openLayout(s.dir)
	if err != nil {
		return Result{}, ErrUnavailable
	}
	defer l.close()
	data, err = json.Marshal(req)
	if err != nil {
		return Result{}, ErrUnavailable
	}
	if err := atomicWrite(l.requests, fileName, data); err != nil {
		return Result{}, ErrUnavailable
	}
	current.RequestID, current.State, current.Code = &requestID, "pending", nil
	return current, nil
}

func validMode(mode Mode) bool { return mode == ModeFast || mode == ModeStandard }
func validRequest(req *request) bool {
	return req.SchemaVersion == 1 && uuidPattern.MatchString(req.RequestID) && validMode(req.Mode) && !req.CreatedAt.IsZero()
}
func validStatus(st *status) bool {
	if st.SchemaVersion != 1 || st.UpdatedAt.IsZero() {
		return false
	}
	if st.RequestID != nil && !uuidPattern.MatchString(*st.RequestID) {
		return false
	}
	if st.Mode != nil && !validMode(*st.Mode) {
		return false
	}
	switch st.State {
	case "ready":
		return st.RequestID == nil && st.Code == nil
	case "applied":
		return st.RequestID != nil && st.Code == nil && st.Mode != nil && validMode(*st.Mode)
	case "error":
		return st.Code != nil && safeCode(*st.Code)
	default:
		return false
	}
}
func safeCode(code string) bool {
	// The companion may encounter parser or filesystem errors that include
	// config content. Only protocol constants may cross the HTTP boundary.
	switch code {
	case "native_config_invalid", "native_config_changed", "native_config_write_failed", "native_config_unavailable", "native_readback_failed", "native_request_expired", "native_request_invalid", "native_bridge_unavailable":
		return true
	default:
		return false
	}
}
func online(updated, now time.Time) bool {
	age := now.Sub(updated)
	return !updated.IsZero() && age >= -5*time.Second && age <= heartbeatTTL
}
func ptr[T any](value T) *T { return &value }

type layout struct{ root, catalog, requests, status *os.Root }

func openLayout(path string) (*layout, error) {
	path, err := filepath.Abs(path)
	if err != nil || path == string(filepath.Separator) {
		return nil, ErrUnavailable
	}
	for current := path; ; current = filepath.Dir(current) {
		info, statErr := os.Lstat(current)
		if statErr != nil || !info.IsDir() || info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return nil, ErrUnavailable
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
	}
	r, err := os.OpenRoot(path)
	if err != nil {
		return nil, ErrUnavailable
	}
	l := &layout{root: r}
	for name, dest := range map[string]**os.Root{"catalog": &l.catalog, "requests": &l.requests, "status": &l.status} {
		info, statErr := r.Lstat(name)
		if statErr != nil || !info.IsDir() || info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			l.close()
			return nil, ErrUnavailable
		}
		sub, openErr := r.OpenRoot(name)
		if openErr != nil {
			l.close()
			return nil, ErrUnavailable
		}
		*dest = sub
		after, statErr := sub.Stat(".")
		if statErr != nil || !os.SameFile(info, after) {
			l.close()
			return nil, ErrUnavailable
		}
	}
	return l, nil
}
func (l *layout) close() {
	for _, r := range []*os.Root{l.catalog, l.requests, l.status, l.root} {
		if r != nil {
			_ = r.Close()
		}
	}
}

func readOptionalJSON(root *os.Root, name string, target any) (any, error) {
	info, err := root.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > maxFileBytes {
		return nil, ErrUnavailable
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(info, after) {
		return nil, ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil || len(data) > maxFileBytes {
		return nil, ErrUnavailable
	}
	if err := decodeJSON(data, target, true); err != nil {
		return nil, ErrUnavailable
	}
	return target, nil
}
func readJSON(root *os.Root, name string, target any) (any, error) {
	value, err := readOptionalJSON(root, name, target)
	if err != nil || value == nil {
		return nil, ErrUnavailable
	}
	return value, nil
}
func decodeJSON(data []byte, target any, strict bool) error {
	if len(bytes.TrimSpace(data)) == 0 {
		return ErrInvalid
	}
	check := json.NewDecoder(bytes.NewReader(data))
	if err := checkValue(check); err != nil {
		return ErrInvalid
	}
	if _, err := check.Token(); err != io.EOF {
		return ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(target); err != nil {
		return ErrInvalid
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return ErrInvalid
	}
	return nil
}
func checkValue(d *json.Decoder) error {
	token, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]bool)
		for d.More() {
			token, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := token.(string)
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
func atomicWrite(root *os.Root, name string, data []byte) error {
	tmp := name + ".tmp-" + fmt.Sprintf("%d", time.Now().UnixNano())
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	written, writeErr := f.Write(data)
	err = writeErr
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		_ = root.Remove(tmp)
		return err
	}
	if closeErr != nil {
		_ = root.Remove(tmp)
		return closeErr
	}
	err = renameWithinRoot(root, tmp, name)
	if err != nil {
		_ = root.Remove(tmp)
	}
	return err
}
func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
