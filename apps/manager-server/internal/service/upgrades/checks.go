package upgrades

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"time"
)

// CheckRequest can only request the executor's fixed official version sources.
// A caller cannot supply a repository, command, URL, or filesystem path.
type CheckRequest struct {
	RequestID string `json:"requestId"`
}

func DecodeCheckRequest(data []byte) (CheckRequest, error) {
	var request CheckRequest
	var fields map[string]json.RawMessage
	if err := decodeJSON(data, &fields, true); err != nil || len(fields) != 1 || fields["requestId"] == nil {
		return request, ErrInvalid
	}
	if err := decodeJSON(data, &request, true); err != nil || !uuidPattern.MatchString(request.RequestID) {
		return request, ErrInvalid
	}
	return request, nil
}

type checkRequest struct {
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"id"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Check struct {
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"id"`
	State         string    `json:"state"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	Message       string    `json:"message"`
	ErrorCode     string    `json:"errorCode,omitempty"`
}

func (r checkRequest) queued() *Check {
	return &Check{SchemaVersion: 1, ID: r.ID, State: "queued", CreatedAt: r.CreatedAt,
		UpdatedAt: r.CreatedAt, Message: "Waiting for host version check"}
}

func (s *Service) CurrentCheck() (*Check, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, err := openLayout(s.dir)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer l.close()
	return l.currentCheck()
}

// SubmitCheck durably creates a singleton request. Only the host executor may
// remove it after publishing the result; reads never initiate a version check.
func (s *Service) SubmitCheck(request CheckRequest) (*Check, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !uuidPattern.MatchString(request.RequestID) {
		return nil, false, ErrInvalid
	}
	l, err := openLayout(s.dir)
	if err != nil {
		return nil, false, ErrUnavailable
	}
	defer l.close()
	if check, err := l.existingCheck(request.RequestID); err != nil || check != nil {
		return check, false, err
	}
	_, h, err := l.catalogAndHost()
	if err != nil || !h.online() {
		return nil, false, ErrUnavailable
	}
	if active, err := l.readActive(); err != nil {
		return nil, false, err
	} else if active != nil {
		return nil, false, ErrConflict
	}
	// The executor may finish and remove a request while the host status is read.
	// An identical retry must still return that durable result, never requeue it.
	if check, err := l.existingCheck(request.RequestID); err != nil || check != nil {
		return check, false, err
	}
	r := checkRequest{SchemaVersion: 1, ID: request.RequestID, CreatedAt: time.Now().UTC()}
	data, err := json.Marshal(r)
	if err != nil {
		return nil, false, ErrUnavailable
	}
	f, err := l.requests.OpenFile("check.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, fs.ErrExist) {
		check, readErr := l.existingCheck(request.RequestID)
		if readErr == nil && check == nil {
			readErr = ErrConflict
		}
		return check, false, readErr
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
	return r.queued(), true, nil
}

func (l *layout) readCheckRequest() (*checkRequest, error) {
	var r checkRequest
	err := readJSON(l.requests, "check.json", 4096, &r, true)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil || r.SchemaVersion != 1 || !uuidPattern.MatchString(r.ID) || r.CreatedAt.IsZero() {
		return nil, ErrUnavailable
	}
	return &r, nil
}

func (l *layout) readCheck() (*Check, error) {
	var c Check
	err := readJSON(l.status, "check.json", 16<<10, &c, true)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil || c.SchemaVersion != 1 || !uuidPattern.MatchString(c.ID) || c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() || len(c.Message) > 2048 || len(c.ErrorCode) > 128 {
		return nil, ErrUnavailable
	}
	switch c.State {
	case "running", "succeeded", "failed":
	default:
		return nil, ErrUnavailable
	}
	return &c, nil
}

func (l *layout) currentCheck() (*Check, error) {
	r, err := l.readCheckRequest()
	if err != nil {
		return nil, err
	}
	c, err := l.readCheck()
	if err != nil {
		return nil, err
	}
	if r != nil && (c == nil || c.ID != r.ID) {
		return r.queued(), nil
	}
	return c, nil
}

func (l *layout) existingCheck(id string) (*Check, error) {
	r, err := l.readCheckRequest()
	if err != nil {
		return nil, err
	}
	if r != nil && r.ID != id {
		return nil, ErrConflict
	}
	c, err := l.readCheck()
	if err != nil {
		return nil, err
	}
	if c != nil && c.ID == id {
		return c, nil
	}
	if r != nil {
		return r.queued(), nil
	}
	return nil, nil
}
