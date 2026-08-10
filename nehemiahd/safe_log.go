package main

import (
	"encoding/json"
	"errors"
	"log"
	"time"
)

// managedHostEvent is deliberately closed: managed-fleet logs are selected
// from this enum instead of accepting an operator-, tenant-, guest-, path-, or
// error-controlled message. Add a new value only with a review of its fields.
type managedHostEvent uint8

const maxManagedHostLogNumeric int64 = 1<<53 - 1

const (
	managedHostEventInvalid managedHostEvent = iota
	managedHostEventConfigurationRejected
	managedHostEventPrerequisitesRejected
	managedHostEventRuntimeReconciliationFailed
	managedHostEventRuntimeReconciled
	managedHostEventEgressDNSStartFailed
	managedHostEventListenerFailed
	managedHostEventTelemetryInitializationFailed
	managedHostEventHTTPServerFailed
	managedHostEventHTTPRuntimeError
	managedHostEventListening
	managedHostEventShutdownStarted
	managedHostEventEgressDNSShutdownFailed
	managedHostEventHTTPShutdownFailed
	managedHostEventTelemetryShutdownFailed
	managedHostEventShutdownComplete
	managedHostEventControlPlaneSyncFailed
	managedHostEventRegistered
	managedHostEventBootstrapTokenCleanupFailed
	managedHostEventCgroupSetupFailed
	managedHostEventCgroupsEnabled
	managedHostEventStorageInitializationFailed
	managedHostEventStorageEnabled
	managedHostEventTemplatePublished
	managedHostEventWarmPoolBootFailed
	managedHostEventWarmPoolReadinessFailed
	managedHostEventWarmPoolReady
	managedHostEventWarmPoolClaimed
	managedHostEventCreateFailed
	managedHostEventVolumeAttachFailed
	managedHostEventPublishFailed
	managedHostEventBranchFailed
	managedHostEventResponseEncodeFailed
	managedHostEventStatePersistFailed
	managedHostEventStateQuarantined
	managedHostEventGuestTapMissing
	managedHostEventGuestNeighborPinFailed
	managedHostEventSnapshotRestoreFailed
	managedHostEventSnapshotResumeFailed
	managedHostEventSnapshotRootfsCopyFailed
	managedHostEventMachineCreated
	managedHostEventSnapshotCreateFailed
	managedHostEventMachineRestoreFailed
	managedHostEventCgroupPlaceFailed
	managedHostEventNetworkReaddressFailed
	managedHostEventEgressPolicyFailed
	managedHostEventMachineForked
	managedHostEventForkReservationPersistFailed
	managedHostEventForkTerminalPersistFailed
	managedHostEventForkReplayCleanupPersistFailed
	managedHostEventForkMeteringCapacityReached
	managedHostEventForkMeteringFinalizeFailed
	managedHostEventForkRollbackPersistFailed
	managedHostEventMachineDestroyDeferred
	managedHostEventMachineDestroyed
	managedHostEventMachineExpiryMeteringFailed
	managedHostEventMachineExpiryPersistFailed
	managedHostEventMachineExpired
	managedHostEventJailerIdentityReleaseFailed
	managedHostEventMeteringCheckpointFailed
	managedHostEventWebSocketUpgradeFailed
	managedHostEventEgressFloorRefreshFailed
	managedHostEventEgressFailClosedFailed
	managedHostEventOrphansReaped
	managedHostEventVNCUnavailable
	managedHostEventCount
)

var managedHostEventName = [...]string{
	managedHostEventInvalid:                        "invalid_log_event",
	managedHostEventConfigurationRejected:          "configuration_rejected",
	managedHostEventPrerequisitesRejected:          "prerequisites_rejected",
	managedHostEventRuntimeReconciliationFailed:    "runtime_reconciliation_failed",
	managedHostEventRuntimeReconciled:              "runtime_reconciled",
	managedHostEventEgressDNSStartFailed:           "egress_dns_start_failed",
	managedHostEventListenerFailed:                 "listener_failed",
	managedHostEventTelemetryInitializationFailed:  "telemetry_initialization_failed",
	managedHostEventHTTPServerFailed:               "http_server_failed",
	managedHostEventHTTPRuntimeError:               "http_runtime_error",
	managedHostEventListening:                      "listening",
	managedHostEventShutdownStarted:                "shutdown_started",
	managedHostEventEgressDNSShutdownFailed:        "egress_dns_shutdown_failed",
	managedHostEventHTTPShutdownFailed:             "http_shutdown_failed",
	managedHostEventTelemetryShutdownFailed:        "telemetry_shutdown_failed",
	managedHostEventShutdownComplete:               "shutdown_complete",
	managedHostEventControlPlaneSyncFailed:         "control_plane_sync_failed",
	managedHostEventRegistered:                     "registered",
	managedHostEventBootstrapTokenCleanupFailed:    "bootstrap_token_cleanup_failed",
	managedHostEventCgroupSetupFailed:              "cgroup_setup_failed",
	managedHostEventCgroupsEnabled:                 "cgroups_enabled",
	managedHostEventStorageInitializationFailed:    "storage_initialization_failed",
	managedHostEventStorageEnabled:                 "storage_enabled",
	managedHostEventTemplatePublished:              "template_published",
	managedHostEventWarmPoolBootFailed:             "warm_pool_boot_failed",
	managedHostEventWarmPoolReadinessFailed:        "warm_pool_readiness_failed",
	managedHostEventWarmPoolReady:                  "warm_pool_ready",
	managedHostEventWarmPoolClaimed:                "warm_pool_claimed",
	managedHostEventCreateFailed:                   "create_failed",
	managedHostEventVolumeAttachFailed:             "volume_attach_failed",
	managedHostEventPublishFailed:                  "publish_failed",
	managedHostEventBranchFailed:                   "branch_failed",
	managedHostEventResponseEncodeFailed:           "response_encode_failed",
	managedHostEventStatePersistFailed:             "state_persist_failed",
	managedHostEventStateQuarantined:               "state_quarantined",
	managedHostEventGuestTapMissing:                "guest_tap_missing",
	managedHostEventGuestNeighborPinFailed:         "guest_neighbor_pin_failed",
	managedHostEventSnapshotRestoreFailed:          "snapshot_restore_failed",
	managedHostEventSnapshotResumeFailed:           "snapshot_resume_failed",
	managedHostEventSnapshotRootfsCopyFailed:       "snapshot_rootfs_copy_failed",
	managedHostEventMachineCreated:                 "machine_created",
	managedHostEventSnapshotCreateFailed:           "snapshot_create_failed",
	managedHostEventMachineRestoreFailed:           "machine_restore_failed",
	managedHostEventCgroupPlaceFailed:              "cgroup_place_failed",
	managedHostEventNetworkReaddressFailed:         "network_readdress_failed",
	managedHostEventEgressPolicyFailed:             "egress_policy_failed",
	managedHostEventMachineForked:                  "machine_forked",
	managedHostEventForkReservationPersistFailed:   "fork_reservation_persist_failed",
	managedHostEventForkTerminalPersistFailed:      "fork_terminal_persist_failed",
	managedHostEventForkReplayCleanupPersistFailed: "fork_replay_cleanup_persist_failed",
	managedHostEventForkMeteringCapacityReached:    "fork_metering_capacity_reached",
	managedHostEventForkMeteringFinalizeFailed:     "fork_metering_finalize_failed",
	managedHostEventForkRollbackPersistFailed:      "fork_rollback_persist_failed",
	managedHostEventMachineDestroyDeferred:         "machine_destroy_deferred",
	managedHostEventMachineDestroyed:               "machine_destroyed",
	managedHostEventMachineExpiryMeteringFailed:    "machine_expiry_metering_failed",
	managedHostEventMachineExpiryPersistFailed:     "machine_expiry_persist_failed",
	managedHostEventMachineExpired:                 "machine_expired",
	managedHostEventJailerIdentityReleaseFailed:    "jailer_identity_release_failed",
	managedHostEventMeteringCheckpointFailed:       "metering_checkpoint_failed",
	managedHostEventWebSocketUpgradeFailed:         "websocket_upgrade_failed",
	managedHostEventEgressFloorRefreshFailed:       "egress_floor_refresh_failed",
	managedHostEventEgressFailClosedFailed:         "egress_fail_closed_failed",
	managedHostEventOrphansReaped:                  "orphans_reaped",
	managedHostEventVNCUnavailable:                 "vnc_unavailable",
}

// managedHostLogFields is intentionally limited to identifiers with existing
// strict validators, internal booleans, and non-negative numerics. err is never
// serialized: only its bounded classification is emitted.
type managedHostLogFields struct {
	MachineID       string
	SourceMachineID string
	Err             error
	Count           int64
	SecondaryCount  int64
	Attempt         int64
	Total           int64
	DurationMS      int64
	TTLSeconds      int64
	Limit           int64
	Persistent      bool
	Quarantined     bool
	AuthConfigured  bool
}

type managedHostLogRecord struct {
	Timestamp       string `json:"timestamp"`
	Event           string `json:"event"`
	MachineID       string `json:"machine_id,omitempty"`
	SourceMachineID string `json:"source_machine_id,omitempty"`
	ErrorType       string `json:"error_type,omitempty"`
	Count           int64  `json:"count,omitempty"`
	SecondaryCount  int64  `json:"secondary_count,omitempty"`
	Attempt         int64  `json:"attempt,omitempty"`
	Total           int64  `json:"total,omitempty"`
	DurationMS      int64  `json:"duration_ms,omitempty"`
	TTLSeconds      int64  `json:"ttl_seconds,omitempty"`
	Limit           int64  `json:"limit,omitempty"`
	Persistent      bool   `json:"persistent,omitempty"`
	Quarantined     bool   `json:"quarantined,omitempty"`
	AuthConfigured  bool   `json:"auth_configured,omitempty"`
}

// logManagedHostEvent is the sole managed-fleet application logger. It never
// formats an error or arbitrary string. This protects logs from guest output,
// Firecracker response bodies, commands, paths, credentials, and tenant data.
func logManagedHostEvent(event managedHostEvent, fields managedHostLogFields) {
	name := managedHostEventName[managedHostEventInvalid]
	if int(event) > 0 && int(event) < len(managedHostEventName) && managedHostEventName[event] != "" {
		name = managedHostEventName[event]
	}
	record := managedHostLogRecord{
		Timestamp:      time.Now().UTC().Format(time.RFC3339Nano),
		Event:          name,
		Persistent:     fields.Persistent,
		Quarantined:    fields.Quarantined,
		AuthConfigured: fields.AuthConfigured,
	}
	if validMachineID(fields.MachineID) {
		record.MachineID = fields.MachineID
	}
	if validMachineID(fields.SourceMachineID) {
		record.SourceMachineID = fields.SourceMachineID
	}
	if fields.Err != nil {
		record.ErrorType = safeTelemetryErrorType(fields.Err)
	}
	record.Count = managedHostLogNumeric(fields.Count)
	record.SecondaryCount = managedHostLogNumeric(fields.SecondaryCount)
	record.Attempt = managedHostLogNumeric(fields.Attempt)
	record.Total = managedHostLogNumeric(fields.Total)
	record.DurationMS = managedHostLogNumeric(fields.DurationMS)
	record.TTLSeconds = managedHostLogNumeric(fields.TTLSeconds)
	record.Limit = managedHostLogNumeric(fields.Limit)
	payload, _ := json.Marshal(record) // fixed primitive fields cannot fail
	log.Print(string(payload))
}

func managedHostLogNumeric(value int64) int64 {
	if value <= 0 || value > maxManagedHostLogNumeric {
		return 0
	}
	return value
}

var errManagedHostHTTPRuntime = errors.New("managed HTTP runtime error")

// managedHostHTTPErrorWriter is installed as net/http's ErrorLog sink. The
// standard server can otherwise echo panic values, request paths, or low-level
// connection errors directly into the process log.
type managedHostHTTPErrorWriter struct{}

func (managedHostHTTPErrorWriter) Write(raw []byte) (int, error) {
	logManagedHostEvent(managedHostEventHTTPRuntimeError, managedHostLogFields{Err: errManagedHostHTTPRuntime})
	return len(raw), nil
}
