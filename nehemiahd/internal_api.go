package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type internalCreateRequest struct {
	Template        string                   `json:"template"`
	OCIReference    string                   `json:"oci_reference"`
	TTLSeconds      int                      `json:"ttl_seconds"`
	VCPUs           int                      `json:"vcpus"`
	MemoryMB        int                      `json:"memory_mb"`
	DiskMB          int                      `json:"disk_mb"`
	Net             bool                     `json:"net"`
	Persistent      bool                     `json:"persistent"`
	LeaseID         string                   `json:"lease_id"`
	LeaseGeneration uint64                   `json:"lease_generation"`
	Metadata        map[string]string        `json:"metadata,omitempty"`
	NetworkPolicy   networkPolicyDeclaration `json:"network_policy,omitempty"`
	RuntimeCohortID string                   `json:"runtime_cohort_id"`
	RootfsSHA256    string                   `json:"rootfs_sha256"`
}

type internalForkChildRequest struct {
	LeaseID         string            `json:"lease_id"`
	LeaseGeneration uint64            `json:"lease_generation"`
	ExpiresAt       string            `json:"expires_at"`
	Metadata        map[string]string `json:"metadata"`
	VCPUs           int               `json:"vcpus"`
	MemoryMB        int               `json:"memory_mb"`
	DiskMB          int               `json:"disk_mb"`
}

type internalForkRequest struct {
	Children        []internalForkChildRequest `json:"children"`
	RuntimeCohortID string                     `json:"runtime_cohort_id"`
	RootfsSHA256    string                     `json:"rootfs_sha256"`
}

type internalTemplateExportRequest struct {
	ExportID string `json:"export_id"`
}

type internalTemplateUploadRequest struct {
	Checksum string              `json:"checksum"`
	Size     int64               `json:"size_bytes"`
	Upload   scopedTemplateGrant `json:"upload"`
}

type internalTemplateActivationRequest struct {
	Format       string              `json:"format"`
	Architecture string              `json:"architecture"`
	Checksum     string              `json:"checksum"`
	Size         int64               `json:"size_bytes"`
	Download     scopedTemplateGrant `json:"download"`
}

type internalMachineView struct {
	machineView
	LeaseID         string                   `json:"lease_id"`
	LeaseGeneration uint64                   `json:"lease_generation"`
	Metadata        map[string]string        `json:"metadata,omitempty"`
	Resources       internalMachineResources `json:"resources"`
	NetworkPolicy   networkPolicyDeclaration `json:"network_policy"`
}

type internalMachineResources struct {
	VCPUs    int `json:"vcpus"`
	MemoryMB int `json:"memory_mb"`
	DiskMB   int `json:"disk_mb"`
}

func (m *Machine) InternalView() internalMachineView {
	return internalMachineView{
		machineView:     m.View(),
		LeaseID:         m.LeaseID,
		LeaseGeneration: m.LeaseGeneration,
		Metadata:        cloneMetadata(m.Metadata),
		Resources:       internalMachineResources{VCPUs: m.VCPUs, MemoryMB: m.MemoryMB, DiskMB: m.DiskMB},
		NetworkPolicy:   mustNormalizedNetworkDeclaration(m.NetworkPolicy),
	}
}

func (mgr *Manager) InternalList() []internalMachineView {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	out := make([]internalMachineView, 0, len(mgr.machines))
	for _, machine := range mgr.machines {
		if !machine.pooled {
			out = append(out, machine.InternalView())
		}
	}
	return out
}

func (mgr *Manager) InternalGet(id string) (internalMachineView, bool) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	machine, ok := mgr.machines[id]
	if !ok || machine.pooled {
		return internalMachineView{}, false
	}
	return machine.InternalView(), true
}

// internalAuth requires the dedicated control-plane token in an Authorization
// header. Unlike customer WebSockets, query-string credentials are never
// accepted on the private host API because URLs are routinely logged.
func (s *Server) internalAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.internalAuthorized(r) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="nehemiahd-internal"`)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) internalAuthorized(r *http.Request) bool {
	if s.cfg.InternalToken == "" {
		return false
	}
	header := r.Header.Get("Authorization")
	scheme, candidate, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || candidate == "" || strings.TrimSpace(candidate) != candidate {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(s.cfg.InternalToken)) == 1
}

func (s *Server) handleInternalHost(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.HostStatus(s.hostProbe))
}

func (s *Server) handleInternalListMachines(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"machines": s.mgr.InternalList()})
}

func (s *Server) handleInternalGetMachine(w http.ResponseWriter, r *http.Request) {
	machine, ok := s.mgr.InternalGet(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	writeJSON(w, http.StatusOK, machine)
}

func (s *Server) handleInternalCreateMachine(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Draining {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "host_draining"})
		return
	}
	var request internalCreateRequest
	if r.Body != nil {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
			return
		}
	}
	if request.OCIReference != "" {
		if request.Template != "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": "template and oci_reference are mutually exclusive"})
			return
		}
		writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "not_supported", "feature": "oci_image"})
		return
	}
	if request.LeaseGeneration == 0 {
		request.LeaseGeneration = 1
	}
	machine, replayed, err := s.mgr.CreateInternalWithRuntimeExpectation(
		request.Template,
		request.TTLSeconds,
		request.Net,
		request.Persistent,
		"internal",
		r.Header.Get("Idempotency-Key"),
		request.LeaseID,
		request.LeaseGeneration,
		request.Metadata,
		request.VCPUs,
		request.MemoryMB,
		request.DiskMB,
		request.NetworkPolicy,
		managedRuntimeExpectation{CohortID: request.RuntimeCohortID, RootfsSHA256: request.RootfsSHA256},
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidLease):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
		case errors.Is(err, ErrIdempotencyConflict):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "idempotency_conflict"})
		case errors.Is(err, ErrHostDraining):
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "host_draining"})
		case errors.Is(err, ErrHostUnhealthy):
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "host_unhealthy"})
		case errors.Is(err, ErrInvalidResources):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "invalid_resources", "message": err.Error()})
		case errors.Is(err, ErrNotSupported):
			writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "not_supported"})
		case errors.Is(err, ErrTooManyMachines), errors.Is(err, ErrRateLimited):
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "host_capacity"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "create_failed"})
		}
		return
	}
	status := http.StatusCreated
	if replayed {
		status = http.StatusOK
		w.Header().Set("Idempotency-Replayed", "true")
	}
	view, ok := s.mgr.InternalGet(machine.ID)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "create_result_lost"})
		return
	}
	writeJSON(w, status, view)
}

func (s *Server) handleInternalForkMachine(w http.ResponseWriter, r *http.Request) {
	var request internalForkRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	children := make([]managedForkChild, 0, len(request.Children))
	for _, requested := range request.Children {
		if requested.LeaseGeneration == 0 {
			requested.LeaseGeneration = 1
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, requested.ExpiresAt)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "invalid_resources", "message": "expires_at must be RFC3339"})
			return
		}
		children = append(children, managedForkChild{
			LeaseID: requested.LeaseID, LeaseGeneration: requested.LeaseGeneration,
			ExpiresAt: expiresAt.UTC(), Metadata: requested.Metadata,
			VCPUs: requested.VCPUs, MemoryMB: requested.MemoryMB, DiskMB: requested.DiskMB,
		})
	}
	forked, replayed, err := s.mgr.ForkInternalWithRuntimeExpectation(
		r.PathValue("id"),
		r.Header.Get("X-Nehemiah-Lease-ID"),
		r.Header.Get("Idempotency-Key"),
		children,
		managedRuntimeExpectation{CohortID: request.RuntimeCohortID, RootfsSHA256: request.RootfsSHA256},
	)
	if err != nil {
		if replayed {
			w.Header().Set("Idempotency-Replayed", "true")
		}
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		case errors.Is(err, ErrIdempotencyConflict):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "idempotency_conflict"})
		case errors.Is(err, ErrForkSourceNotReady):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "source_not_ready"})
		case errors.Is(err, ErrInvalidLease):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
		case errors.Is(err, ErrInvalidResources):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "invalid_resources", "message": err.Error()})
		case errors.Is(err, ErrSnapshotUnavailable):
			writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "snapshot_unavailable"})
		case errors.Is(err, ErrForkBatchFailed):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "fork_batch_failed"})
		case errors.Is(err, ErrForkBatchCleaned):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "fork_batch_cleaned"})
		case errors.Is(err, ErrForkResultPending):
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "fork_result_pending", "retryable": true})
		case errors.Is(err, ErrTooManyMachines), errors.Is(err, ErrRateLimited):
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "host_capacity"})
		case errors.Is(err, ErrHostDraining), errors.Is(err, ErrHostUnhealthy):
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "host_unavailable"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "fork_failed"})
		}
		return
	}
	views := make([]internalMachineView, 0, len(forked))
	for _, machine := range forked {
		view, ok := s.mgr.InternalGet(machine.ID)
		if !ok || !view.Ready || view.Status != "running" {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "fork_result_lost"})
			return
		}
		views = append(views, view)
	}
	status := http.StatusCreated
	if replayed {
		status = http.StatusOK
		w.Header().Set("Idempotency-Replayed", "true")
	}
	writeJSON(w, status, map[string]any{"machines": views})
}

func (s *Server) handleInternalDeleteMachine(w http.ResponseWriter, r *http.Request) {
	if !s.requireMachineLease(w, r) {
		return
	}
	id := r.PathValue("id")
	destroyed, err := s.mgr.DestroyInternal(id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "metering_persistence_unavailable"})
		return
	}
	if !destroyed {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleInternalExtendMachine(w http.ResponseWriter, r *http.Request) {
	if !s.requireMachineLease(w, r) {
		return
	}
	var request struct {
		ExpiresAt string `json:"expires_at"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	target, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "invalid_ttl"})
		return
	}
	_, replayed, err := s.mgr.ExtendInternal(
		r.PathValue("id"),
		r.Header.Get("X-Nehemiah-Lease-ID"),
		r.Header.Get("Idempotency-Key"),
		target,
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		case errors.Is(err, ErrIdempotencyConflict):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "idempotency_conflict"})
		case errors.Is(err, ErrInvalidLease):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
		case errors.Is(err, ErrInvalidResources):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "invalid_ttl", "message": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "extend_failed"})
		}
		return
	}
	if replayed {
		w.Header().Set("Idempotency-Replayed", "true")
	}
	view, _ := s.mgr.InternalGet(r.PathValue("id"))
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleInternalExecMachine(w http.ResponseWriter, r *http.Request) {
	if !s.requireMachineLease(w, r) {
		return
	}
	if _, ok := s.mgr.InternalGet(r.PathValue("id")); !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	if !s.mgr.IsReady(r.PathValue("id")) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "machine_not_ready"})
		return
	}
	s.handleExec(w, r)
}

func decodeInternalTemplateRequest(w http.ResponseWriter, r *http.Request, destination any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return false
	}
	return true
}

func (s *Server) handleInternalExportTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireMachineLease(w, r) {
		return
	}
	var request internalTemplateExportRequest
	if !decodeInternalTemplateRequest(w, r, &request) {
		return
	}
	exported, err := s.mgr.ExportManagedTemplate(
		r.PathValue("id"),
		r.Header.Get("X-Nehemiah-Lease-ID"),
		request.ExportID,
	)
	if err != nil {
		writeTemplateTransferError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, exported)
}

func (s *Server) handleInternalUploadTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireMachineLease(w, r) {
		return
	}
	var request internalTemplateUploadRequest
	if !decodeInternalTemplateRequest(w, r, &request) {
		return
	}
	uploaded, err := s.mgr.UploadManagedTemplateExport(
		r.PathValue("id"),
		r.Header.Get("X-Nehemiah-Lease-ID"),
		r.PathValue("export"),
		templateArtifact{Checksum: request.Checksum, SizeBytes: request.Size},
		request.Upload,
	)
	if err != nil {
		writeTemplateTransferError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, uploaded)
}

func (s *Server) handleInternalDiscardTemplateExport(w http.ResponseWriter, r *http.Request) {
	if !s.requireMachineLease(w, r) {
		return
	}
	if err := s.mgr.DiscardManagedTemplateExport(
		r.PathValue("id"),
		r.Header.Get("X-Nehemiah-Lease-ID"),
		r.PathValue("export"),
	); err != nil {
		writeTemplateTransferError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleInternalActivateTemplate(w http.ResponseWriter, r *http.Request) {
	var request internalTemplateActivationRequest
	if !decodeInternalTemplateRequest(w, r, &request) {
		return
	}
	activated, err := s.mgr.ActivateManagedTemplate(
		r.PathValue("name"),
		request.Format,
		request.Architecture,
		templateArtifact{Checksum: request.Checksum, SizeBytes: request.Size},
		request.Download,
	)
	if err != nil {
		writeTemplateTransferError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, activated)
}

func writeTemplateTransferError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrTemplateTransfersDisabled):
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "template_transfers_unavailable"})
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
	case errors.Is(err, ErrInvalidLease):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "lease_mismatch"})
	case errors.Is(err, ErrForkSourceNotReady), errors.Is(err, ErrSnapshotUnavailable):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "source_not_ready"})
	case errors.Is(err, ErrTemplateTransferInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_template_transfer"})
	case errors.Is(err, ErrTemplateTransferConflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "template_transfer_conflict"})
	case errors.Is(err, ErrTemplateTransferIntegrity):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "template_integrity_failed"})
	case errors.Is(err, ErrTemplateTransferUpstream):
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "template_object_transfer_failed"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "template_transfer_failed"})
	}
}

func (s *Server) handleInternalEvents(w http.ResponseWriter, r *http.Request) {
	after := uint64(0)
	if raw := r.URL.Query().Get("after"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_after"})
			return
		}
		after = parsed
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": s.mgr.EventsAfter(after)})
}
