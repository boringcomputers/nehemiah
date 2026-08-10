package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGuestOperationLimiterEnforcesMachineAndHostCeilings(t *testing.T) {
	limiter := newGuestOperationLimiter()
	releases := make([]func(), 0, maxConcurrentHostGuestOperations)
	for machine := 0; machine < maxConcurrentHostGuestOperations/maxConcurrentMachineGuestOperations; machine++ {
		id := "machine-" + string(rune('a'+machine))
		for slot := 0; slot < maxConcurrentMachineGuestOperations; slot++ {
			release, ok := limiter.tryAcquire(id)
			if !ok {
				t.Fatalf("machine %d slot %d rejected", machine, slot)
			}
			releases = append(releases, release)
		}
		if _, ok := limiter.tryAcquire(id); ok {
			t.Fatalf("machine %d exceeded its per-machine ceiling", machine)
		}
	}
	if _, ok := limiter.tryAcquire("another-machine"); ok {
		t.Fatal("host-wide guest-operation ceiling was exceeded")
	}

	releases[0]()
	releases[0]() // releases are idempotent
	replacement, ok := limiter.tryAcquire("another-machine")
	if !ok {
		t.Fatal("released host capacity was not reusable")
	}
	replacement()
	for _, release := range releases[1:] {
		release()
	}
	if limiter.total != 0 || len(limiter.byMachine) != 0 {
		t.Fatalf("limiter leaked state: total=%d machines=%d", limiter.total, len(limiter.byMachine))
	}
}

func TestGuestOperationBusyResponsePrecedesVsockWork(t *testing.T) {
	server := &Server{guestOps: newGuestOperationLimiter()}
	releases := make([]func(), 0, maxConcurrentMachineGuestOperations)
	for slot := 0; slot < maxConcurrentMachineGuestOperations; slot++ {
		release, ok := server.guestOps.tryAcquire("machine-busy")
		if !ok {
			t.Fatalf("slot %d rejected", slot)
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()

	request := httptest.NewRequest(http.MethodPost, "/v1/machines/machine-busy/exec", strings.NewReader(`{"command":"true"}`))
	request.SetPathValue("id", "machine-busy")
	response := httptest.NewRecorder()
	server.handleExec(response, request)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", response.Code)
	}
	if response.Header().Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q", response.Header().Get("Retry-After"))
	}
	if !strings.Contains(response.Body.String(), `"error":"guest_operation_capacity_reached"`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}
