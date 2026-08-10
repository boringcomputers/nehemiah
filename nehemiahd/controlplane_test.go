package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestControlPlaneEnrollmentAndHeartbeatContract(t *testing.T) {
	const (
		bootstrapCredential = "nhe_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
		controlCredential   = "host_control_abcdefghijklmnopqrstuvwxyz0123456789"
		gatewayCredential   = "host_gateway_abcdefghijklmnopqrstuvwxyz0123456789"
		heartbeatCredential = "host_heartbeat_abcdefghijklmnopqrstuvwxyz0123456789"
		registeredHostID    = "2ae33a17-9194-44ec-81fb-42cbe4822226"
	)
	var registrations atomic.Int32
	var heartbeats atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/v1/hosts/register":
			registrations.Add(1)
			if got := request.Header.Get("Authorization"); got != "Bearer "+bootstrapCredential {
				t.Errorf("registration Authorization = %q", got)
			}
			var payload hostRegistrationRequest
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Errorf("decode registration: %v", err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			if payload.ProviderID != "latitude-123" || payload.RegionID != "ca-tor-1" || payload.Address != "10.64.0.12" {
				t.Errorf("registration identity = %+v", payload)
			}
			if payload.Architecture != "x86_64" || payload.ControlToken != controlCredential || payload.GatewayToken != gatewayCredential {
				t.Errorf("registration architecture/control/gateway credential = %q/%q/%q", payload.Architecture, payload.ControlToken, payload.GatewayToken)
			}
			if payload.TotalVCPUs != 8 || payload.TotalMemoryMB != 16384 || payload.TotalDiskMB != 80*1024 {
				t.Errorf("registration capacity = %+v", payload)
			}
			if payload.RuntimeCohort != testRuntimeCohort() {
				t.Errorf("registration runtime cohort = %+v", payload.RuntimeCohort)
			}
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(response).Encode(hostRegistrationResponse{
				ID:                  registeredHostID,
				Credential:          heartbeatCredential,
				SecretDisplayedOnce: true,
			})
		case "/internal/v1/hosts/" + registeredHostID + "/heartbeat":
			heartbeats.Add(1)
			if got := request.Header.Get("Authorization"); got != "Bearer "+heartbeatCredential {
				t.Errorf("heartbeat Authorization = %q", got)
			}
			var payload hostHeartbeatRequest
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Errorf("decode heartbeat: %v", err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			if payload.State != "ready" || payload.AvailableVCPUs != 8 || payload.AvailableMemoryMB != 12288 {
				t.Errorf("heartbeat capacity = %+v", payload)
			}
			if payload.AvailableDiskMB != 50*1024 || payload.MachineCount != 0 || !payload.KVMAvailable || payload.DaemonVersion != Version {
				t.Errorf("heartbeat status = %+v", payload)
			}
			if payload.RuntimeCohort != testRuntimeCohort() {
				t.Errorf("heartbeat runtime cohort = %+v", payload.RuntimeCohort)
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected control-plane path %q", request.URL.Path)
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	enrollmentPath := filepath.Join(dir, "enrollment.json")
	environmentPath := filepath.Join(dir, "nehemiahd.env")
	environment := "NEHEMIAH_FLEET_BOOTSTRAP_TOKEN=" + bootstrapCredential + "\n" +
		"NEHEMIAH_INTERNAL_TOKEN=" + controlCredential + "\nNEHEMIAH_REGION=ca-tor-1\n"
	if err := os.WriteFile(environmentPath, []byte(environment), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN", bootstrapCredential)
	t.Setenv("BORING_FLEET_BOOTSTRAP_TOKEN", bootstrapCredential)

	cfg := internalTestConfig(t)
	cfg.Region = "ca-tor-1"
	cfg.InternalToken = controlCredential
	cfg.Token = gatewayCredential
	cfg.ControlPlaneURL = server.URL
	cfg.ControlPlaneHTTP = true
	cfg.FleetBootstrapToken = bootstrapCredential
	cfg.AdvertiseAddress = "10.64.0.12"
	cfg.ProviderID = "latitude-123"
	cfg.EnrollmentPath = enrollmentPath
	cfg.EnvironmentFile = environmentPath
	cfg.HeartbeatInterval = 10 * time.Second
	mgr := NewManager(cfg)
	probe := staticHostProbe{hostResources{
		Architecture:       "x86_64",
		KVM:                true,
		Jailer:             true,
		TotalCPU:           8,
		TotalMemoryMB:      16384,
		AvailableMemoryMB:  12288,
		TotalDiskBytes:     80 * 1024 * 1024 * 1024,
		AvailableDiskBytes: 50 * 1024 * 1024 * 1024,
	}}
	client := newControlPlaneClient(cfg, mgr)
	client.probe = probe
	if err := client.syncOnce(t.Context()); err != nil {
		t.Fatalf("initial synchronization: %v", err)
	}

	if registrations.Load() != 1 || heartbeats.Load() != 1 {
		t.Fatalf("requests registration/heartbeat = %d/%d, want 1/1", registrations.Load(), heartbeats.Load())
	}
	info, err := os.Stat(enrollmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("enrollment permissions = %04o, want 0600", info.Mode().Perm())
	}
	persisted, err := loadHostEnrollment(enrollmentPath, server.URL)
	if err != nil {
		t.Fatalf("load persisted enrollment: %v", err)
	}
	if persisted.HostID != registeredHostID || persisted.HeartbeatCredential != heartbeatCredential {
		t.Fatalf("persisted enrollment = %+v", persisted)
	}
	if _, present := os.LookupEnv("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN"); present {
		t.Fatal("fleet bootstrap token remains in the process environment")
	}
	if _, present := os.LookupEnv("BORING_FLEET_BOOTSTRAP_TOKEN"); present {
		t.Fatal("legacy fleet bootstrap token remains in the process environment")
	}
	environmentData, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(environmentData), "FLEET_BOOTSTRAP_TOKEN") || !strings.Contains(string(environmentData), "NEHEMIAH_INTERNAL_TOKEN=") {
		t.Fatalf("service environment was not safely scrubbed: %s", environmentData)
	}
	if info, err := os.Stat(environmentPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("service environment permissions: info=%v err=%v", info, err)
	}

	// A restart loads the one-time credential from the private enrollment file.
	// It must heartbeat without registering again or requiring the fleet token.
	restarted := newControlPlaneClient(cfg, mgr)
	restarted.cfg.FleetBootstrapToken = ""
	restarted.probe = probe
	if err := restarted.syncOnce(t.Context()); err != nil {
		t.Fatalf("restart synchronization: %v", err)
	}
	if registrations.Load() != 1 || heartbeats.Load() != 2 {
		t.Fatalf("restart requests registration/heartbeat = %d/%d, want 1/2", registrations.Load(), heartbeats.Load())
	}
}

func TestHostEnrollmentRejectsUnsafeState(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "enrollment.json")
	enrollment := hostEnrollment{
		Version:             controlPlaneEnrollmentVersion,
		ControlPlaneURL:     "https://control.example.test",
		HostID:              "2ae33a17-9194-44ec-81fb-42cbe4822226",
		HeartbeatCredential: "host_heartbeat_abcdefghijklmnopqrstuvwxyz0123456789",
		RegisteredAt:        time.Now().UTC(),
	}
	if err := saveHostEnrollment(path, enrollment); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostEnrollment(path, enrollment.ControlPlaneURL); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("loose enrollment permissions accepted: %v", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostEnrollment(path, "https://other.example.test"); err == nil || !strings.Contains(err.Error(), "different control-plane") {
		t.Fatalf("cross-control-plane enrollment accepted: %v", err)
	}
}

func TestMeteringDeliveryFailureStillReportsHostUnhealthy(t *testing.T) {
	const (
		hostID              = "2ae33a17-9194-44ec-81fb-42cbe4822226"
		heartbeatCredential = "host_heartbeat_abcdefghijklmnopqrstuvwxyz0123456789"
	)
	var usageRequests atomic.Int32
	var heartbeatRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/v1/hosts/" + hostID + "/usage-observations":
			usageRequests.Add(1)
			http.Error(response, "metering unavailable", http.StatusServiceUnavailable)
		case "/internal/v1/hosts/" + hostID + "/heartbeat":
			heartbeatRequests.Add(1)
			var payload hostHeartbeatRequest
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Errorf("decode heartbeat: %v", err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			if payload.State != "unhealthy" {
				t.Errorf("heartbeat state = %q, want unhealthy", payload.State)
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected control-plane path %q", request.URL.Path)
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	cfg := internalTestConfig(t)
	cfg.ControlPlaneURL = server.URL
	cfg.ControlPlaneHTTP = true
	cfg.NehemiahMode = true
	mgr := NewManager(cfg)
	mgr.meteringHealthy = false
	mgr.meteringOutbox = []hostUsageObservation{{
		LeaseID: "b35934cb-0c8f-45c1-8af4-1924fc619c1f", HostBootID: testHostBootID,
		LeaseGeneration: "1", Sequence: "1",
	}}
	client := newControlPlaneClient(cfg, mgr)
	client.enrollment = &hostEnrollment{
		Version: controlPlaneEnrollmentVersion, ControlPlaneURL: server.URL,
		HostID: hostID, HeartbeatCredential: heartbeatCredential, RegisteredAt: time.Now().UTC(),
	}
	client.probe = staticHostProbe{hostResources{
		Architecture: "x86_64", KVM: true, Jailer: true, TotalCPU: 8,
		TotalMemoryMB: 16384, AvailableMemoryMB: 12288,
		TotalDiskBytes: 80 * 1024 * 1024 * 1024, AvailableDiskBytes: 50 * 1024 * 1024 * 1024,
	}}
	if err := client.syncOnce(t.Context()); err == nil {
		t.Fatal("metering delivery failure was hidden")
	}
	if usageRequests.Load() != 1 || heartbeatRequests.Load() != 1 {
		t.Fatalf("usage/heartbeat requests = %d/%d, want 1/1", usageRequests.Load(), heartbeatRequests.Load())
	}
}

func TestHeartbeatPayloadRejectsUnknownState(t *testing.T) {
	if _, err := heartbeatPayload(hostStatus{State: "stale"}); err == nil {
		t.Fatal("unsupported host state was accepted")
	}
	if _, err := heartbeatPayload(hostStatus{State: "ready"}); err == nil {
		t.Fatal("heartbeat without a runtime cohort was accepted")
	}
}

func TestManagedRuntimeDriftStillReportsUnhealthyHeartbeat(t *testing.T) {
	const (
		hostID              = "2ae33a17-9194-44ec-81fb-42cbe4822226"
		heartbeatCredential = "host_heartbeat_abcdefghijklmnopqrstuvwxyz0123456789"
	)
	var heartbeatRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/v1/hosts/"+hostID+"/heartbeat" {
			t.Errorf("unexpected path %s", request.URL.Path)
			http.NotFound(response, request)
			return
		}
		heartbeatRequests.Add(1)
		var payload hostHeartbeatRequest
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode heartbeat: %v", err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		if payload.State != "unhealthy" || payload.RuntimeCohort != testRuntimeCohort() {
			t.Errorf("runtime-drift heartbeat=%+v", payload)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	fixture := newManagedNetworkFixture(t, "bt0123abcd", true)
	names, err := egressNamesForTap("bt0123abcd")
	if err != nil {
		t.Fatal(err)
	}
	fixture.outputs["iptables -S "+names.chain] = "-N " + names.chain
	fixture.cfg.ControlPlaneURL = server.URL
	fixture.cfg.ControlPlaneHTTP = true
	live := true
	isolated := false
	ops := fixture.ops()
	ops.listTaps = func() ([]string, error) {
		if live {
			return []string{"bt0123abcd"}, nil
		}
		return nil, nil
	}
	ops.isolateTap = func(tap string) error {
		if tap != "bt0123abcd" {
			t.Fatalf("unexpected isolated tap %s", tap)
		}
		isolated = true
		live = false
		return nil
	}
	mgr := NewManager(fixture.cfg)
	mgr.cgroups = &Cgroups{cfg: fixture.cfg, base: t.TempDir(), enabled: true}
	mgr.runtimeCohortCheck = func(Config) error { return nil }
	mgr.networkRuntime = ops
	client := newControlPlaneClient(fixture.cfg, mgr)
	client.enrollment = &hostEnrollment{
		Version: controlPlaneEnrollmentVersion, ControlPlaneURL: server.URL,
		HostID: hostID, HeartbeatCredential: heartbeatCredential, RegisteredAt: time.Now().UTC(),
	}
	client.probe = staticHostProbe{hostResources{
		Architecture: "x86_64", KVM: true, Jailer: true, TotalCPU: 8,
		TotalMemoryMB: 16384, AvailableMemoryMB: 12288,
		TotalDiskBytes: 80 * 1024 * 1024 * 1024, AvailableDiskBytes: 50 * 1024 * 1024 * 1024,
	}}
	if err := client.syncOnce(t.Context()); err == nil {
		t.Fatal("runtime drift was hidden by synchronization")
	}
	if heartbeatRequests.Load() != 1 || !isolated || live {
		t.Fatalf("heartbeats=%d isolated=%t live=%t", heartbeatRequests.Load(), isolated, live)
	}
}
