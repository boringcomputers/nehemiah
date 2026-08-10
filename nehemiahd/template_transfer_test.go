package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func templateTransferManager(t *testing.T, objectOrigin string) (*Manager, *Machine) {
	t.Helper()
	cfg := internalTestConfig(t)
	cfg.RunDir = filepath.Join(t.TempDir(), "run")
	cfg.TemplatesDir = filepath.Join(t.TempDir(), "templates")
	cfg.TemplateObjectOrigin = objectOrigin
	cfg.TemplateObjectAllowHTTP = true
	cfg.OverlayQuotaMB = 16
	cfg.MaxMemoryMBPerMachine = 1024
	mgr := NewManager(cfg)
	mgr.createSnapshot = func(_ *fcDriver, _ string) (string, error) {
		directory := t.TempDir()
		for name, data := range map[string][]byte{
			templateSnapshotFilename: []byte("firecracker snapshot state"),
			templateMemoryFilename:   bytes.Repeat([]byte("memory"), 64),
			templateRootfsFilename:   bytes.Repeat([]byte("rootfs"), 128),
		} {
			if err := os.WriteFile(filepath.Join(directory, name), data, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return directory, nil
	}
	machine := &Machine{
		ID:        "m-01020304",
		Status:    "running",
		Template:  "python",
		Ready:     true,
		CreatedAt: time.Now().Add(-time.Minute),
		ExpiresAt: time.Now().Add(time.Hour),
		VCPUs:     1,
		MemoryMB:  1,
		DiskMB:    1,
		LeaseID:   "lease-current",
		driver:    &fcDriver{cfg: cfg, id: "m-01020304", tpl: cfg.Template("python"), tap: "tap-test"},
	}
	mgr.mu.Lock()
	mgr.machines[machine.ID] = machine
	mgr.mu.Unlock()
	return mgr, machine
}

func TestManagedTemplateExportIsComputedBeforeBoundUpload(t *testing.T) {
	var mu sync.Mutex
	var uploaded []byte
	putCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut {
			t.Errorf("method = %s", request.Method)
			response.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if request.Header.Get("If-None-Match") != "*" || request.Header.Get("X-Amz-Server-Side-Encryption") != "AES256" {
			t.Errorf("upload headers = %v", request.Header)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read upload: %v", err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		putCalls++
		uploaded = append([]byte(nil), body...)
		mu.Unlock()
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	mgr, machine := templateTransferManager(t, server.URL)
	exportID := "te_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	exported, err := mgr.ExportManagedTemplate(machine.ID, machine.LeaseID, exportID)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if !validTemplateArtifact(exported.templateArtifact) || exported.ExportID != exportID {
		t.Fatalf("export = %+v", exported)
	}
	mu.Lock()
	if putCalls != 0 {
		t.Fatalf("upload occurred before grant: %d", putCalls)
	}
	mu.Unlock()
	grant := scopedTemplateGrant{
		Method: http.MethodPut,
		URL:    server.URL + "/exact-object?X-Amz-Signature=scoped",
		Headers: map[string]string{
			"content-length":               stringValue(exported.SizeBytes),
			"if-none-match":                "*",
			"x-amz-server-side-encryption": "AES256",
		},
		ExpiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
	}
	uploadResult, err := mgr.UploadManagedTemplateExport(
		machine.ID,
		machine.LeaseID,
		exportID,
		exported.templateArtifact,
		grant,
	)
	if err != nil || uploadResult != exported.templateArtifact {
		t.Fatalf("upload = %+v, %v", uploadResult, err)
	}
	mu.Lock()
	written := append([]byte(nil), uploaded...)
	if putCalls != 1 {
		t.Fatalf("put calls = %d", putCalls)
	}
	mu.Unlock()
	digest := sha256.Sum256(written)
	if "sha256:"+hex.EncodeToString(digest[:]) != exported.Checksum || int64(len(written)) != exported.SizeBytes {
		t.Fatalf("uploaded artifact did not match export: bytes=%d", len(written))
	}
	if _, err := mgr.UploadManagedTemplateExport(machine.ID, machine.LeaseID, exportID, exported.templateArtifact, grant); err != nil {
		t.Fatalf("upload replay: %v", err)
	}
	mu.Lock()
	if putCalls != 1 {
		t.Fatalf("replay repeated PUT: %d", putCalls)
	}
	mu.Unlock()
	if _, err := mgr.UploadManagedTemplateExport(machine.ID, "other-lease", exportID, exported.templateArtifact, grant); err == nil {
		t.Fatal("wrong lease uploaded an export")
	}
	if err := mgr.DiscardManagedTemplateExport(machine.ID, machine.LeaseID, exportID); err != nil {
		t.Fatalf("discard: %v", err)
	}
	if _, err := os.Stat(mgr.templateExportDir(exportID)); !os.IsNotExist(err) {
		t.Fatalf("export staging remains: %v", err)
	}
}

func TestManagedTemplateActivationVerifiesAndAtomicallyInstalls(t *testing.T) {
	var artifact []byte
	var getCalls int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPut:
			artifact, _ = io.ReadAll(request.Body)
			response.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			getCalls++
			response.Header().Set("Content-Length", stringValue(int64(len(artifact))))
			_, _ = response.Write(artifact)
		default:
			response.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	mgr, machine := templateTransferManager(t, server.URL)
	exported, err := mgr.ExportManagedTemplate(machine.ID, machine.LeaseID, "te_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	if err != nil {
		t.Fatal(err)
	}
	uploadGrant := scopedTemplateGrant{
		Method: http.MethodPut,
		URL:    server.URL + "/artifact?X-Amz-Signature=scoped",
		Headers: map[string]string{
			"content-length":               stringValue(exported.SizeBytes),
			"if-none-match":                "*",
			"x-amz-server-side-encryption": "AES256",
		},
		ExpiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
	}
	if _, err := mgr.UploadManagedTemplateExport(machine.ID, machine.LeaseID, exported.ExportID, exported.templateArtifact, uploadGrant); err != nil {
		t.Fatal(err)
	}
	downloadGrant := scopedTemplateGrant{
		Method:    http.MethodGet,
		URL:       server.URL + "/artifact?X-Amz-Signature=scoped",
		Headers:   map[string]string{},
		ExpiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
	}
	name := "t-ccccccccccccccccccccccccccccc"
	architecture := nehemiahArchitecture(runtime.GOARCH)
	activated, err := mgr.ActivateManagedTemplate(name, "firecracker-snapshot-v1", architecture, exported.templateArtifact, downloadGrant)
	if err != nil || activated != exported.templateArtifact {
		t.Fatalf("activate = %+v, %v", activated, err)
	}
	if getCalls != 1 {
		t.Fatalf("GET calls = %d", getCalls)
	}
	for _, member := range []string{templateSnapshotFilename, templateMemoryFilename, templateRootfsFilename, templateMetadataFilename} {
		info, statErr := os.Lstat(filepath.Join(mgr.cfg.TemplatesDir, name, member))
		if statErr != nil || !info.Mode().IsRegular() {
			t.Fatalf("installed member %s: %v", member, statErr)
		}
	}
	metaBytes, err := os.ReadFile(filepath.Join(mgr.cfg.TemplatesDir, name, templateMetadataFilename))
	if err != nil {
		t.Fatal(err)
	}
	var meta templateMeta
	if json.Unmarshal(metaBytes, &meta) != nil || meta.ArtifactSHA256 != exported.Checksum || meta.ArtifactBytes != exported.SizeBytes || meta.Architecture != architecture {
		t.Fatalf("installed metadata = %+v", meta)
	}
	if _, err := mgr.ActivateManagedTemplate(name, "firecracker-snapshot-v1", architecture, exported.templateArtifact, scopedTemplateGrant{}); err != nil {
		t.Fatalf("idempotent activation replay required another grant: %v", err)
	}
	if getCalls != 1 {
		t.Fatalf("activation replay downloaded again: %d", getCalls)
	}
	if template := mgr.cfg.Template(name); !template.Snapshot || template.MemSizeMB != 1 || !template.RestoreNet {
		t.Fatalf("activated template is not bootable: %+v", template)
	}
}

func TestManagedTemplateActivationRejectsUnsafeArchive(t *testing.T) {
	var encoded bytes.Buffer
	compressor, err := zstd.NewWriter(&encoded)
	if err != nil {
		t.Fatal(err)
	}
	archive := tar.NewWriter(compressor)
	payload := []byte("escape")
	if err := archive.WriteHeader(&tar.Header{Name: "../escape", Mode: 0o644, Size: int64(len(payload)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = archive.Write(payload)
	_ = archive.Close()
	_ = compressor.Close()
	digest := sha256.Sum256(encoded.Bytes())
	expected := templateArtifact{Checksum: "sha256:" + hex.EncodeToString(digest[:]), SizeBytes: int64(encoded.Len())}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Length", stringValue(expected.SizeBytes))
		_, _ = response.Write(encoded.Bytes())
	}))
	defer server.Close()
	mgr, _ := templateTransferManager(t, server.URL)
	name := "t-ddddddddddddddddddddddddddddd"
	_, err = mgr.ActivateManagedTemplate(
		name,
		"firecracker-snapshot-v1",
		nehemiahArchitecture(runtime.GOARCH),
		expected,
		scopedTemplateGrant{
			Method:    http.MethodGet,
			URL:       server.URL + "/artifact?X-Amz-Signature=scoped",
			Headers:   map[string]string{},
			ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
		},
	)
	if err == nil {
		t.Fatal("unsafe archive activated")
	}
	if _, statErr := os.Stat(filepath.Join(mgr.cfg.TemplatesDir, name)); !os.IsNotExist(statErr) {
		t.Fatalf("unsafe target exists: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(mgr.cfg.TemplatesDir, "escape")); !os.IsNotExist(statErr) {
		t.Fatalf("archive escaped staging: %v", statErr)
	}
}

func TestInternalTemplateTransferRoutesRequireHostCredentialAndCurrentLease(t *testing.T) {
	cfg := internalTestConfig(t)
	mgr := NewManager(cfg)
	machine := &Machine{
		ID: "m-01020304", Status: "running", Ready: true, LeaseID: "lease-current",
		ExpiresAt: time.Now().Add(time.Minute), driver: &fcDriver{cfg: cfg},
	}
	mgr.mu.Lock()
	mgr.machines[machine.ID] = machine
	mgr.mu.Unlock()
	server := NewServer(cfg, mgr)
	body := bytes.NewBufferString(`{"export_id":"te_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`)
	request := internalRequest(http.MethodPost, "/internal/v1/machines/m-01020304/template-exports", "", body)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing host credential status = %d", response.Code)
	}
	request = internalRequest(http.MethodPost, "/internal/v1/machines/m-01020304/template-exports", cfg.InternalToken, bytes.NewBufferString(`{"export_id":"te_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`))
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing lease status = %d", response.Code)
	}
	request = internalRequest(http.MethodPost, "/internal/v1/machines/m-01020304/template-exports", cfg.InternalToken, bytes.NewBufferString(`{"export_id":"te_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`))
	request.Header.Set("X-Nehemiah-Lease-ID", machine.LeaseID)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled transfer status = %d: %s", response.Code, response.Body.String())
	}
}

func stringValue(value int64) string {
	return fmt.Sprintf("%d", value)
}
