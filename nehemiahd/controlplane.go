package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	controlPlaneEnrollmentVersion = 1
	controlPlaneResponseLimit     = 64 * 1024
	controlPlaneRequestTimeout    = 10 * time.Second
)

type hostEnrollment struct {
	Version             int       `json:"version"`
	ControlPlaneURL     string    `json:"control_plane_url"`
	HostID              string    `json:"host_id"`
	HeartbeatCredential string    `json:"heartbeat_credential"`
	RegisteredAt        time.Time `json:"registered_at"`
}

type hostRegistrationRequest struct {
	ProviderID    string               `json:"provider_id,omitempty"`
	RegionID      string               `json:"region_id"`
	Address       string               `json:"address"`
	Architecture  string               `json:"architecture"`
	ControlToken  string               `json:"control_token"`
	GatewayToken  string               `json:"gateway_token"`
	TotalVCPUs    int                  `json:"total_vcpus"`
	TotalMemoryMB int                  `json:"total_memory_mb"`
	TotalDiskMB   uint64               `json:"total_disk_mb"`
	RuntimeCohort managedRuntimeCohort `json:"runtime_cohort"`
}

type hostRegistrationResponse struct {
	ID                  string `json:"id"`
	Credential          string `json:"credential"`
	SecretDisplayedOnce bool   `json:"secret_displayed_once"`
}

type hostHeartbeatRequest struct {
	State             string               `json:"state"`
	AvailableVCPUs    int                  `json:"available_vcpus"`
	AvailableMemoryMB int                  `json:"available_memory_mb"`
	AvailableDiskMB   uint64               `json:"available_disk_mb"`
	MachineCount      int                  `json:"machine_count"`
	KVMAvailable      bool                 `json:"kvm_available"`
	DaemonVersion     string               `json:"daemon_version"`
	RuntimeCohort     managedRuntimeCohort `json:"runtime_cohort"`
}

// controlPlaneClient is deliberately outbound-only. The one-use host enrollment grant
// is used for exactly one successful enrollment, while subsequent heartbeats
// use the unique credential returned for this host.
type controlPlaneClient struct {
	cfg              Config
	mgr              *Manager
	probe            hostProbe
	httpClient       *http.Client
	enrollment       *hostEnrollment
	bootstrapCleaned bool
	telemetry        *hostTelemetry
}

func newControlPlaneClient(cfg Config, mgr *Manager, runtimes ...*hostTelemetry) *controlPlaneClient {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}
	telemetry := &hostTelemetry{}
	if len(runtimes) > 0 && runtimes[0] != nil {
		telemetry = runtimes[0]
	}
	return &controlPlaneClient{
		cfg:   cfg,
		mgr:   mgr,
		probe: systemHostProbe{},
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   controlPlaneRequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				// Never forward enrollment or heartbeat credentials across an
				// unexpected redirect. Operators must configure the canonical URL.
				return http.ErrUseLastResponse
			},
		},
		telemetry: telemetry,
	}
}

// Run enrolls the host, sends an immediate heartbeat, and then continues at a
// fixed interval. Failed attempts back off without ever falling back to the
// enrollment grant after enrollment.
func (client *controlPlaneClient) Run(ctx context.Context) {
	defer client.httpClient.CloseIdleConnections()
	backoff := time.Second
	for {
		err := client.syncOnce(ctx)
		if errors.Is(err, context.Canceled) || (errors.Is(err, context.DeadlineExceeded) && ctx.Err() != nil) {
			return
		}

		delay := client.cfg.HeartbeatInterval
		if delay <= 0 {
			delay = 10 * time.Second
		}
		if err != nil {
			logManagedHostEvent(managedHostEventControlPlaneSyncFailed, managedHostLogFields{Err: err})
			delay = backoff
			if backoff < 30*time.Second {
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
			}
		} else {
			backoff = time.Second
		}

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (client *controlPlaneClient) syncOnce(ctx context.Context) error {
	return client.telemetry.synchronize(ctx, client.synchronizeOnce)
}

func (client *controlPlaneClient) synchronizeOnce(ctx context.Context) error {
	if client.mgr == nil {
		return errors.New("control-plane client has no manager")
	}
	runtimeErr := client.mgr.validateManagedHostRuntime()
	enrollment, err := client.ensureEnrollment(ctx)
	if err != nil {
		return errors.Join(runtimeErr, err)
	}
	checkpointErr := client.mgr.checkpointMetering()
	// Delivery must remain available when checkpoint admission has stopped: that
	// is how a near-saturated durable outbox recovers while new work stays closed.
	submitErr := client.submitMetering(ctx, *enrollment)
	// The unhealthy heartbeat is equally important: it removes a saturated host
	// from scheduling even when observation delivery is failing independently.
	status := client.mgr.HostStatus(client.probe)
	heartbeatErr := client.heartbeat(ctx, *enrollment, status)
	if runtimeErr != nil || checkpointErr != nil || submitErr != nil || heartbeatErr != nil {
		return errors.Join(
			runtimeErr,
			wrapError("checkpoint metering", checkpointErr),
			submitErr,
			heartbeatErr,
		)
	}
	return nil
}

func wrapError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func (client *controlPlaneClient) submitMetering(ctx context.Context, enrollment hostEnrollment) error {
	pending := client.mgr.pendingMeteringBatch()
	if len(pending) == 0 {
		return nil
	}
	var response hostUsageObservationResponse
	path := "/internal/v1/hosts/" + url.PathEscape(enrollment.HostID) + "/usage-observations"
	if err := client.postJSON(
		ctx,
		path,
		enrollment.HeartbeatCredential,
		map[string]any{"observations": pending},
		http.StatusOK,
		&response,
	); err != nil {
		return fmt.Errorf("submit usage observations: %w", err)
	}
	if err := client.mgr.acknowledgeMeteringBatch(pending, response.Receipts); err != nil {
		return fmt.Errorf("acknowledge usage observations: %w", err)
	}
	return nil
}

func (client *controlPlaneClient) ensureEnrollment(ctx context.Context) (*hostEnrollment, error) {
	if client.enrollment != nil {
		client.discardBootstrapToken()
		return client.enrollment, nil
	}

	enrollment, err := loadHostEnrollment(client.cfg.EnrollmentPath, client.controlPlaneBaseURL())
	if err == nil {
		client.enrollment = &enrollment
		client.discardBootstrapToken()
		return client.enrollment, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("load host enrollment: %w", err)
	}
	if !validBearerCredential(client.cfg.FleetBootstrapToken) {
		return nil, errors.New("host is not enrolled and NEHEMIAH_FLEET_BOOTSTRAP_TOKEN is missing or invalid")
	}

	status := client.mgr.HostStatus(client.probe)
	registered, err := client.register(ctx, status)
	if err != nil {
		return nil, err
	}
	if err := saveHostEnrollment(client.cfg.EnrollmentPath, registered); err != nil {
		return nil, fmt.Errorf("persist host enrollment: %w", err)
	}
	client.enrollment = &registered
	client.discardBootstrapToken()
	logManagedHostEvent(managedHostEventRegistered, managedHostLogFields{})
	return client.enrollment, nil
}

func (client *controlPlaneClient) register(ctx context.Context, status hostStatus) (hostEnrollment, error) {
	totalDiskMB := status.TotalDiskBytes / (1024 * 1024)
	if status.TotalCPU <= 0 || status.TotalMemoryMB <= 0 || totalDiskMB == 0 {
		return hostEnrollment{}, errors.New("host capacity is unavailable; refusing incomplete registration")
	}
	if err := status.RuntimeCohort.Validate(); err != nil {
		return hostEnrollment{}, fmt.Errorf("host runtime cohort is unavailable: %w", err)
	}
	if status.RuntimeCohort != client.cfg.RuntimeCohort {
		return hostEnrollment{}, errors.New("host runtime cohort changed before registration")
	}
	request := hostRegistrationRequest{
		ProviderID:    client.cfg.ProviderID,
		RegionID:      client.cfg.Region,
		Address:       client.cfg.AdvertiseAddress,
		Architecture:  status.Architecture,
		ControlToken:  client.cfg.InternalToken,
		GatewayToken:  client.cfg.Token,
		TotalVCPUs:    status.TotalCPU,
		TotalMemoryMB: status.TotalMemoryMB,
		TotalDiskMB:   totalDiskMB,
		RuntimeCohort: status.RuntimeCohort,
	}
	var response hostRegistrationResponse
	if err := client.postJSON(ctx, "/internal/v1/hosts/register", client.cfg.FleetBootstrapToken, request, http.StatusCreated, &response); err != nil {
		return hostEnrollment{}, fmt.Errorf("register host: %w", err)
	}
	if !hostIdentityPattern.MatchString(response.ID) {
		return hostEnrollment{}, errors.New("register host: control plane returned an invalid host id")
	}
	if !validBearerCredential(response.Credential) {
		return hostEnrollment{}, errors.New("register host: control plane returned an invalid heartbeat credential")
	}
	return hostEnrollment{
		Version:             controlPlaneEnrollmentVersion,
		ControlPlaneURL:     client.controlPlaneBaseURL(),
		HostID:              response.ID,
		HeartbeatCredential: response.Credential,
		RegisteredAt:        time.Now().UTC(),
	}, nil
}

func (client *controlPlaneClient) heartbeat(ctx context.Context, enrollment hostEnrollment, status hostStatus) error {
	if status.RuntimeCohort != client.cfg.RuntimeCohort {
		return errors.New("heartbeat runtime cohort does not match the configured host cohort")
	}
	payload, err := heartbeatPayload(status)
	if err != nil {
		return err
	}
	path := "/internal/v1/hosts/" + url.PathEscape(enrollment.HostID) + "/heartbeat"
	if err := client.postJSON(ctx, path, enrollment.HeartbeatCredential, payload, http.StatusNoContent, nil); err != nil {
		return fmt.Errorf("heartbeat host: %w", err)
	}
	return nil
}

func heartbeatPayload(status hostStatus) (hostHeartbeatRequest, error) {
	switch status.State {
	case "ready", "draining", "unhealthy":
	default:
		return hostHeartbeatRequest{}, fmt.Errorf("unsupported host state %q", status.State)
	}
	if status.AvailableCPU < 0 || status.AvailableMemoryMB < 0 || status.Machines.Total < 0 {
		return hostHeartbeatRequest{}, errors.New("host status contains a negative capacity")
	}
	if err := status.RuntimeCohort.Validate(); err != nil {
		return hostHeartbeatRequest{}, fmt.Errorf("host runtime cohort is unavailable: %w", err)
	}
	return hostHeartbeatRequest{
		State:             status.State,
		AvailableVCPUs:    status.AvailableCPU,
		AvailableMemoryMB: status.AvailableMemoryMB,
		AvailableDiskMB:   status.AvailableDiskBytes / (1024 * 1024),
		MachineCount:      status.Machines.Total,
		KVMAvailable:      status.KVM,
		DaemonVersion:     status.Version,
		RuntimeCohort:     status.RuntimeCohort,
	}, nil
}

func (client *controlPlaneClient) postJSON(ctx context.Context, path, credential string, payload any, wantStatus int, output any) error {
	if !validBearerCredential(credential) {
		return errors.New("outbound credential is missing or invalid")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	endpoint := client.controlPlaneBaseURL() + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+credential)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "nehemiahd/"+Version)
	client.telemetry.inject(ctx, request.Header)

	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, controlPlaneResponseLimit+1))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if len(responseBody) > controlPlaneResponseLimit {
		return errors.New("control plane response exceeds size limit")
	}
	if response.StatusCode != wantStatus {
		// Do not include a remote response body: it may contain reflected request
		// data and enrollment credentials must never enter daemon logs.
		return fmt.Errorf("control plane returned HTTP %d", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (client *controlPlaneClient) controlPlaneBaseURL() string {
	return strings.TrimRight(client.cfg.ControlPlaneURL, "/")
}

func validBearerCredential(value string) bool {
	if len(value) < 32 || len(value) > 4096 {
		return false
	}
	return bearerCredentialPattern.MatchString(value)
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func loadHostEnrollment(path, controlPlaneURL string) (hostEnrollment, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return hostEnrollment{}, err
	}
	if !info.Mode().IsRegular() {
		return hostEnrollment{}, errors.New("enrollment path is not a regular file")
	}
	if info.Mode().Perm() != 0o600 {
		return hostEnrollment{}, fmt.Errorf("enrollment file permissions are %04o, want 0600", info.Mode().Perm())
	}
	if info.Size() > controlPlaneResponseLimit {
		return hostEnrollment{}, errors.New("enrollment file exceeds size limit")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return hostEnrollment{}, err
	}
	var enrollment hostEnrollment
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&enrollment); err != nil {
		return hostEnrollment{}, fmt.Errorf("decode enrollment: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return hostEnrollment{}, fmt.Errorf("decode enrollment: %w", err)
	}
	if enrollment.Version != controlPlaneEnrollmentVersion {
		return hostEnrollment{}, fmt.Errorf("unsupported enrollment version %d", enrollment.Version)
	}
	if enrollment.ControlPlaneURL != strings.TrimRight(controlPlaneURL, "/") {
		return hostEnrollment{}, errors.New("enrollment belongs to a different control-plane URL")
	}
	if !hostIdentityPattern.MatchString(enrollment.HostID) || !validBearerCredential(enrollment.HeartbeatCredential) || enrollment.RegisteredAt.IsZero() {
		return hostEnrollment{}, errors.New("enrollment contains invalid identity or credential data")
	}
	return enrollment, nil
}

func saveHostEnrollment(path string, enrollment hostEnrollment) error {
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("enrollment path must be absolute")
	}
	data, err := json.MarshalIndent(enrollment, "", "  ")
	if err != nil {
		return fmt.Errorf("encode enrollment: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create enrollment directory: %w", err)
	}
	directoryInfo, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("inspect enrollment directory: %w", err)
	}
	if !directoryInfo.IsDir() || directoryInfo.Mode().Perm()&0o077 != 0 {
		return errors.New("enrollment directory must be private (mode 0700 or stricter)")
	}
	return atomicWritePrivateFile(path, data)
}

func atomicWritePrivateFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary file: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("write temporary file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace file: %w", err)
	}
	committed = true
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func (client *controlPlaneClient) discardBootstrapToken() {
	if client.bootstrapCleaned {
		return
	}
	client.cfg.FleetBootstrapToken = ""
	_ = os.Unsetenv("NEHEMIAH_FLEET_BOOTSTRAP_TOKEN")
	_ = os.Unsetenv("BORING_FLEET_BOOTSTRAP_TOKEN")
	paths := []string{client.cfg.EnvironmentFile}
	if client.cfg.EnvironmentFile == "/etc/boring/nehemiahd.env" {
		// The systemd unit also reads this pre-rename file first. Scrub it so a
		// legacy BORING_* value cannot reappear on the next daemon restart.
		paths = append(paths, "/etc/boring/boringd.env")
	}
	for _, path := range paths {
		if err := removeBootstrapTokenFromEnvFile(path); err != nil {
			logManagedHostEvent(managedHostEventBootstrapTokenCleanupFailed, managedHostLogFields{Err: err})
			return
		}
	}
	client.bootstrapCleaned = true
}

func removeBootstrapTokenFromEnvFile(path string) error {
	if path == "" {
		return nil
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("service environment path is not a regular file")
	}
	if info.Size() > 1024*1024 {
		return errors.New("service environment file exceeds size limit")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	filtered := make([]string, 0, len(lines))
	removed := false
	for _, line := range lines {
		name := strings.TrimSpace(line)
		name = strings.TrimPrefix(name, "export ")
		if before, _, ok := strings.Cut(name, "="); ok {
			before = strings.TrimSpace(before)
			if before == "NEHEMIAH_FLEET_BOOTSTRAP_TOKEN" || before == "BORING_FLEET_BOOTSTRAP_TOKEN" {
				removed = true
				continue
			}
		}
		filtered = append(filtered, line)
	}
	if !removed {
		return nil
	}
	return atomicWritePrivateFile(path, []byte(strings.Join(filtered, "\n")))
}
