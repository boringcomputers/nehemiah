package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// Server wires the HTTP mux, auth middleware and JSON handlers.
type Server struct {
	cfg         Config
	mgr         *Manager
	mux         *http.ServeMux
	infer       *inferLimiter
	storage     *Storage      // nil when no S3 endpoint is configured
	volLimiter  *inferLimiter // per-IP volume-creation cap
	agentBudget *dailyLimit   // global daily cap on agent runs
	inferBudget *dailyLimit   // global daily cap on inference requests
}

// NewServer builds the router with all routes from the contract.
func NewServer(cfg Config, mgr *Manager) *Server {
	s := &Server{cfg: cfg, mgr: mgr, mux: http.NewServeMux(), infer: newInferLimiter(cfg.InferenceRatePerMin), volLimiter: newInferLimiter(cfg.VolumeRatePerMin), agentBudget: newDailyLimit(cfg.DailyAgentMax), inferBudget: newDailyLimit(cfg.DailyInferMax)}
	if st, err := newStorage(cfg); err != nil {
		log.Printf("storage disabled: %v", err)
	} else if st != nil {
		s.storage = st
		s.startVolumeGC()
		log.Printf("storage enabled (bucket=%s quota=%dMB)", cfg.S3Bucket, cfg.VolumeQuotaMB)
	}

	// Open route: health check (never requires auth).
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)

	// Caddy on-demand-TLS gate for preview subdomains (open, internal).
	s.mux.HandleFunc("GET /internal/tls-check", s.handleTLSCheck)

	// Inference gateway (OpenAI-compatible; keys are server-side, per-IP capped).
	s.mux.Handle("POST /v1/chat/completions", s.auth(http.HandlerFunc(s.handleChatCompletions)))
	s.mux.Handle("GET /v1/models", s.auth(http.HandlerFunc(s.handleModels)))

	// Authenticated /v1 routes.
	s.mux.Handle("POST /v1/machines", s.auth(http.HandlerFunc(s.handleCreate)))
	s.mux.Handle("GET /v1/machines", s.auth(http.HandlerFunc(s.handleList)))
	s.mux.Handle("GET /v1/machines/{id}", s.auth(http.HandlerFunc(s.handleGet)))
	s.mux.Handle("DELETE /v1/machines/{id}", s.auth(http.HandlerFunc(s.handleDelete)))
	s.mux.Handle("POST /v1/machines/{id}/branch", s.auth(http.HandlerFunc(s.handleBranch)))
	s.mux.Handle("POST /v1/machines/{id}/extend", s.auth(http.HandlerFunc(s.handleExtend)))

	// Snapshot-to-template: freeze a running machine as a named template; new
	// machines boot from it in milliseconds ({"template": "<name>"}).
	s.mux.Handle("POST /v1/machines/{id}/publish", s.auth(http.HandlerFunc(s.handlePublish)))
	s.mux.Handle("GET /v1/templates", s.auth(http.HandlerFunc(s.handleListTemplates)))
	s.mux.Handle("DELETE /v1/templates/{name}", s.auth(http.HandlerFunc(s.handleDeleteTemplate)))

	// Deterministic command execution (no TTY, no LLM): run one command, get
	// {output, exit_code} back as JSON.
	s.mux.Handle("POST /v1/machines/{id}/exec", s.auth(http.HandlerFunc(s.handleExec)))

	// File transfer over the guest serial console.
	s.mux.Handle("POST /v1/machines/{id}/upload", s.auth(http.HandlerFunc(s.handleUpload)))
	s.mux.Handle("GET /v1/machines/{id}/download", s.auth(http.HandlerFunc(s.handleDownload)))

	// Path-based preview: reverse-proxy a guest port (works over the tunnel /
	// without wildcard DNS). Any method, sub-paths, and WS upgrades.
	// No auth: previews are opened in new browser tabs (window.open) which can't
	// add Authorization headers. The machine ID itself is the access token.
	s.mux.HandleFunc("/v1/machines/{id}/web/{port}/{path...}", s.handleWebProxy)

	// Persistent volumes (S3-backed). Registered only when storage is configured.
	if s.storage != nil {
		s.mux.Handle("POST /v1/volumes", s.auth(http.HandlerFunc(s.handleCreateVolume)))
		s.mux.Handle("GET /v1/volumes/{id}", s.auth(http.HandlerFunc(s.handleGetVolume)))
		s.mux.Handle("DELETE /v1/volumes/{id}", s.auth(http.HandlerFunc(s.handleDeleteVolume)))
		s.mux.Handle("GET /v1/volumes/{id}/files", s.auth(http.HandlerFunc(s.handleListVolumeFiles)))
		s.mux.Handle("PUT /v1/volumes/{id}/file", s.auth(http.HandlerFunc(s.handlePutVolumeFile)))
		s.mux.Handle("GET /v1/volumes/{id}/file", s.auth(http.HandlerFunc(s.handleGetVolumeFile)))
		s.mux.Handle("DELETE /v1/volumes/{id}/file", s.auth(http.HandlerFunc(s.handleDeleteVolumeFile)))
		// Save a machine's /root into a volume (attach is via POST /v1/machines {volume}).
		s.mux.Handle("POST /v1/machines/{id}/save", s.auth(http.HandlerFunc(s.handleSaveVolume)))
	}

	// WebSocket TTY + VNC. Auth is handled inside (accepts ?token= too).
	s.mux.HandleFunc("GET /v1/machines/{id}/tty", s.handleTTY)
	s.mux.HandleFunc("GET /v1/machines/{id}/vnc", s.handleVNC)

	// Debug/agent: capture a PNG screenshot of a desktop machine.
	s.mux.Handle("GET /v1/machines/{id}/screenshot", s.auth(http.HandlerFunc(s.handleScreenshot)))

	// Computer-use agent: drive a desktop machine toward a goal, streaming
	// narration over a WebSocket.
	s.mux.HandleFunc("GET /v1/machines/{id}/agent", s.handleAgent)

	// Terminal agent: drive a shell machine toward a goal by typing commands
	// into its serial console, streaming narration over a WebSocket.
	s.mux.HandleFunc("GET /v1/machines/{id}/shell-agent", s.runShellAgent)

	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Preview hosts (<id>--<port>.<base>) bypass the API entirely and reverse-
	// proxy straight to the guest's port.
	if id, port, ok := s.previewTarget(r.Host); ok {
		s.handlePreview(w, r, id, port)
		return
	}
	// CORS so a browser on the deployed site's origin can call this endpoint.
	if o := s.cfg.CORSOrigin; o != "" {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.Header().Add("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// auth is middleware enforcing the Bearer token on /v1/* routes when a token is
// configured. It does not apply to /healthz.
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authorized returns true if the request carries the correct token, or if no
// token is configured. Accepts both the Authorization header and ?token=.
func (s *Server) authorized(r *http.Request) bool {
	if s.cfg.Token == "" {
		return true
	}
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			candidate := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
			if subtle.ConstantTimeCompare([]byte(candidate), []byte(s.cfg.Token)) == 1 {
				return true
			}
		}
	}
	if q := r.URL.Query().Get("token"); q != "" {
		if subtle.ConstantTimeCompare([]byte(q), []byte(s.cfg.Token)) == 1 {
			return true
		}
	}
	return false
}

// ---- handlers ----

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	_, err := os.Stat("/dev/kvm")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"machines": s.mgr.Count(),
		"kvm":      err == nil,
	})
}

type createRequest struct {
	Template   string `json:"template"`
	TTLSeconds int    `json:"ttl_seconds"`
	Net        bool   `json:"net"`        // request internet (forces a cold boot)
	Volume     string `json:"volume"`     // restore this volume into /root on boot
	Persistent bool   `json:"persistent"` // no TTL — run until stopped (needs NEHEMIAH_ALLOW_PERSISTENT)
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON: " + err.Error()})
			return
		}
	}
	if req.Template == "" {
		req.Template = "python"
	}

	m, err := s.mgr.Create(req.Template, req.TTLSeconds, req.Net, req.Persistent, clientIP(r, s.cfg.TrustProxy))
	if err != nil {
		if errors.Is(err, ErrTooManyMachines) || errors.Is(err, ErrRateLimited) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": err.Error()})
			return
		}
		log.Printf("create failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	// Restore a volume's snapshot into /root before the user connects (best-effort).
	if req.Volume != "" && s.storage != nil {
		if err := s.attachVolume(m.ID, req.Volume); err != nil {
			log.Printf("machine %s: attach volume %s failed: %v", m.ID, req.Volume, err)
		}
	}
	writeJSON(w, http.StatusCreated, m.View())
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	views := s.mgr.List()
	writeJSON(w, http.StatusOK, map[string]any{"machines": views})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	view, ok := s.mgr.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handlePublish freezes a running machine as a named template. Body {"name": s}.
func (s *Server) handlePublish(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name string `json:"name"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON: " + err.Error()})
			return
		}
	}
	view, err := s.mgr.Publish(id, req.Name, clientIP(r, s.cfg.TrustProxy))
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		case errors.Is(err, ErrBadTemplateName):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		case errors.Is(err, ErrTemplateExists):
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
		case errors.Is(err, ErrTemplateQuota), errors.Is(err, ErrRateLimited):
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": err.Error()})
		case errors.Is(err, ErrSnapshotUnavailable):
			writeJSON(w, http.StatusNotImplemented, map[string]any{"error": err.Error()})
		default:
			log.Printf("publish failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		}
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"templates": s.mgr.ListTemplates()})
}

func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.mgr.DeleteTemplate(name); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		case errors.Is(err, ErrTemplateBuiltin), errors.Is(err, ErrBadTemplateName):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleExtend resets a machine's TTL ("I need a few more minutes"). Body
// {"ttl_seconds": n} — omitted/0 means the default TTL; clamped like create.
func (s *Server) handleExtend(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		TTLSeconds int `json:"ttl_seconds"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON: " + err.Error()})
			return
		}
	}
	view, err := s.mgr.Extend(id, req.TTLSeconds)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.mgr.Destroy(id) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleBranch forks a machine. ?count=N (fleet fork) makes N clones from one
// snapshot and returns {"machines":[...]}; without it (or count=1) the response
// stays a bare machine for backward compatibility.
func (s *Server) handleBranch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	count := 1
	if c := r.URL.Query().Get("count"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "count must be a positive integer"})
			return
		}
		count = n
	}

	forks, err := s.mgr.BranchN(id, clientIP(r, s.cfg.TrustProxy), count)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		case errors.Is(err, ErrTooManyMachines), errors.Is(err, ErrRateLimited):
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": err.Error()})
		case errors.Is(err, ErrSnapshotUnavailable):
			writeJSON(w, http.StatusNotImplemented, map[string]any{"error": err.Error()})
		default:
			log.Printf("branch failed: %v", err)
			writeJSON(w, http.StatusNotImplemented, map[string]any{"error": err.Error()})
		}
		return
	}
	if count <= 1 {
		writeJSON(w, http.StatusCreated, forks[0].View())
		return
	}
	views := make([]machineView, len(forks))
	for i, m := range forks {
		views[i] = m.View()
	}
	writeJSON(w, http.StatusCreated, map[string]any{"machines": views, "requested": count})
}

// writeJSON writes a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: encode failed: %v", err)
	}
}
