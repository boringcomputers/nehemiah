package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func internalTestConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		HostID:                "host-test",
		Region:                "test-1",
		InternalToken:         "internal-token-that-is-long-enough-for-tests",
		MaxMachines:           10,
		MaxForks:              4,
		MaxForkOperations:     4096,
		DefaultTTL:            120,
		MinTTL:                15,
		MaxTTL:                900,
		VCPUs:                 1,
		MemSizeMB:             256,
		MaxVCPUsPerMachine:    4,
		MaxMemoryMBPerMachine: 4096,
		MemReserveMB:          0,
		PerIPMax:              10,
		CreateRatePerMin:      100,
		AllowPersistent:       true,
		DesktopPool:           0,
		StatePath:             "",
		OverlayQuotaMB:        8192,
		CPUMaxPercent:         100,
		PidsMax:               128,
		InferenceRatePerMin:   10,
		VolumeRatePerMin:      10,
		DailyAgentMax:         200,
		AgentMaxSteps:         30,
		AgentMaxConcurrent:    2,
		JailerUID:             30000,
		JailerGID:             30000,
		RuntimeCohort:         testRuntimeCohort(),
	}
}

func testRuntimeCohort() managedRuntimeCohort {
	cohort := managedRuntimeCohort{
		ContractVersion:     managedRuntimeContractVersion,
		Arch:                runtime.GOARCH,
		PythonRootfsSHA256:  strings.Repeat("1", 64),
		DesktopRootfsSHA256: strings.Repeat("2", 64),
		KernelSHA256:        strings.Repeat("3", 64),
		FirecrackerSHA256:   strings.Repeat("4", 64),
		JailerSHA256:        strings.Repeat("5", 64),
	}
	cohort.ID = cohort.computedID()
	return cohort
}

func internalRequest(method, target, token string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func TestInternalAPIRequiresDedicatedHeaderToken(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.Token = "public-token"
	server := NewServer(cfg, NewManager(cfg))

	tests := []struct {
		name   string
		target string
		token  string
		want   int
	}{
		{"missing", "/internal/v1/host", "", http.StatusUnauthorized},
		{"query string rejected", "/internal/v1/host?token=" + cfg.InternalToken, "", http.StatusUnauthorized},
		{"public token rejected", "/internal/v1/host", cfg.Token, http.StatusUnauthorized},
		{"internal token accepted", "/internal/v1/host", cfg.InternalToken, http.StatusOK},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server.hostProbe = staticHostProbe{hostResources{KVM: true, Jailer: true, TotalCPU: 4}}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, internalRequest(http.MethodGet, test.target, test.token, nil))
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestInternalHostMetadata(t *testing.T) {
	cfg := internalTestConfig(t)
	mgr := NewManager(cfg)
	server := NewServer(cfg, mgr)
	server.hostProbe = staticHostProbe{hostResources{
		Architecture:       "arm64",
		KVM:                true,
		Jailer:             true,
		TotalCPU:           16,
		TotalMemoryMB:      32768,
		AvailableMemoryMB:  24000,
		TotalDiskBytes:     99,
		AvailableDiskBytes: 55,
	}}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, internalRequest(http.MethodGet, "/internal/v1/host", cfg.InternalToken, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	for _, expected := range []string{
		`"host_id":"host-test"`, `"region":"test-1"`, `"architecture":"arm64"`,
		`"kvm":true`, `"total_cpu":16`, `"available_disk_bytes":55`, `"version":`,
	} {
		if !bytes.Contains(response.Body.Bytes(), []byte(expected)) {
			t.Errorf("response missing %s: %s", expected, response.Body.String())
		}
	}
}

func TestInternalMachineCreateIsIdempotentAndStoresOpaqueLease(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.JailerEnable = true // fake boot already represents a jailed runtime
	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	var boots atomic.Int32
	mgr.boot = func(cfg Config, id string, template Template, snapshot string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
		boots.Add(1)
		return &fcDriver{cfg: cfg, id: id, tpl: template, jailed: true, network: network}, "coldboot", 3, nil
	}
	server := NewServer(cfg, mgr)
	body := `{"template":"python","persistent":true,"lease_id":"lease-opaque-1","metadata":{"project_ref":"opaque-project"}}`

	create := func(payload string) *httptest.ResponseRecorder {
		request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken, bytes.NewBufferString(payload))
		request.Header.Set("Idempotency-Key", "create-1")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	first := create(body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first status = %d: %s", first.Code, first.Body.String())
	}
	second := create(body)
	if second.Code != http.StatusOK || second.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatalf("replay status = %d headers=%v body=%s", second.Code, second.Header(), second.Body.String())
	}
	if boots.Load() != 1 {
		t.Fatalf("boot count = %d, want 1", boots.Load())
	}
	if !bytes.Contains(second.Body.Bytes(), []byte(`"lease_id":"lease-opaque-1"`)) || !bytes.Contains(second.Body.Bytes(), []byte(`"project_ref":"opaque-project"`)) {
		t.Fatalf("lease metadata missing: %s", second.Body.String())
	}
	for _, field := range []string{`"started_at":`, `"ready":true`, `"ready_at":`} {
		if !bytes.Contains(second.Body.Bytes(), []byte(field)) {
			t.Errorf("response missing readiness field %s: %s", field, second.Body.String())
		}
	}

	conflict := create(`{"template":"python","persistent":true,"lease_id":"different-lease"}`)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409: %s", conflict.Code, conflict.Body.String())
	}
}

func TestInternalCreateDoesNotCollapseFleetCapacityIntoPublicPerIPLimit(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.JailerEnable = true
	cfg.PerIPMax = 2
	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	mgr.boot = func(cfg Config, id string, template Template, snapshot string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
		return &fcDriver{cfg: cfg, id: id, tpl: template, jailed: true, apiClt: harmlessFirecrackerClient()}, "coldboot", 1, nil
	}
	server := NewServer(cfg, mgr)

	for index := 0; index < 3; index++ {
		request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken,
			bytes.NewBufferString(`{"template":"python","persistent":true,"lease_id":"lease-internal-`+string(rune('a'+index))+`"}`))
		request.Header.Set("Idempotency-Key", "internal-create-"+string(rune('a'+index)))
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("internal create %d = %d %s", index+1, response.Code, response.Body.String())
		}
	}

	for index := 0; index < 3; index++ {
		_, err := mgr.Create("python", 120, false, true, "203.0.113.10")
		if index < 2 && err != nil {
			t.Fatalf("public create %d failed early: %v", index+1, err)
		}
		if index == 2 && !errors.Is(err, ErrRateLimited) {
			t.Fatalf("third public create error = %v, want rate limit", err)
		}
	}
}

func TestInternalCreateValidatesResourcesAndReportsOCIUnsupported(t *testing.T) {
	cfg := internalTestConfig(t)
	server := NewServer(cfg, NewManager(cfg))
	tests := []struct {
		name      string
		body      string
		want      int
		errorCode string
	}{
		{"OCI", `{"oci_reference":"registry.example/image@sha256:abc","lease_id":"lease-1","ttl_seconds":120,"vcpus":1,"memory_mb":512,"disk_mb":5120}`, http.StatusNotImplemented, "not_supported"},
		{"too many CPUs", `{"template":"python","lease_id":"lease-1","ttl_seconds":120,"vcpus":99,"memory_mb":512,"disk_mb":5120}`, http.StatusUnprocessableEntity, "invalid_resources"},
		{"too much disk", `{"template":"python","lease_id":"lease-1","ttl_seconds":120,"vcpus":1,"memory_mb":512,"disk_mb":99999}`, http.StatusUnprocessableEntity, "invalid_resources"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken, bytes.NewBufferString(test.body))
			request.Header.Set("Idempotency-Key", "resource-test-"+test.name)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.want || !bytes.Contains(response.Body.Bytes(), []byte(test.errorCode)) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestInternalLeaseDeleteExtendAndExecReadiness(t *testing.T) {
	cfg := internalTestConfig(t)
	mgr := NewManager(cfg)
	machine := &Machine{
		ID: "m-01020304", Status: "starting", Template: "python", LeaseID: "lease-right",
		CreatedAt: time.Now(), StartedAt: time.Now(), ExpiresAt: time.Now().Add(time.Minute),
	}
	mgr.mu.Lock()
	mgr.machines[machine.ID] = machine
	mgr.mu.Unlock()
	server := NewServer(cfg, mgr)

	execRequest := internalRequest(http.MethodPost, "/internal/v1/machines/"+machine.ID+"/exec", cfg.InternalToken, bytes.NewBufferString(`{"command":"true"}`))
	execRequest.Header.Set("X-Nehemiah-Lease-ID", "lease-right")
	execResponse := httptest.NewRecorder()
	server.ServeHTTP(execResponse, execRequest)
	if execResponse.Code != http.StatusConflict || !bytes.Contains(execResponse.Body.Bytes(), []byte("machine_not_ready")) {
		t.Fatalf("exec response = %d %s", execResponse.Code, execResponse.Body.String())
	}

	target := time.Now().UTC().Add(5 * time.Minute).Truncate(time.Millisecond)
	extendBody := `{"expires_at":"` + target.Format(time.RFC3339Nano) + `"}`
	extendRequest := internalRequest(http.MethodPost, "/internal/v1/machines/"+machine.ID+"/extend", cfg.InternalToken, bytes.NewBufferString(extendBody))
	extendRequest.Header.Set("X-Nehemiah-Lease-ID", "lease-right")
	extendRequest.Header.Set("Idempotency-Key", "extend-1")
	extendResponse := httptest.NewRecorder()
	server.ServeHTTP(extendResponse, extendRequest)
	if extendResponse.Code != http.StatusOK ||
		!bytes.Contains(extendResponse.Body.Bytes(), []byte(`"lease_id":"lease-right"`)) ||
		!bytes.Contains(extendResponse.Body.Bytes(), []byte(`"expires_at":"`+target.Format(time.RFC3339Nano)+`"`)) {
		t.Fatalf("extend response = %d %s", extendResponse.Code, extendResponse.Body.String())
	}
	replayRequest := internalRequest(http.MethodPost, "/internal/v1/machines/"+machine.ID+"/extend", cfg.InternalToken, bytes.NewBufferString(extendBody))
	replayRequest.Header.Set("X-Nehemiah-Lease-ID", "lease-right")
	replayRequest.Header.Set("Idempotency-Key", "extend-1")
	replayResponse := httptest.NewRecorder()
	server.ServeHTTP(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusOK || replayResponse.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatalf("extend replay = %d headers=%v body=%s", replayResponse.Code, replayResponse.Header(), replayResponse.Body.String())
	}
	conflictTarget := target.Add(time.Minute).Format(time.RFC3339Nano)
	conflictRequest := internalRequest(http.MethodPost, "/internal/v1/machines/"+machine.ID+"/extend", cfg.InternalToken, bytes.NewBufferString(`{"expires_at":"`+conflictTarget+`"}`))
	conflictRequest.Header.Set("X-Nehemiah-Lease-ID", "lease-right")
	conflictRequest.Header.Set("Idempotency-Key", "extend-1")
	conflictResponse := httptest.NewRecorder()
	server.ServeHTTP(conflictResponse, conflictRequest)
	if conflictResponse.Code != http.StatusConflict {
		t.Fatalf("extend conflict = %d %s", conflictResponse.Code, conflictResponse.Body.String())
	}
	missingKeyRequest := internalRequest(http.MethodPost, "/internal/v1/machines/"+machine.ID+"/extend", cfg.InternalToken, bytes.NewBufferString(extendBody))
	missingKeyRequest.Header.Set("X-Nehemiah-Lease-ID", "lease-right")
	missingKeyResponse := httptest.NewRecorder()
	server.ServeHTTP(missingKeyResponse, missingKeyRequest)
	if missingKeyResponse.Code != http.StatusBadRequest {
		t.Fatalf("missing extend key = %d %s", missingKeyResponse.Code, missingKeyResponse.Body.String())
	}

	wrongDelete := internalRequest(http.MethodDelete, "/internal/v1/machines/"+machine.ID, cfg.InternalToken, nil)
	wrongDelete.Header.Set("X-Nehemiah-Lease-ID", "lease-wrong")
	wrongResponse := httptest.NewRecorder()
	server.ServeHTTP(wrongResponse, wrongDelete)
	if wrongResponse.Code != http.StatusConflict || mgr.Count() != 1 {
		t.Fatalf("wrong-lease delete = %d count=%d", wrongResponse.Code, mgr.Count())
	}

	rightDelete := internalRequest(http.MethodDelete, "/internal/v1/machines/"+machine.ID, cfg.InternalToken, nil)
	rightDelete.Header.Set("X-Nehemiah-Lease-ID", "lease-right")
	rightResponse := httptest.NewRecorder()
	server.ServeHTTP(rightResponse, rightDelete)
	if rightResponse.Code != http.StatusNoContent || mgr.Count() != 0 {
		t.Fatalf("right-lease delete = %d count=%d", rightResponse.Code, mgr.Count())
	}
}

func TestInternalMachineRejectsCredentialMetadata(t *testing.T) {
	cfg := internalTestConfig(t)
	server := NewServer(cfg, NewManager(cfg))
	request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken,
		bytes.NewBufferString(`{"lease_id":"lease-1","metadata":{"api_token":"do-not-store"}}`))
	request.Header.Set("Idempotency-Key", "create-1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", response.Code, response.Body.String())
	}
}

func TestInternalCreateReturnsHostDraining(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.Draining = true
	server := NewServer(cfg, NewManager(cfg))
	request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken,
		bytes.NewBufferString(`{"lease_id":"lease-1"}`))
	request.Header.Set("Idempotency-Key", "create-1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !bytes.Contains(response.Body.Bytes(), []byte("host_draining")) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func managedRuntimeAPIServer(t *testing.T) (Config, *Manager, *Server, *atomic.Int32) {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.NehemiahMode = true
	cfg.JailerEnable = true
	cfg.StatePath = filepath.Join(t.TempDir(), "state.json")
	mgr := NewManager(cfg)
	mgr.cgroups = &Cgroups{cfg: cfg, base: t.TempDir(), enabled: true}
	mgr.identityAvailable = func(int, int) error { return nil }
	mgr.verifyIdentityTeardown = func(Config, string, jailerIdentity) error { return nil }
	mgr.readyProbe = func(context.Context, string) error { return nil }
	mgr.capacityProbe = staticHostProbe{hostResources{
		Architecture: "x86_64", KVM: true, Jailer: true, TotalCPU: 64,
		TotalMemoryMB: 64 * 1024, AvailableMemoryMB: 64 * 1024,
		TotalDiskBytes: 1 << 40, AvailableDiskBytes: 1 << 40,
	}}
	boots := &atomic.Int32{}
	mgr.boot = func(machineCfg Config, id string, template Template, _ string, _ bool, network bool, _ int) (*fcDriver, string, int64, error) {
		boots.Add(1)
		return &fcDriver{cfg: machineCfg, id: id, tpl: template, jailed: true, network: network, apiClt: harmlessFirecrackerClient()}, "coldboot", 1, nil
	}
	return cfg, mgr, NewServer(cfg, mgr), boots
}

func TestManagedInternalCreateRequiresExactRuntimeCohortAndRootfs(t *testing.T) {
	cfg, mgr, server, boots := managedRuntimeAPIServer(t)
	requestCreate := func(key, cohortID, rootfs string) *httptest.ResponseRecorder {
		payload, err := json.Marshal(internalCreateRequest{
			Template: "python", TTLSeconds: 120, LeaseID: "runtime-bound-lease",
			RuntimeCohortID: cohortID, RootfsSHA256: rootfs,
		})
		if err != nil {
			t.Fatal(err)
		}
		request := internalRequest(http.MethodPost, "/internal/v1/machines", cfg.InternalToken, bytes.NewReader(payload))
		request.Header.Set("Idempotency-Key", key)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	for _, test := range []struct {
		name     string
		cohortID string
		rootfs   string
	}{
		{name: "missing"},
		{name: "wrong cohort", cohortID: strings.Repeat("f", 64), rootfs: cfg.RuntimeCohort.PythonRootfsSHA256},
		{name: "wrong rootfs", cohortID: cfg.RuntimeCohort.ID, rootfs: cfg.RuntimeCohort.DesktopRootfsSHA256},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := requestCreate("runtime-invalid-"+strings.ReplaceAll(test.name, " ", "-"), test.cohortID, test.rootfs)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%s, want 422", response.Code, response.Body.String())
			}
		})
	}
	if boots.Load() != 0 {
		t.Fatalf("invalid runtime requests booted %d VMM(s)", boots.Load())
	}
	valid := requestCreate("runtime-valid", cfg.RuntimeCohort.ID, cfg.RuntimeCohort.PythonRootfsSHA256)
	if valid.Code != http.StatusCreated {
		t.Fatalf("valid status=%d body=%s", valid.Code, valid.Body.String())
	}
	replay := requestCreate("runtime-valid", cfg.RuntimeCohort.ID, cfg.RuntimeCohort.PythonRootfsSHA256)
	if replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" || boots.Load() != 1 {
		t.Fatalf("replay status=%d headers=%v boots=%d body=%s", replay.Code, replay.Header(), boots.Load(), replay.Body.String())
	}
	mgr.mu.Lock()
	var created *Machine
	for _, machine := range mgr.machines {
		created = machine
	}
	mgr.mu.Unlock()
	if created == nil || created.runtimeRootfsSHA256 != cfg.RuntimeCohort.PythonRootfsSHA256 {
		t.Fatalf("created runtime binding=%+v", created)
	}
	if _, err := mgr.DestroyInternal(created.ID); err != nil {
		t.Fatal(err)
	}
}

func TestManagedInternalForkRequiresBoundSourceAndExactRuntime(t *testing.T) {
	cfg, mgr, server, _ := managedRuntimeAPIServer(t)
	now := time.Now().UTC()
	source := &Machine{
		ID: "m-01020304", Status: "running", Template: "python", Ready: true,
		CreatedAt: now.Add(-time.Minute), StartedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Minute),
		LeaseID: "runtime-source-lease", VCPUs: 1, MemoryMB: 256, DiskMB: 5120,
		Metadata: map[string]string{"public_machine_id": "m_runtime_source"},
		driver:   &fcDriver{cfg: cfg, id: "m-01020304", tpl: cfg.Template("python"), apiClt: harmlessFirecrackerClient()},
	}
	mgr.mu.Lock()
	mgr.machines[source.ID] = source
	mgr.mu.Unlock()
	snapshots := &atomic.Int32{}
	mgr.createSnapshot = func(*fcDriver, string) (string, error) {
		snapshots.Add(1)
		return "", errors.New("injected snapshot stop")
	}
	call := func(key, cohortID, rootfs string) *httptest.ResponseRecorder {
		payload, err := json.Marshal(internalForkRequest{
			RuntimeCohortID: cohortID, RootfsSHA256: rootfs,
			Children: []internalForkChildRequest{{
				LeaseID: "runtime-child-lease", ExpiresAt: now.Add(30 * time.Second).Format(time.RFC3339Nano),
				VCPUs: 1, MemoryMB: 256, DiskMB: 5120,
				Metadata: map[string]string{
					"public_machine_id": "m_runtime_child", "parent_machine_id": "m_runtime_source",
					"fork_operation_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				},
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		request := internalRequest(http.MethodPost, "/internal/v1/machines/"+source.ID+"/fork", cfg.InternalToken, bytes.NewReader(payload))
		request.Header.Set("X-Nehemiah-Lease-ID", source.LeaseID)
		request.Header.Set("Idempotency-Key", key)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	missing := call("runtime-fork-missing", "", "")
	if missing.Code != http.StatusUnprocessableEntity || snapshots.Load() != 0 {
		t.Fatalf("missing binding status=%d snapshots=%d body=%s", missing.Code, snapshots.Load(), missing.Body.String())
	}
	unbound := call("runtime-fork-unbound-source", cfg.RuntimeCohort.ID, cfg.RuntimeCohort.PythonRootfsSHA256)
	if unbound.Code != http.StatusUnprocessableEntity || snapshots.Load() != 0 {
		t.Fatalf("unbound source status=%d snapshots=%d body=%s", unbound.Code, snapshots.Load(), unbound.Body.String())
	}
	source.runtimeRootfsSHA256 = cfg.RuntimeCohort.PythonRootfsSHA256
	accepted := call("runtime-fork-accepted", cfg.RuntimeCohort.ID, cfg.RuntimeCohort.PythonRootfsSHA256)
	if accepted.Code != http.StatusUnprocessableEntity || !bytes.Contains(accepted.Body.Bytes(), []byte(`"fork_batch_cleaned"`)) || snapshots.Load() != 1 {
		t.Fatalf("accepted binding status=%d snapshots=%d body=%s", accepted.Code, snapshots.Load(), accepted.Body.String())
	}
}

// A transport used by state/driver tests that need a harmless Firecracker API.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func harmlessFirecrackerClient() *http.Client {
	return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(bytes.NewReader(nil))}, nil
	})}
}

func TestCreateInternalConcurrentRetriesShareOneBoot(t *testing.T) {
	cfg := internalTestConfig(t)
	cfg.JailerEnable = true
	mgr := NewManager(cfg)
	mgr.readyProbe = func(context.Context, string) error { return nil }
	started := make(chan struct{})
	release := make(chan struct{})
	var boots atomic.Int32
	mgr.boot = func(cfg Config, id string, template Template, snapshot string, restoreNet, network bool, diskMB int) (*fcDriver, string, int64, error) {
		boots.Add(1)
		close(started)
		<-release
		return &fcDriver{cfg: cfg, id: id, tpl: template, jailed: true, apiClt: harmlessFirecrackerClient()}, "coldboot", 1, nil
	}
	type result struct {
		machine *Machine
		replay  bool
		err     error
	}
	results := make(chan result, 2)
	create := func() {
		machine, replay, err := mgr.CreateInternal("python", 120, false, true, "internal", "same-key", "lease-1", nil, 0, 0, 0)
		results <- result{machine, replay, err}
	}
	go create()
	<-started
	go create()
	close(release)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil || first.machine.ID != second.machine.ID {
		t.Fatalf("results differ: %+v %+v", first, second)
	}
	if first.replay == second.replay || boots.Load() != 1 {
		t.Fatalf("replay flags=%v/%v boots=%d", first.replay, second.replay, boots.Load())
	}
}
