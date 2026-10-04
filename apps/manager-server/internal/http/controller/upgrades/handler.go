package upgrades

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	upgradeservice "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/upgrades"
)

type Handler struct {
	App     *app.Context
	Service *upgradeservice.Service
}

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ok, err := h.App.AdminAuthService.VerifyHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, upgradeservice.ErrUnavailable)
		return
	}
	if !ok {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
		return
	}
	if h.Service == nil {
		response.Error(w, http.StatusServiceUnavailable, upgradeservice.ErrUnavailable)
		return
	}
	suffix := strings.TrimPrefix(r.URL.Path, "/usage-service/upgrades")
	var result any
	status := http.StatusOK
	switch {
	case (suffix == "" || suffix == "/releases") && r.Method == http.MethodGet:
		result, err = h.Service.Overview()
	case suffix == "/automation" && r.Method == http.MethodGet:
		result, err = h.Service.Automation()
	case suffix == "/checks/current" && r.Method == http.MethodGet:
		result, err = h.Service.CurrentCheck()
	case suffix == "/checks" && r.Method == http.MethodPost:
		data, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		request, decodeErr := upgradeservice.DecodeCheckRequest(data)
		if readErr != nil || decodeErr != nil {
			err = upgradeservice.ErrInvalid
			break
		}
		var created bool
		result, created, err = h.Service.SubmitCheck(request)
		if created {
			status = http.StatusAccepted
		}
	case suffix == "/jobs" && r.Method == http.MethodPost:
		data, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		request, decodeErr := upgradeservice.DecodeRequest(data)
		if readErr != nil || decodeErr != nil {
			err = upgradeservice.ErrInvalid
			break
		}
		var created bool
		result, created, err = h.Service.Submit(request)
		if created {
			status = http.StatusAccepted
		}
	case strings.HasPrefix(suffix, "/jobs/") && r.Method == http.MethodGet:
		result, err = h.Service.Job(strings.TrimPrefix(suffix, "/jobs/"))
	default:
		response.MethodNotAllowed(w)
		return
	}
	if err != nil {
		safe := upgradeservice.ErrUnavailable
		switch {
		case errors.Is(err, upgradeservice.ErrInvalid):
			status, safe = http.StatusBadRequest, upgradeservice.ErrInvalid
		case errors.Is(err, upgradeservice.ErrConflict):
			status, safe = http.StatusConflict, upgradeservice.ErrConflict
		case errors.Is(err, upgradeservice.ErrNotFound):
			status, safe = http.StatusNotFound, upgradeservice.ErrNotFound
		default:
			status = http.StatusServiceUnavailable
		}
		response.Error(w, status, safe)
		return
	}
	response.JSON(w, status, result)
}
