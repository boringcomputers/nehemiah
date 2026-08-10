package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var managedHostEventPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func captureApplicationLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	previousPrefix := log.Prefix()
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
		log.SetPrefix(previousPrefix)
	})
	return &output
}

func TestManagedHostLoggerDropsRawErrorsAndUnvalidatedFields(t *testing.T) {
	output := captureApplicationLog(t)
	const canary = "tenant-secret-command=/root/private;token=nhe_leaked"
	logManagedHostEvent(managedHostEventSnapshotRestoreFailed, managedHostLogFields{
		MachineID:       "m-1234abcd/" + canary,
		SourceMachineID: "../../" + canary,
		Err:             errors.New("firecracker response at /srv/jailer: " + canary),
		Count:           -1,
		Limit:           1 << 62,
	})

	got := output.String()
	if strings.Contains(got, canary) || strings.Contains(got, "/srv/jailer") || strings.Contains(got, "firecracker response") {
		t.Fatalf("managed log leaked injected data: %q", got)
	}
	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &record); err != nil {
		t.Fatalf("managed log is not JSON: %v (%q)", err, got)
	}
	if record["event"] != "snapshot_restore_failed" || record["error_type"] != "internal" {
		t.Fatalf("managed log classification = %#v", record)
	}
	for _, forbidden := range []string{"machine_id", "source_machine_id", "count", "limit"} {
		if _, present := record[forbidden]; present {
			t.Fatalf("unvalidated field %q reached managed log: %#v", forbidden, record)
		}
	}
}

func TestManagedHostLoggerAllowsValidatedIDsAndBoundedNumerics(t *testing.T) {
	output := captureApplicationLog(t)
	logManagedHostEvent(managedHostEventMachineForked, managedHostLogFields{
		MachineID: "m-1234abcd", SourceMachineID: "m-aabbccdd",
		Attempt: 2, Total: 4, DurationMS: 17,
	})

	var record managedHostLogRecord
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &record); err != nil {
		t.Fatalf("managed log is not JSON: %v", err)
	}
	if record.MachineID != "m-1234abcd" || record.SourceMachineID != "m-aabbccdd" || record.Attempt != 2 || record.Total != 4 || record.DurationMS != 17 {
		t.Fatalf("managed log fields = %#v", record)
	}
}

func TestManagedHostEventNamesAreCompleteFixedAndUnique(t *testing.T) {
	if len(managedHostEventName) != int(managedHostEventCount) {
		t.Fatalf("event table length = %d, want %d", len(managedHostEventName), managedHostEventCount)
	}
	seen := make(map[string]struct{}, len(managedHostEventName))
	for event, name := range managedHostEventName {
		if !managedHostEventPattern.MatchString(name) {
			t.Errorf("event %d has unsafe name %q", event, name)
		}
		if _, duplicate := seen[name]; duplicate {
			t.Errorf("duplicate managed event name %q", name)
		}
		seen[name] = struct{}{}
	}
}

func TestManagedHTTPErrorWriterDropsDefaultServerLogBytes(t *testing.T) {
	output := captureApplicationLog(t)
	const canary = "panic tenant-secret at /root/private command=shutdown"
	written, err := (managedHostHTTPErrorWriter{}).Write([]byte(canary))
	if err != nil || written != len(canary) {
		t.Fatalf("write = %d, %v", written, err)
	}
	if strings.Contains(output.String(), canary) || strings.Contains(output.String(), "/root/private") {
		t.Fatalf("managed HTTP error log leaked input: %q", output.String())
	}
	if !strings.Contains(output.String(), `"event":"http_runtime_error"`) || !strings.Contains(output.String(), `"error_type":"internal"`) {
		t.Fatalf("safe HTTP runtime event missing: %q", output.String())
	}
}

func TestManagedVNCUnavailableDoesNotExposeVsockError(t *testing.T) {
	output := captureApplicationLog(t)
	const canary = "raw-firecracker-body command=/root/private token=bc_secret"
	socket := filepath.Join(t.TempDir(), "vsock.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	serverDone := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer conn.Close()
		if _, readErr := bufio.NewReader(conn).ReadString('\n'); readErr != nil {
			serverDone <- readErr
			return
		}
		_, writeErr := conn.Write([]byte("REFUSED " + canary + "\n"))
		serverDone <- writeErr
	}()

	const machineID = "m-1234abcd"
	cfg := Config{NehemiahMode: true}
	mgr := &Manager{cfg: cfg, machines: map[string]*Machine{
		machineID: {ID: machineID, driver: &fcDriver{cfg: cfg, id: machineID, vsockUDS: socket}},
	}}
	srv := &Server{cfg: cfg, mgr: mgr, guestOps: newGuestOperationLimiter(), telemetry: &hostTelemetry{}}
	request := httptest.NewRequest(http.MethodGet, "/v1/machines/"+machineID+"/vnc", nil)
	request.SetPathValue("id", machineID)
	response := httptest.NewRecorder()
	srv.handleVNC(response, request)
	if serverErr := <-serverDone; serverErr != nil {
		t.Fatalf("fake vsock server: %v", serverErr)
	}

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body=%q", response.Code, response.Body.String())
	}
	if strings.TrimSpace(response.Body.String()) != `{"error":"vnc_unavailable"}` {
		t.Fatalf("body = %q", response.Body.String())
	}
	combined := response.Body.String() + output.String()
	if strings.Contains(combined, canary) || strings.Contains(combined, socket) {
		t.Fatalf("VNC response/log leaked vsock detail: response=%q log=%q", response.Body.String(), output.String())
	}
	if !strings.Contains(output.String(), `"event":"vnc_unavailable"`) || !strings.Contains(output.String(), `"error_type":"internal"`) {
		t.Fatalf("safe VNC log missing classification: %q", output.String())
	}
}
