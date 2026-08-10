package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

var (
	ErrTemplateTransfersDisabled = errors.New("durable template transfers are disabled")
	ErrTemplateTransferInvalid   = errors.New("invalid durable template transfer")
	ErrTemplateTransferConflict  = errors.New("durable template transfer conflicts with existing state")
	ErrTemplateTransferIntegrity = errors.New("durable template artifact failed integrity verification")
	ErrTemplateTransferUpstream  = errors.New("durable template object transfer failed")
)

var (
	templateExportIDPattern = regexp.MustCompile(`^te_[0-9a-f]{32}$`)
	managedTemplatePattern  = regexp.MustCompile(`^t-[0-9a-f]{29}$`)
	templateDigestPattern   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

const (
	templateExportSchema     = 1
	templateExportLifetime   = 30 * time.Minute
	maximumTemplateGrantTTL  = 15 * time.Minute
	maximumTemplateArtifact  = int64(5 * 1024 * 1024 * 1024)
	maximumTemplateMetadata  = int64(64 * 1024)
	maximumTemplateSnapshot  = int64(1024 * 1024 * 1024)
	maximumTransferErrorBody = int64(4096)
	templateArtifactFilename = "artifact.tar.zst"
	templateExportRecordName = "export.json"
	templateSnapshotFilename = "snapshot_file"
	templateMemoryFilename   = "mem_file"
	templateRootfsFilename   = "rootfs.ext4"
	templateMetadataFilename = "meta.json"
)

type templateArtifact struct {
	Checksum  string `json:"checksum"`
	SizeBytes int64  `json:"size_bytes"`
}

type templateExportView struct {
	ExportID string `json:"export_id"`
	templateArtifact
}

type templateExportRecord struct {
	SchemaVersion int       `json:"schema_version"`
	ExportID      string    `json:"export_id"`
	MachineID     string    `json:"machine_id"`
	LeaseID       string    `json:"lease_id"`
	Checksum      string    `json:"checksum"`
	SizeBytes     int64     `json:"size_bytes"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	Uploaded      bool      `json:"uploaded"`
}

type scopedTemplateGrant struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expires_at"`
}

type validatedTemplateGrant struct {
	URL       *url.URL
	Headers   map[string]string
	ExpiresAt time.Time
}

func (mgr *Manager) templateExportsDir() string {
	return filepath.Join(mgr.cfg.RunDir, "template-exports")
}

func (mgr *Manager) templateExportDir(exportID string) string {
	return filepath.Join(mgr.templateExportsDir(), exportID)
}

func validTemplateArtifact(artifact templateArtifact) bool {
	return templateDigestPattern.MatchString(artifact.Checksum) && artifact.SizeBytes > 0 && artifact.SizeBytes <= maximumTemplateArtifact
}

func sameOpaqueValue(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (mgr *Manager) currentTemplateSource(machineID, leaseID string) (*Machine, *fcDriver, templateMeta, error) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	machine := mgr.machines[machineID]
	if machine == nil || machine.pooled || machine.driver == nil {
		return nil, nil, templateMeta{}, ErrNotFound
	}
	if !sameOpaqueValue(machine.LeaseID, leaseID) {
		return nil, nil, templateMeta{}, ErrInvalidLease
	}
	if machine.Status != "running" || !machine.Ready || (!machine.Persistent && !machine.ExpiresAt.After(time.Now())) {
		return nil, nil, templateMeta{}, ErrForkSourceNotReady
	}
	tpl := mgr.cfg.Template(machine.Template)
	meta := templateMeta{
		MemSizeMB:      machine.MemoryMB,
		VCPUs:          machine.VCPUs,
		DiskMB:         machine.DiskMB,
		Vsock:          tpl.Vsock,
		Display:        tpl.Display,
		InitPath:       tpl.InitPath,
		HadNIC:         machine.driver.tap != "",
		SourceTemplate: machine.Template,
		Architecture:   nehemiahArchitecture(runtime.GOARCH),
		CreatedAt:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	return machine, machine.driver, meta, nil
}

// ExportManagedTemplate snapshots only the current machine lease and writes a
// durable local archive before any object-store capability is requested.
func (mgr *Manager) ExportManagedTemplate(machineID, leaseID, exportID string) (templateExportView, error) {
	if mgr.cfg.TemplateObjectOrigin == "" {
		return templateExportView{}, ErrTemplateTransfersDisabled
	}
	if !validMachineID(machineID) || !templateExportIDPattern.MatchString(exportID) || leaseID == "" {
		return templateExportView{}, ErrTemplateTransferInvalid
	}
	mgr.templateMu.Lock()
	defer mgr.templateMu.Unlock()
	mgr.cleanupTemplateExportsLocked(time.Now())

	if record, err := mgr.loadTemplateExportLocked(exportID); err == nil {
		if record.MachineID != machineID || !sameOpaqueValue(record.LeaseID, leaseID) {
			return templateExportView{}, ErrTemplateTransferConflict
		}
		artifact := templateArtifact{Checksum: record.Checksum, SizeBytes: record.SizeBytes}
		if err := verifyTemplateFile(filepath.Join(mgr.templateExportDir(exportID), templateArtifactFilename), artifact); err != nil {
			_ = os.RemoveAll(mgr.templateExportDir(exportID))
			return templateExportView{}, ErrTemplateTransferIntegrity
		}
		return templateExportView{ExportID: exportID, templateArtifact: artifact}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return templateExportView{}, ErrTemplateTransferIntegrity
	}

	source, driver, meta, err := mgr.currentTemplateSource(machineID, leaseID)
	if err != nil {
		return templateExportView{}, err
	}
	source.snapshotMu.Lock()
	current, currentDriver, currentMeta, err := mgr.currentTemplateSource(machineID, leaseID)
	if err != nil || current != source || currentDriver != driver {
		source.snapshotMu.Unlock()
		if err != nil {
			return templateExportView{}, err
		}
		return templateExportView{}, ErrForkSourceNotReady
	}
	meta = currentMeta
	snapshotID := "tplx-" + strings.TrimPrefix(exportID, "te_")[:16]
	snapshotDir, snapshotErr := mgr.createSnapshot(driver, snapshotID)
	source.snapshotMu.Unlock()
	if snapshotErr != nil {
		return templateExportView{}, fmt.Errorf("%w: snapshot", ErrSnapshotUnavailable)
	}
	defer os.RemoveAll(snapshotDir)
	metadata, err := json.MarshalIndent(meta, "", "  ")
	if err != nil || len(metadata) == 0 || int64(len(metadata)) > maximumTemplateMetadata {
		return templateExportView{}, ErrTemplateTransferIntegrity
	}
	if err := os.WriteFile(filepath.Join(snapshotDir, templateMetadataFilename), metadata, 0o644); err != nil {
		return templateExportView{}, fmt.Errorf("%w: stage metadata", ErrTemplateTransferIntegrity)
	}

	root := mgr.templateExportsDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return templateExportView{}, fmt.Errorf("%w: create export root", ErrTemplateTransferUpstream)
	}
	building, err := os.MkdirTemp(root, ".building-")
	if err != nil {
		return templateExportView{}, fmt.Errorf("%w: create export staging", ErrTemplateTransferUpstream)
	}
	defer os.RemoveAll(building)
	if err := os.Chmod(building, 0o700); err != nil {
		return templateExportView{}, fmt.Errorf("%w: secure export staging", ErrTemplateTransferUpstream)
	}
	artifact, err := writeTemplateArchive(snapshotDir, filepath.Join(building, templateArtifactFilename))
	if err != nil {
		return templateExportView{}, err
	}
	now := time.Now().UTC()
	record := templateExportRecord{
		SchemaVersion: templateExportSchema,
		ExportID:      exportID,
		MachineID:     machineID,
		LeaseID:       leaseID,
		Checksum:      artifact.Checksum,
		SizeBytes:     artifact.SizeBytes,
		CreatedAt:     now,
		ExpiresAt:     now.Add(templateExportLifetime),
	}
	if err := writeTemplateExportRecord(filepath.Join(building, templateExportRecordName), record); err != nil {
		return templateExportView{}, err
	}
	if err := os.Rename(building, mgr.templateExportDir(exportID)); err != nil {
		return templateExportView{}, fmt.Errorf("%w: publish export staging", ErrTemplateTransferConflict)
	}
	return templateExportView{ExportID: exportID, templateArtifact: artifact}, nil
}

// UploadManagedTemplateExport sends the precomputed immutable bytes through a
// checksum/size-bound PUT grant. The export remains replayable until discarded.
func (mgr *Manager) UploadManagedTemplateExport(machineID, leaseID, exportID string, expected templateArtifact, grant scopedTemplateGrant) (templateArtifact, error) {
	if mgr.cfg.TemplateObjectOrigin == "" {
		return templateArtifact{}, ErrTemplateTransfersDisabled
	}
	if !validMachineID(machineID) || !templateExportIDPattern.MatchString(exportID) || !validTemplateArtifact(expected) {
		return templateArtifact{}, ErrTemplateTransferInvalid
	}
	mgr.templateMu.Lock()
	defer mgr.templateMu.Unlock()
	mgr.cleanupTemplateExportsLocked(time.Now())
	if _, _, _, err := mgr.currentTemplateSource(machineID, leaseID); err != nil {
		return templateArtifact{}, err
	}
	record, err := mgr.loadTemplateExportLocked(exportID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return templateArtifact{}, ErrNotFound
		}
		return templateArtifact{}, ErrTemplateTransferIntegrity
	}
	if record.MachineID != machineID || !sameOpaqueValue(record.LeaseID, leaseID) || record.Checksum != expected.Checksum || record.SizeBytes != expected.SizeBytes {
		return templateArtifact{}, ErrTemplateTransferConflict
	}
	artifactPath := filepath.Join(mgr.templateExportDir(exportID), templateArtifactFilename)
	if err := verifyTemplateFile(artifactPath, expected); err != nil {
		return templateArtifact{}, ErrTemplateTransferIntegrity
	}
	if record.Uploaded {
		return expected, nil
	}
	validated, err := mgr.validateTemplateGrant(grant, http.MethodPut, expected)
	if err != nil {
		return templateArtifact{}, err
	}
	if err := putTemplateArtifact(artifactPath, expected, validated); err != nil {
		return templateArtifact{}, err
	}
	record.Uploaded = true
	if err := writeTemplateExportRecord(filepath.Join(mgr.templateExportDir(exportID), templateExportRecordName), record); err != nil {
		return templateArtifact{}, err
	}
	return expected, nil
}

// DiscardManagedTemplateExport is idempotent but remains bound to the source
// machine and lease, preventing one tenant operation from deleting another.
func (mgr *Manager) DiscardManagedTemplateExport(machineID, leaseID, exportID string) error {
	if !validMachineID(machineID) || !templateExportIDPattern.MatchString(exportID) {
		return ErrTemplateTransferInvalid
	}
	mgr.templateMu.Lock()
	defer mgr.templateMu.Unlock()
	record, err := mgr.loadTemplateExportLocked(exportID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return ErrTemplateTransferIntegrity
	}
	if record.MachineID != machineID || !sameOpaqueValue(record.LeaseID, leaseID) {
		return ErrTemplateTransferConflict
	}
	return os.RemoveAll(mgr.templateExportDir(exportID))
}

// ActivateManagedTemplate downloads, hashes, safely extracts, verifies, and
// atomically installs a durable artifact under its control-plane-selected
// opaque host name. Replays return the already verified artifact identity.
func (mgr *Manager) ActivateManagedTemplate(name, format, architecture string, expected templateArtifact, grant scopedTemplateGrant) (templateArtifact, error) {
	if mgr.cfg.TemplateObjectOrigin == "" {
		return templateArtifact{}, ErrTemplateTransfersDisabled
	}
	if !managedTemplatePattern.MatchString(name) || format != "firecracker-snapshot-v1" || architecture != nehemiahArchitecture(runtime.GOARCH) || !validTemplateArtifact(expected) {
		return templateArtifact{}, ErrTemplateTransferInvalid
	}
	mgr.templateMu.Lock()
	defer mgr.templateMu.Unlock()
	if installed, found, err := installedTemplateArtifact(mgr.cfg, name); found || err != nil {
		if err != nil || installed != expected {
			return templateArtifact{}, ErrTemplateTransferConflict
		}
		return installed, nil
	}
	validated, err := mgr.validateTemplateGrant(grant, http.MethodGet, expected)
	if err != nil {
		return templateArtifact{}, err
	}
	if err := os.MkdirAll(mgr.cfg.TemplatesDir, 0o755); err != nil {
		return templateArtifact{}, fmt.Errorf("%w: create template root", ErrTemplateTransferUpstream)
	}
	staging, err := os.MkdirTemp(mgr.cfg.TemplatesDir, ".activate-")
	if err != nil {
		return templateArtifact{}, fmt.Errorf("%w: create activation staging", ErrTemplateTransferUpstream)
	}
	defer os.RemoveAll(staging)
	artifactPath := filepath.Join(staging, templateArtifactFilename)
	if err := downloadTemplateArtifact(artifactPath, expected, validated); err != nil {
		return templateArtifact{}, err
	}
	installDir := filepath.Join(staging, "install")
	if err := os.Mkdir(installDir, 0o755); err != nil {
		return templateArtifact{}, fmt.Errorf("%w: create install staging", ErrTemplateTransferUpstream)
	}
	meta, err := extractTemplateArchive(mgr.cfg, artifactPath, installDir, architecture)
	if err != nil {
		return templateArtifact{}, err
	}
	meta.ArtifactSHA256 = expected.Checksum
	meta.ArtifactBytes = expected.SizeBytes
	metadata, err := json.MarshalIndent(meta, "", "  ")
	if err != nil || int64(len(metadata)) > maximumTemplateMetadata {
		return templateArtifact{}, ErrTemplateTransferIntegrity
	}
	if err := atomicWriteFile(filepath.Join(installDir, templateMetadataFilename), metadata, 0o644); err != nil {
		return templateArtifact{}, fmt.Errorf("%w: finalize metadata", ErrTemplateTransferUpstream)
	}
	if err := os.Remove(artifactPath); err != nil {
		return templateArtifact{}, fmt.Errorf("%w: remove activation archive", ErrTemplateTransferUpstream)
	}
	target := filepath.Join(mgr.cfg.TemplatesDir, name)
	if err := os.Rename(installDir, target); err != nil {
		if installed, found, verifyErr := installedTemplateArtifact(mgr.cfg, name); found && verifyErr == nil && installed == expected {
			return installed, nil
		}
		return templateArtifact{}, ErrTemplateTransferConflict
	}
	if err := syncDirectory(mgr.cfg.TemplatesDir); err != nil {
		return templateArtifact{}, fmt.Errorf("%w: sync template root", ErrTemplateTransferUpstream)
	}
	return expected, nil
}

func (mgr *Manager) CleanupTemplateTransfers() {
	mgr.templateMu.Lock()
	defer mgr.templateMu.Unlock()
	mgr.cleanupTemplateExportsLocked(time.Now())
}

func (mgr *Manager) cleanupTemplateExportsLocked(now time.Time) {
	entries, err := os.ReadDir(mgr.templateExportsDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(mgr.templateExportsDir(), entry.Name())
		if strings.HasPrefix(entry.Name(), ".building-") {
			if info, statErr := entry.Info(); statErr == nil && now.Sub(info.ModTime()) > templateExportLifetime {
				_ = os.RemoveAll(path)
			}
			continue
		}
		if !entry.IsDir() || !templateExportIDPattern.MatchString(entry.Name()) {
			continue
		}
		record, loadErr := mgr.loadTemplateExportLocked(entry.Name())
		if loadErr != nil || !record.ExpiresAt.After(now) {
			_ = os.RemoveAll(path)
		}
	}
}

func (mgr *Manager) loadTemplateExportLocked(exportID string) (templateExportRecord, error) {
	var record templateExportRecord
	if !templateExportIDPattern.MatchString(exportID) {
		return record, ErrTemplateTransferInvalid
	}
	directory := mgr.templateExportDir(exportID)
	info, err := os.Lstat(directory)
	if err != nil {
		return record, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return record, ErrTemplateTransferIntegrity
	}
	data, err := os.ReadFile(filepath.Join(directory, templateExportRecordName))
	if err != nil {
		return record, err
	}
	if len(data) == 0 || int64(len(data)) > maximumTemplateMetadata || json.Unmarshal(data, &record) != nil || record.SchemaVersion != templateExportSchema || record.ExportID != exportID || !validMachineID(record.MachineID) || record.LeaseID == "" || !validTemplateArtifact(templateArtifact{Checksum: record.Checksum, SizeBytes: record.SizeBytes}) || record.CreatedAt.IsZero() || !record.ExpiresAt.After(record.CreatedAt) || record.ExpiresAt.Sub(record.CreatedAt) > templateExportLifetime {
		return templateExportRecord{}, ErrTemplateTransferIntegrity
	}
	return record, nil
}

func writeTemplateExportRecord(path string, record templateExportRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("%w: encode export record", ErrTemplateTransferUpstream)
	}
	if err := atomicWriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("%w: persist export record", ErrTemplateTransferUpstream)
	}
	return nil
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".write-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func writeTemplateArchive(sourceDir, destination string) (artifact templateArtifact, resultErr error) {
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return artifact, fmt.Errorf("%w: create archive", ErrTemplateTransferUpstream)
	}
	defer func() {
		if resultErr != nil {
			file.Close()
			_ = os.Remove(destination)
		}
	}()
	hash := sha256.New()
	encoder, err := zstd.NewWriter(io.MultiWriter(file, hash), zstd.WithEncoderConcurrency(1), zstd.WithEncoderLevel(zstd.SpeedDefault))
	if err != nil {
		return artifact, fmt.Errorf("%w: initialize archive", ErrTemplateTransferUpstream)
	}
	archive := tar.NewWriter(encoder)
	for _, name := range []string{templateMemoryFilename, templateMetadataFilename, templateRootfsFilename, templateSnapshotFilename} {
		path := filepath.Join(sourceDir, name)
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
			archive.Close()
			encoder.Close()
			return artifact, fmt.Errorf("%w: required snapshot member %s", ErrTemplateTransferIntegrity, name)
		}
		header := &tar.Header{
			Typeflag: tar.TypeReg,
			Name:     name,
			Mode:     0o644,
			Size:     info.Size(),
			ModTime:  time.Unix(0, 0).UTC(),
			Format:   tar.FormatUSTAR,
		}
		if err := archive.WriteHeader(header); err != nil {
			archive.Close()
			encoder.Close()
			return artifact, fmt.Errorf("%w: write archive header", ErrTemplateTransferUpstream)
		}
		input, openErr := os.Open(path)
		if openErr != nil {
			archive.Close()
			encoder.Close()
			return artifact, fmt.Errorf("%w: open snapshot member", ErrTemplateTransferUpstream)
		}
		_, copyErr := io.CopyN(archive, input, info.Size())
		closeErr := input.Close()
		if copyErr != nil || closeErr != nil {
			archive.Close()
			encoder.Close()
			return artifact, fmt.Errorf("%w: stream snapshot member", ErrTemplateTransferUpstream)
		}
	}
	if err := archive.Close(); err != nil {
		encoder.Close()
		return artifact, fmt.Errorf("%w: finalize tar", ErrTemplateTransferUpstream)
	}
	if err := encoder.Close(); err != nil {
		return artifact, fmt.Errorf("%w: finalize compression", ErrTemplateTransferUpstream)
	}
	if err := file.Sync(); err != nil {
		return artifact, fmt.Errorf("%w: sync archive", ErrTemplateTransferUpstream)
	}
	if err := file.Close(); err != nil {
		return artifact, fmt.Errorf("%w: close archive", ErrTemplateTransferUpstream)
	}
	info, err := os.Stat(destination)
	if err != nil || info.Size() <= 0 || info.Size() > maximumTemplateArtifact {
		return artifact, ErrTemplateTransferIntegrity
	}
	return templateArtifact{Checksum: "sha256:" + hex.EncodeToString(hash.Sum(nil)), SizeBytes: info.Size()}, nil
}

func verifyTemplateFile(path string, expected templateArtifact) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != expected.SizeBytes {
		return ErrTemplateTransferIntegrity
	}
	file, err := os.Open(path)
	if err != nil {
		return ErrTemplateTransferIntegrity
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return ErrTemplateTransferIntegrity
	}
	actual := "sha256:" + hex.EncodeToString(hash.Sum(nil))
	if !sameOpaqueValue(actual, expected.Checksum) {
		return ErrTemplateTransferIntegrity
	}
	return nil
}

func (mgr *Manager) validateTemplateGrant(grant scopedTemplateGrant, method string, expected templateArtifact) (validatedTemplateGrant, error) {
	if grant.Method != method || grant.URL == "" {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, grant.ExpiresAt)
	now := time.Now()
	if err != nil || !expiresAt.After(now) || expiresAt.Sub(now) > maximumTemplateGrantTTL {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	candidate, err := url.Parse(grant.URL)
	if err != nil || candidate.Host == "" || candidate.User != nil || candidate.Fragment != "" {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	configured, err := url.Parse(mgr.cfg.TemplateObjectOrigin)
	if err != nil || configured.Host == "" || candidate.Scheme != configured.Scheme || !strings.EqualFold(candidate.Host, configured.Host) {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	if candidate.Scheme != "https" && !(mgr.cfg.TemplateObjectAllowHTTP && !mgr.cfg.NehemiahMode) {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	if candidate.Query().Get("X-Amz-Signature") == "" {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	headers := make(map[string]string, len(grant.Headers))
	for name, value := range grant.Headers {
		lower := strings.ToLower(name)
		if lower == "" || http.CanonicalHeaderKey(lower) == "" || strings.ContainsAny(value, "\r\n\x00") {
			return validatedTemplateGrant{}, ErrTemplateTransferInvalid
		}
		if _, duplicate := headers[lower]; duplicate {
			return validatedTemplateGrant{}, ErrTemplateTransferInvalid
		}
		headers[lower] = value
	}
	if method == http.MethodGet {
		if len(headers) != 0 {
			return validatedTemplateGrant{}, ErrTemplateTransferInvalid
		}
	} else if len(headers) != 3 || headers["content-length"] != strconv.FormatInt(expected.SizeBytes, 10) || headers["if-none-match"] != "*" || headers["x-amz-server-side-encryption"] != "AES256" {
		return validatedTemplateGrant{}, ErrTemplateTransferInvalid
	}
	return validatedTemplateGrant{URL: candidate, Headers: headers, ExpiresAt: expiresAt}, nil
}

func pinnedTemplateClient(ctx context.Context, target *url.URL) (*http.Client, error) {
	port := target.Port()
	if port == "" {
		if target.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	var addresses []net.IP
	if literal := net.ParseIP(target.Hostname()); literal != nil {
		addresses = []net.IP{literal}
	} else {
		resolved, err := net.DefaultResolver.LookupIP(ctx, "ip", target.Hostname())
		if err != nil || len(resolved) == 0 {
			return nil, ErrTemplateTransferUpstream
		}
		addresses = resolved
	}
	sort.Slice(addresses, func(i, j int) bool { return bytesCompare(addresses[i], addresses[j]) < 0 })
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:              nil,
		DisableCompression: true,
		ForceAttemptHTTP2:  true,
		TLSClientConfig:    &tls.Config{MinVersion: tls.VersionTLS12, ServerName: target.Hostname()},
	}
	transport.DialContext = func(dialContext context.Context, network, address string) (net.Conn, error) {
		host, requestedPort, err := net.SplitHostPort(address)
		if err != nil || !strings.EqualFold(host, target.Hostname()) || requestedPort != port {
			return nil, ErrTemplateTransferInvalid
		}
		var last error
		for _, address := range addresses {
			connection, dialErr := dialer.DialContext(dialContext, network, net.JoinHostPort(address.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			last = dialErr
		}
		return nil, last
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("template transfer redirects are disabled")
		},
	}, nil
}

func bytesCompare(left, right net.IP) int {
	return strings.Compare(string(left.To16()), string(right.To16()))
}

func putTemplateArtifact(path string, expected templateArtifact, grant validatedTemplateGrant) error {
	file, err := os.Open(path)
	if err != nil {
		return ErrTemplateTransferIntegrity
	}
	defer file.Close()
	ctx, cancel := context.WithDeadline(context.Background(), grant.ExpiresAt)
	defer cancel()
	client, err := pinnedTemplateClient(ctx, grant.URL)
	if err != nil {
		return ErrTemplateTransferUpstream
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, grant.URL.String(), file)
	if err != nil {
		return ErrTemplateTransferInvalid
	}
	request.ContentLength = expected.SizeBytes
	for name, value := range grant.Headers {
		if name != "content-length" {
			request.Header.Set(name, value)
		}
	}
	response, err := client.Do(request)
	if err != nil {
		return ErrTemplateTransferUpstream
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumTransferErrorBody+1))
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusNoContent {
		return ErrTemplateTransferUpstream
	}
	return nil
}

func downloadTemplateArtifact(destination string, expected templateArtifact, grant validatedTemplateGrant) error {
	ctx, cancel := context.WithDeadline(context.Background(), grant.ExpiresAt)
	defer cancel()
	client, err := pinnedTemplateClient(ctx, grant.URL)
	if err != nil {
		return ErrTemplateTransferUpstream
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, grant.URL.String(), nil)
	if err != nil {
		return ErrTemplateTransferInvalid
	}
	response, err := client.Do(request)
	if err != nil {
		return ErrTemplateTransferUpstream
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength != expected.SizeBytes || response.Header.Get("Content-Encoding") != "" {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumTransferErrorBody+1))
		return ErrTemplateTransferUpstream
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return ErrTemplateTransferUpstream
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(response.Body, expected.SizeBytes+1))
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || written != expected.SizeBytes || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != expected.Checksum {
		_ = os.Remove(destination)
		return ErrTemplateTransferIntegrity
	}
	return nil
}

func extractTemplateArchive(cfg Config, archivePath, destination, architecture string) (templateMeta, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return templateMeta{}, ErrTemplateTransferIntegrity
	}
	defer file.Close()
	rootfsLimit := int64(cfg.OverlayQuotaMB) * 1024 * 1024
	if rootfsLimit <= 0 {
		rootfsLimit = 64 * 1024 * 1024 * 1024
	}
	memoryLimit := int64(cfg.MaxMemoryMBPerMachine+64) * 1024 * 1024
	if memoryLimit <= 64*1024*1024 {
		memoryLimit = 64 * 1024 * 1024 * 1024
	}
	limits := map[string]int64{
		templateSnapshotFilename: maximumTemplateSnapshot,
		templateMemoryFilename:   memoryLimit,
		templateRootfsFilename:   rootfsLimit,
		templateMetadataFilename: maximumTemplateMetadata,
	}
	maxMemory := uint64(maximumTemplateSnapshot + memoryLimit + rootfsLimit + maximumTemplateMetadata + 64*1024*1024)
	decoder, err := zstd.NewReader(file, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(maxMemory))
	if err != nil {
		return templateMeta{}, ErrTemplateTransferIntegrity
	}
	defer decoder.Close()
	reader := tar.NewReader(decoder)
	seen := make(map[string]bool, len(limits))
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil || header == nil || header.Typeflag != tar.TypeReg || header.Linkname != "" || seen[header.Name] {
			return templateMeta{}, ErrTemplateTransferIntegrity
		}
		limit, allowed := limits[header.Name]
		if !allowed || header.Size <= 0 || header.Size > limit || filepath.Base(header.Name) != header.Name {
			return templateMeta{}, ErrTemplateTransferIntegrity
		}
		output, openErr := os.OpenFile(filepath.Join(destination, header.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if openErr != nil {
			return templateMeta{}, ErrTemplateTransferIntegrity
		}
		written, copyErr := io.CopyN(output, reader, header.Size)
		syncErr := output.Sync()
		closeErr := output.Close()
		if copyErr != nil || syncErr != nil || closeErr != nil || written != header.Size {
			return templateMeta{}, ErrTemplateTransferIntegrity
		}
		seen[header.Name] = true
	}
	if len(seen) != len(limits) {
		return templateMeta{}, ErrTemplateTransferIntegrity
	}
	metadata, err := os.ReadFile(filepath.Join(destination, templateMetadataFilename))
	if err != nil || int64(len(metadata)) > maximumTemplateMetadata {
		return templateMeta{}, ErrTemplateTransferIntegrity
	}
	var meta templateMeta
	if json.Unmarshal(metadata, &meta) != nil || meta.Architecture != architecture || meta.Architecture != nehemiahArchitecture(runtime.GOARCH) || meta.MemSizeMB <= 0 || meta.MemSizeMB > cfg.MaxMemoryMBPerMachine || meta.VCPUs <= 0 || meta.VCPUs > cfg.MaxVCPUsPerMachine || meta.DiskMB <= 0 || int64(meta.DiskMB)*1024*1024 > rootfsLimit || meta.SourceTemplate == "" || len(meta.SourceTemplate) > 64 || strings.ContainsAny(meta.SourceTemplate, "/\\\x00\r\n") || meta.ArtifactSHA256 != "" || meta.ArtifactBytes != 0 {
		return templateMeta{}, ErrTemplateTransferIntegrity
	}
	if meta.InitPath != "" && (!strings.HasPrefix(meta.InitPath, "/") || len(meta.InitPath) > 256 || strings.ContainsAny(meta.InitPath, "\x00\r\n")) {
		return templateMeta{}, ErrTemplateTransferIntegrity
	}
	for name, declaredMaximum := range map[string]int64{
		templateMemoryFilename: int64(meta.MemSizeMB+64) * 1024 * 1024,
		templateRootfsFilename: int64(meta.DiskMB) * 1024 * 1024,
	} {
		info, statErr := os.Stat(filepath.Join(destination, name))
		if statErr != nil || info.Size() > declaredMaximum {
			return templateMeta{}, ErrTemplateTransferIntegrity
		}
	}
	return meta, nil
}

func installedTemplateArtifact(cfg Config, name string) (templateArtifact, bool, error) {
	directory := filepath.Join(cfg.TemplatesDir, name)
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return templateArtifact{}, false, nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return templateArtifact{}, true, ErrTemplateTransferConflict
	}
	metadata, err := os.ReadFile(filepath.Join(directory, templateMetadataFilename))
	if err != nil || int64(len(metadata)) > maximumTemplateMetadata {
		return templateArtifact{}, true, ErrTemplateTransferConflict
	}
	var meta templateMeta
	if json.Unmarshal(metadata, &meta) != nil {
		return templateArtifact{}, true, ErrTemplateTransferConflict
	}
	artifact := templateArtifact{Checksum: meta.ArtifactSHA256, SizeBytes: meta.ArtifactBytes}
	if !validTemplateArtifact(artifact) {
		return templateArtifact{}, true, ErrTemplateTransferConflict
	}
	return artifact, true, nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
