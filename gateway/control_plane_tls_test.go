package main

import (
	"crypto/x509"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionControlPlaneRequiresHTTPS(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:8081", "127.0.0.1", 8080)
	cfg.Production = true
	cfg.PreviewBaseDomain = "preview.example-untrusted.net"
	cfg.TrustedSiteDomain = "example.com"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "must use HTTPS") {
		t.Fatalf("Validate() error = %v, want production HTTPS rejection", err)
	}
}

func TestControlPlaneTransportUsesExplicitTrustRoot(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, "ok")
	}))
	defer server.Close()

	certificate, err := x509.ParseCertificate(server.Certificate().Raw)
	if err != nil {
		t.Fatal(err)
	}
	caPath := filepath.Join(t.TempDir(), "control-plane-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw}), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig(t, server.URL, "127.0.0.1", 8080)
	cfg.ControlPlaneCAFile = caPath
	transport, err := newControlPlaneTransport(cfg)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: transport}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("trusted request failed: %v", err)
	}
	_ = response.Body.Close()

	untrusted, err := newControlPlaneTransport(testConfig(t, server.URL, "127.0.0.1", 8080))
	if err != nil {
		t.Fatal(err)
	}
	if response, err := (&http.Client{Transport: untrusted}).Get(server.URL); err == nil {
		_ = response.Body.Close()
		t.Fatal("untrusted control-plane certificate was accepted")
	}

	wrongName := cfg
	wrongName.ControlPlaneServerName = "wrong.invalid"
	wrongTransport, err := newControlPlaneTransport(wrongName)
	if err != nil {
		t.Fatal(err)
	}
	if response, err := (&http.Client{Transport: wrongTransport}).Get(server.URL); err == nil {
		_ = response.Body.Close()
		t.Fatal("certificate with the wrong server name was accepted")
	}
}
