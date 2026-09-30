package codexnativespeed

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	nativesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/codexnativespeed"
)

type Handler struct {
	App     *app.Context
	Service *nativesvc.Service
}

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ok, err := h.App.AdminAuthService.VerifyHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, nativesvc.ErrUnavailable)
		return
	}
	if !ok {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
		return
	}
	if h.Service == nil {
		response.Error(w, http.StatusServiceUnavailable, nativesvc.ErrUnavailable)
		return
	}
	if r.URL.Path != "/usage-service/codex-native-speed" {
		response.MethodNotAllowed(w)
		return
	}
	switch r.Method {
	case http.MethodGet:
		response.JSON(w, http.StatusOK, h.Service.Get(time.Now().UTC()))
	case http.MethodPut:
		data, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		if readErr != nil {
			response.Error(w, http.StatusBadRequest, nativesvc.ErrInvalid)
			return
		}
		result, err := h.Service.Put(data, time.Now().UTC())
		if err != nil {
			if errors.Is(err, nativesvc.ErrInvalid) {
				response.Error(w, http.StatusBadRequest, nativesvc.ErrInvalid)
			} else {
				response.Error(w, http.StatusServiceUnavailable, nativesvc.ErrUnavailable)
			}
			return
		}
		response.JSON(w, http.StatusAccepted, result)
	default:
		response.MethodNotAllowed(w)
	}
}
