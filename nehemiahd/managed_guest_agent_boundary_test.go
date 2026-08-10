package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func managedGuestAgentBoundaryServer() *Server {
	cfg := Config{NehemiahMode: true}
	return &Server{
		cfg:      cfg,
		mgr:      &Manager{cfg: cfg, machines: map[string]*Machine{}},
		guestOps: newGuestOperationLimiter(),
	}
}

func TestManagedExecAndFilesNeverFallBackToSerial(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		method  string
		target  string
		body    string
		handler func(*Server, http.ResponseWriter, *http.Request)
	}{
		{
			name:   "exec",
			method: http.MethodPost,
			target: "/v1/machines/machine-managed/exec",
			body:   `{"command":"true"}`,
			handler: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.handleExec(response, request)
			},
		},
		{
			name:   "upload",
			method: http.MethodPost,
			target: "/v1/machines/machine-managed/upload",
			body:   "bytes",
			handler: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.handleUpload(response, request)
			},
		},
		{
			name:   "download",
			method: http.MethodGet,
			target: "/v1/machines/machine-managed/download?path=/root/file",
			handler: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.handleDownload(response, request)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := managedGuestAgentBoundaryServer()
			request := httptest.NewRequest(test.method, test.target, strings.NewReader(test.body))
			request.SetPathValue("id", "machine-managed")
			response := httptest.NewRecorder()
			test.handler(server, response, request)

			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusServiceUnavailable, response.Body.String())
			}
			if response.Header().Get("Retry-After") != "1" {
				t.Fatalf("Retry-After = %q", response.Header().Get("Retry-After"))
			}
			if !strings.Contains(response.Body.String(), `"error":"guest_agent_unavailable"`) {
				t.Fatalf("body = %s", response.Body.String())
			}
		})
	}
}

func TestManagedGuestAgentFailureResponseIsFixed(t *testing.T) {
	t.Parallel()
	response := httptest.NewRecorder()
	writeManagedGuestAgentFailed(response)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	if got := response.Body.String(); got != "{\"error\":\"guest_agent_failed\"}\n" {
		t.Fatalf("body = %q", got)
	}
}
