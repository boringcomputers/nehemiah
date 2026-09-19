package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const (
	testAccessClientID     = "a1b2c3d4e5f6.access"
	testAccessClientSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func TestHostTunnelLabelMatchesControlPlane(t *testing.T) {
	cases := map[string]string{
		"10.64.0.7":                "10-64-0-7",
		"::ffff:10.64.0.7":         "10-64-0-7",
		"fd00:6e65:6865::7":        "fd00-6e65-6865-0000-0000-0000-0000-0007",
		"FD00:6E65:6865:0:0:0:0:7": "fd00-6e65-6865-0000-0000-0000-0000-0007",
		"::1":                      "0000-0000-0000-0000-0000-0000-0000-0001",
	}
	for input, want := range cases {
		if got := hostTunnelLabel(netip.MustParseAddr(input)); got != want {
			t.Fatalf("hostTunnelLabel(%s) = %s, want %s", input, got, want)
		}
	}
}

func TestHostTargetThroughCloudflareTunnel(t *testing.T) {
	cfg := testConfig(t, "https://api.example.test", "10.64.0.7", 8080)
	cfg.HostTransport = hostTransportCloudflareTunnel
	cfg.HostTunnelDomain = "hosts.example.test"
	cfg.HostAccessClientID = testAccessClientID
	cfg.HostAccessClientSecret = testAccessClientSecret
	g := mustGateway(t, cfg)

	target, expected, err := g.hostTarget("10.64.0.7")
	if err != nil {
		t.Fatal(err)
	}
	if target.String() != "https://10-64-0-7.hosts.example.test" {
		t.Fatalf("unexpected target %s", target)
	}
	if expected != "10-64-0-7.hosts.example.test:443" {
		t.Fatalf("unexpected dial address %s", expected)
	}
	// The overlay allowlist still governs which identities may be routed.
	if _, _, err := g.hostTarget("10.65.0.7"); err == nil {
		t.Fatal("address outside the overlay allowlist must be rejected")
	}
	if _, _, err := g.hostTarget("10-64-0-7.hosts.example.test"); err == nil {
		t.Fatal("hostnames are never accepted as host addresses")
	}
	transport := g.hostTransport(expected, &byteLimiter{bytesPerSecond: 1 << 20}, context.Background(), "tty")
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.MinVersion < 0x0303 {
		t.Fatal("tunnel transport must negotiate TLS 1.2 or newer")
	}
}

func TestHostTargetOverlayIsUnchanged(t *testing.T) {
	g := mustGateway(t, testConfig(t, "https://api.example.test", "10.64.0.7", 8080))
	target, expected, err := g.hostTarget("10.64.0.7")
	if err != nil {
		t.Fatal(err)
	}
	if target.String() != "http://10.64.0.7:8080" || expected != "10.64.0.7:8080" {
		t.Fatalf("unexpected overlay target %s / %s", target, expected)
	}
	if g.hostTransport(expected, &byteLimiter{bytesPerSecond: 1 << 20}, context.Background(), "tty").TLSClientConfig != nil {
		t.Fatal("overlay transport must stay plain HTTP")
	}
}

func TestHostTransportConfigValidation(t *testing.T) {
	base := testConfig(t, "https://api.example.test", "10.64.0.7", 8080)

	tunnel := base
	tunnel.HostTransport = hostTransportCloudflareTunnel
	if err := tunnel.Validate(); err == nil || !strings.Contains(err.Error(), "NEHEMIAH_GATEWAY_HOST_TUNNEL_DOMAIN") {
		t.Fatalf("tunnel transport without a domain must fail, got %v", err)
	}
	tunnel.HostTunnelDomain = "hosts.example.test"
	if err := tunnel.Validate(); err == nil || !strings.Contains(err.Error(), "NEHEMIAH_GATEWAY_HOST_ACCESS_CLIENT") {
		t.Fatalf("tunnel transport without Access credentials must fail, got %v", err)
	}
	tunnel.HostAccessClientID = testAccessClientID
	tunnel.HostAccessClientSecret = "with whitespace"
	if err := tunnel.Validate(); err == nil {
		t.Fatal("malformed Access credentials must fail")
	}
	tunnel.HostAccessClientSecret = testAccessClientSecret
	if err := tunnel.Validate(); err != nil {
		t.Fatalf("complete tunnel transport must validate: %v", err)
	}

	overlay := base
	overlay.HostTunnelDomain = "hosts.example.test"
	if err := overlay.Validate(); err == nil || !strings.Contains(err.Error(), "NEHEMIAH_GATEWAY_HOST_TRANSPORT") {
		t.Fatalf("tunnel settings on the overlay transport must fail, got %v", err)
	}

	unknown := base
	unknown.HostTransport = "vpn"
	if err := unknown.Validate(); err == nil {
		t.Fatal("unknown transports must fail")
	}

	half := base
	half.ControlPlaneAccessClientID = testAccessClientID
	if err := half.Validate(); err == nil || !strings.Contains(err.Error(), "NEHEMIAH_GATEWAY_CONTROL_PLANE_ACCESS_CLIENT") {
		t.Fatalf("a lone control-plane Access client id must fail, got %v", err)
	}
	half.ControlPlaneAccessClientSecret = testAccessClientSecret
	if err := half.Validate(); err != nil {
		t.Fatalf("paired control-plane Access credentials must validate: %v", err)
	}
}

func TestControlPlaneRequestsCarryAccessServiceToken(t *testing.T) {
	seen := make(chan http.Header, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	cfg := testConfig(t, server.URL, "10.64.0.7", 8080)
	cfg.ControlPlaneAccessClientID = testAccessClientID
	cfg.ControlPlaneAccessClientSecret = testAccessClientSecret
	g := mustGateway(t, cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = g.resolver.Resolve(ctx, routeLookup{PublicMachineID: "m_missing", ExpiresAt: time.Now().Add(time.Minute)})

	select {
	case header := <-seen:
		if header.Get(accessClientIDHeader) != testAccessClientID || header.Get(accessClientSecretHeader) != testAccessClientSecret {
			t.Fatalf("control-plane request lacks the Access service token: %v", header)
		}
		if header.Get("Authorization") != "Bearer "+testGatewayToken {
			t.Fatal("gateway bearer credential must still be sent")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("control plane was not called")
	}
}

func TestControlPlaneRequestsWithoutAccessTokenAreUnchanged(t *testing.T) {
	seen := make(chan http.Header, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	g := mustGateway(t, testConfig(t, server.URL, "10.64.0.7", 8080))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = g.resolver.Resolve(ctx, routeLookup{PublicMachineID: "m_missing", ExpiresAt: time.Now().Add(time.Minute)})

	select {
	case header := <-seen:
		if header.Get(accessClientIDHeader) != "" || header.Get(accessClientSecretHeader) != "" {
			t.Fatal("no Access headers may be sent when none are configured")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("control plane was not called")
	}
}
