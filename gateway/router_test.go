package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestControlPlaneResolverMapsGlobalStreamQuotaAndReleasesExactLease(t *testing.T) {
	t.Parallel()
	var releaseSeen atomic.Bool
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if r.Header.Get("X-Nehemiah-Stream-ID") != "11111111-1111-4111-8111-111111111111" ||
				r.Header.Get("X-Nehemiah-Stream-Instance-ID") != "gateway-test" ||
				r.Header.Get("X-Nehemiah-Stream-Bandwidth-Bytes-Per-Second") != "1024" {
				http.Error(w, "missing stream identity", http.StatusBadRequest)
				return
			}
			http.Error(w, "quota", http.StatusTooManyRequests)
		case http.MethodDelete:
			if r.URL.Path != "/internal/v1/routing/streams/11111111-1111-4111-8111-111111111111" ||
				r.Header.Get("X-Nehemiah-Stream-Instance-ID") != "gateway-test" {
				http.Error(w, "wrong release", http.StatusBadRequest)
				return
			}
			releaseSeen.Store(true)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	}))
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 8080)
	resolver, err := newControlPlaneResolver(cfg, http.DefaultTransport)
	if err != nil {
		t.Fatal(err)
	}
	_, err = resolver.Resolve(context.Background(), routeLookup{
		PublicMachineID: testPublicID,
		Capability:      "files",
		CapabilityID:    "jti-test-123",
		Capabilities:    []string{"files"},
		Organization:    "org-test-123",
		Project:         "project-test-123",
		LeaseID:         "lease-test-123",
		ExpiresAt:       time.Now().Add(time.Minute),
		StreamID:        "11111111-1111-4111-8111-111111111111",
		StreamInstance:  "gateway-test",
		StreamBandwidth: 1024,
	})
	if !errors.Is(err, errStreamLimit) {
		t.Fatalf("Resolve error = %v, want errStreamLimit", err)
	}
	if err := resolver.Release(
		context.Background(),
		"11111111-1111-4111-8111-111111111111",
		"gateway-test",
	); err != nil {
		t.Fatal(err)
	}
	if !releaseSeen.Load() {
		t.Fatal("exact durable stream lease was not released")
	}
}

const (
	testGatewaySecret = "test-gateway-secret-with-enough-entropy"
	testGatewayToken  = "test-control-plane-gateway-token"
	testHostToken     = "test-private-host-token-at-least-32-bytes"
	testPublicID      = "m_public-machine-123"
	testLocalID       = "host-local-456"
)

func TestNormalRESTProxiesOnlyToControlPlane(t *testing.T) {
	t.Parallel()
	seen := make(chan *http.Request, 1)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(r.Context())
		clone.Body = io.NopCloser(bytes.NewReader(mustReadAll(t, r.Body)))
		seen <- clone
		w.Header().Set("Connection", "X-Response-Hop")
		w.Header().Set("X-Response-Hop", "must-not-leak")
		w.Header().Set("X-Control-Plane", "yes")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"proxied":true}`))
	}))
	defer controlPlane.Close()

	g := mustGateway(t, testConfig(t, controlPlane.URL, "127.0.0.1", 1))
	server := httptest.NewServer(g)
	defer server.Close()

	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/machines?project_id=p_1", strings.NewReader(`{"template":"shell"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer customer-api-key")
	request.Header.Set("Connection", "X-Request-Hop")
	request.Header.Set("X-Request-Hop", "must-not-leak")
	request.Header.Set("X-Forwarded-For", "169.254.169.254")
	request.Header.Set("CF-Connecting-IP", "198.51.100.201")
	request.Header.Set(clientAddressHeader, "198.51.100.200")
	request.Header.Set(clientTimestampHeader, "1")
	request.Header.Set(clientSignatureHeader, strings.Repeat("0", 64))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.StatusCode, mustReadAll(t, response.Body))
	}
	if response.Header.Get("X-Control-Plane") != "yes" || response.Header.Get("X-Response-Hop") != "" {
		t.Fatalf("unexpected response headers: %#v", response.Header)
	}
	upstream := <-seen
	if upstream.URL.Path != "/v1/machines" || upstream.URL.Query().Get("project_id") != "p_1" {
		t.Fatalf("upstream target = %s", upstream.URL.String())
	}
	if upstream.Header.Get("Authorization") != "Bearer customer-api-key" {
		t.Fatalf("customer authorization was not preserved")
	}
	if upstream.Header.Get("X-Request-Hop") != "" || upstream.Header.Get("X-Forwarded-For") != "" || upstream.Header.Get("CF-Connecting-IP") != "" {
		t.Fatalf("untrusted forwarding/hop headers leaked: %#v", upstream.Header)
	}
	forwardedAddress := upstream.Header.Get(clientAddressHeader)
	forwardedTimestamp := upstream.Header.Get(clientTimestampHeader)
	forwardedSignature := upstream.Header.Get(clientSignatureHeader)
	if forwardedAddress != "127.0.0.1" || forwardedTimestamp == "" || forwardedSignature == strings.Repeat("0", 64) {
		t.Fatalf("gateway client identity headers = address %q timestamp %q signature %q", forwardedAddress, forwardedTimestamp, forwardedSignature)
	}
	if !hmac.Equal(
		[]byte(forwardedSignature),
		[]byte(clientAddressSignature(testGatewayToken, forwardedAddress, forwardedTimestamp)),
	) {
		t.Fatal("gateway client identity signature is invalid")
	}
	if got := string(mustReadAll(t, upstream.Body)); got != `{"template":"shell"}` {
		t.Fatalf("body = %q", got)
	}
}

func TestInternalControlPlaneRoutesAreNeverPubliclyProxied(t *testing.T) {
	t.Parallel()
	var upstreamRequests atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()

	g := mustGateway(t, testConfig(t, controlPlane.URL, "127.0.0.1", 1))
	server := httptest.NewServer(g)
	defer server.Close()

	for _, path := range []string{"/internal", "/internal/", "/internal/v1/hosts/register"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s status = %d, want %d", path, response.StatusCode, http.StatusNotFound)
		}
	}
	if upstreamRequests.Load() != 0 {
		t.Fatalf("internal requests forwarded upstream = %d", upstreamRequests.Load())
	}
}

func TestHealthRejectsIncompleteChunkedBodyWithoutDraining(t *testing.T) {
	t.Parallel()
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()

	g := mustGateway(t, testConfig(t, controlPlane.URL, "127.0.0.1", 1))
	server := httptest.NewServer(g)
	defer server.Close()

	address := strings.TrimPrefix(server.URL, "http://")
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		connection, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if err := connection.SetDeadline(time.Now().Add(time.Second)); err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		if _, err := io.WriteString(connection,
			method+" /healthz HTTP/1.1\r\nHost: "+address+"\r\nTransfer-Encoding: chunked\r\n\r\n5\r\na"); err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: method})
		if err != nil {
			_ = connection.Close()
			t.Fatalf("%s health response remained blocked on request-body drain: %v", method, err)
		}
		_ = response.Body.Close()
		_ = connection.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want %d", method, response.StatusCode, http.StatusBadRequest)
		}
		if !response.Close {
			t.Fatalf("%s health rejection did not require the connection to close", method)
		}
	}
}

func TestFileCapabilityResolvesAndRewritesPrivateMachine(t *testing.T) {
	t.Parallel()
	hostRequests := make(chan *http.Request, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(r.Context())
		clone.Body = io.NopCloser(bytes.NewReader(mustReadAll(t, r.Body)))
		hostRequests <- clone
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)

	var lookups atomic.Int32
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), &lookups)
	defer controlPlane.Close()
	g := mustGateway(t, testConfig(t, controlPlane.URL, hostName, hostPort))
	server := httptest.NewServer(g)
	defer server.Close()

	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"files"}, nil, time.Now()))
	request, err := http.NewRequest(http.MethodPost,
		server.URL+"/v1/machines/"+testPublicID+"/upload?path=%2Froot%2Ffile&upstream=http%3A%2F%2Fattacker.invalid",
		strings.NewReader("file bytes"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", "dashboard_session=secret")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Filename", "file.txt")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, mustReadAll(t, response.Body))
	}
	if lookups.Load() != 1 {
		t.Fatalf("route lookups = %d", lookups.Load())
	}
	upstream := <-hostRequests
	if upstream.URL.Path != "/v1/machines/"+testLocalID+"/upload" {
		t.Fatalf("host path = %q", upstream.URL.Path)
	}
	if strings.Contains(upstream.URL.String(), testPublicID) {
		t.Fatalf("public ID leaked into private route: %s", upstream.URL)
	}
	if upstream.URL.Query().Get("token") != "" || upstream.URL.Query().Get("upstream") != "" || upstream.URL.Query().Get("path") != "/root/file" {
		t.Fatalf("unsafe or missing query values: %s", upstream.URL.RawQuery)
	}
	if upstream.Header.Get("Authorization") != "Bearer "+testHostToken || upstream.Header.Get("Cookie") != "" {
		t.Fatalf("host credentials were not reconstructed safely: %#v", upstream.Header)
	}
	if upstream.Header.Get("X-Nehemiah-Lease-ID") != "lease-test-123" {
		t.Fatalf("lease header = %q", upstream.Header.Get("X-Nehemiah-Lease-ID"))
	}
	if got := string(mustReadAll(t, upstream.Body)); got != "file bytes" {
		t.Fatalf("body = %q", got)
	}
}

func TestPreviewRequiresPortCapabilityAndPreservesSubpath(t *testing.T) {
	t.Parallel()
	paths := make(chan string, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.String()
		w.Header().Set("Location", "/login?next=%2Fdashboard")
		w.Header().Set("Server", "private-nehemiahd")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), nil)
	defer controlPlane.Close()
	g := mustGateway(t, testConfig(t, controlPlane.URL, hostName, hostPort))
	server := httptest.NewServer(g)
	defer server.Close()

	port := 3000
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"preview"}, &port, time.Now()))
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exchange, err := http.NewRequest(http.MethodPost, server.URL+"/v1/capability/exchange", nil)
	if err != nil {
		t.Fatal(err)
	}
	exchange.Header.Set("Authorization", "Bearer "+token)
	exchanged, err := client.Do(exchange)
	if err != nil {
		t.Fatal(err)
	}
	defer exchanged.Body.Close()
	if exchanged.StatusCode != http.StatusNoContent {
		t.Fatalf("exchange status = %d, body = %s", exchanged.StatusCode, mustReadAll(t, exchanged.Body))
	}
	cookies := exchanged.Cookies()
	if len(cookies) != 1 || cookies[0].Name != previewCookieName(capabilityRoute{publicMachineID: testPublicID, previewPort: port}) || !cookies[0].HttpOnly {
		t.Fatalf("preview capability cookie = %#v", cookies)
	}
	previewRequest, err := http.NewRequest(http.MethodGet, server.URL+"/preview/"+testPublicID+"/3000/assets/app.js?v=7", nil)
	if err != nil {
		t.Fatal(err)
	}
	previewRequest.AddCookie(cookies[0])
	response, err := client.Do(previewRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if got := <-paths; got != "/v1/machines/"+testLocalID+"/web/3000/assets/app.js?v=7" {
		t.Fatalf("preview upstream path = %q", got)
	}
	wantLocation := "/preview/" + testPublicID + "/3000/login?next=%2Fdashboard"
	if response.Header.Get("Location") != wantLocation {
		t.Fatalf("location = %q, want %q", response.Header.Get("Location"), wantLocation)
	}
	if response.Header.Get("Server") != "" || response.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("unsafe preview response headers: %#v", response.Header)
	}
	// Browser subresources use only the scoped, HttpOnly exchange cookie;
	// the scoped, HttpOnly bootstrap cookie keeps them authorized.
	subresource, err := http.NewRequest(http.MethodGet, server.URL+"/preview/"+testPublicID+"/3000/styles.css?v=8", nil)
	if err != nil {
		t.Fatal(err)
	}
	subresource.AddCookie(cookies[0])
	second, err := client.Do(subresource)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Body.Close()
	if second.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("cookie-authenticated status = %d, body = %s", second.StatusCode, mustReadAll(t, second.Body))
	}
	if got := <-paths; got != "/v1/machines/"+testLocalID+"/web/3000/styles.css?v=8" {
		t.Fatalf("cookie-authenticated upstream path = %q", got)
	}
}

func TestWebSocketUpgradeTraversesGateway(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	paths := make(chan string, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testHostToken {
			http.Error(w, "bad host auth", http.StatusUnauthorized)
			return
		}
		paths <- r.URL.String()
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		kind, payload, err := connection.ReadMessage()
		if err == nil {
			_ = connection.WriteMessage(kind, payload)
		}
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), nil)
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, hostName, hostPort)
	cfg.StreamMaxDuration = 5 * time.Second
	g := mustGateway(t, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(withRequestTelemetry(logger, g))
	defer server.Close()

	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"tty"}, nil, time.Now()))
	websocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/machines/" + testPublicID + "/tty"
	websocketHeader := http.Header{}
	websocketHeader.Set("Sec-WebSocket-Protocol", capabilityWebSocketProtocolPrefix+token)
	connection, response, err := websocket.DefaultDialer.Dial(websocketURL, websocketHeader)
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial: %v (status %d, body %s)", err, response.StatusCode, mustReadAll(t, response.Body))
		}
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteMessage(websocket.BinaryMessage, []byte("hello tty")); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := connection.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.BinaryMessage || string(payload) != "hello tty" {
		t.Fatalf("echo = (%d, %q)", kind, payload)
	}
	if got := <-paths; got != "/v1/machines/"+testLocalID+"/tty" {
		t.Fatalf("websocket host path = %q", got)
	}
}

func routeControlPlane(t *testing.T, hostAddress, localID string, expiresAt time.Time, lookups *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/internal/v1/routing/streams/") {
			if r.Header.Get("Authorization") != "Bearer "+testGatewayToken ||
				r.Header.Get("X-Nehemiah-Stream-Instance-ID") == "" {
				http.Error(w, "bad stream release", http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/internal/v1/routing/machines/") {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+testGatewayToken {
			http.Error(w, "bad gateway credential", http.StatusUnauthorized)
			return
		}
		capability := r.Header.Get("X-Nehemiah-Capability")
		if capability == "" || r.Header.Get("X-Nehemiah-Capability-ID") != "jti-test-123" {
			http.Error(w, "missing capability binding", http.StatusBadRequest)
			return
		}
		capabilityExpiresAt := r.Header.Get("X-Nehemiah-Capability-Expires-At")
		if _, err := time.Parse(time.RFC3339Nano, capabilityExpiresAt); err != nil {
			http.Error(w, "bad capability expiry", http.StatusBadRequest)
			return
		}
		capabilities := r.Header.Get("X-Nehemiah-Capabilities")
		if capabilities == "" || !strings.Contains(","+capabilities+",", ","+capability+",") ||
			r.Header.Get("X-Nehemiah-Capability-Organization-ID") != "org-test-123" ||
			r.Header.Get("X-Nehemiah-Capability-Project-ID") != "project-test-123" ||
			r.Header.Get("X-Nehemiah-Capability-Lease-ID") != "lease-test-123" {
			http.Error(w, "bad complete capability binding", http.StatusBadRequest)
			return
		}
		portText := r.Header.Get("X-Nehemiah-Preview-Port")
		streamID := r.Header.Get("X-Nehemiah-Stream-ID")
		streamInstanceID := r.Header.Get("X-Nehemiah-Stream-Instance-ID")
		streamBandwidth, streamBandwidthErr := strconv.ParseInt(
			r.Header.Get("X-Nehemiah-Stream-Bandwidth-Bytes-Per-Second"), 10, 64,
		)
		hasStreamAdmission := streamID != "" || streamInstanceID != "" ||
			r.Header.Get("X-Nehemiah-Stream-Bandwidth-Bytes-Per-Second") != ""
		if hasStreamAdmission && (streamID == "" || streamInstanceID == "" || streamBandwidthErr != nil || streamBandwidth < 1) {
			http.Error(w, "bad stream admission", http.StatusBadRequest)
			return
		}
		if strings.Contains(","+capabilities+",", ",preview,") != (portText != "") {
			http.Error(w, "bad preview port binding", http.StatusBadRequest)
			return
		}
		var capabilityPort any
		if portText != "" {
			capabilityPort, _ = strconv.Atoi(portText)
		}
		if lookups != nil {
			lookups.Add(1)
		}
		body := map[string]any{
			"host_address":          hostAddress,
			"host_machine_id":       localID,
			"lease_id":              "lease-test-123",
			"organization_id":       "org-test-123",
			"project_id":            "project-test-123",
			"capability_id":         "jti-test-123",
			"capabilities":          strings.Split(capabilities, ","),
			"capability_port":       capabilityPort,
			"capability_expires_at": capabilityExpiresAt,
			"host_token":            testHostToken,
			"expires_at":            expiresAt.Format(time.RFC3339Nano),
		}
		if hasStreamAdmission {
			body["stream_id"] = streamID
			body["stream_bandwidth_bytes_per_second"] = streamBandwidth
			body["stream_expires_at"] = time.Now().Add(15 * time.Second).Format(time.RFC3339Nano)
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
}

func testConfig(t *testing.T, controlPlaneURL, hostAddress string, hostPort int) Config {
	t.Helper()
	prefix := netip.MustParsePrefix("127.0.0.0/8")
	if parsed, err := netip.ParseAddr(hostAddress); err == nil && !parsed.IsLoopback() {
		bits := 32
		if parsed.Is6() {
			bits = 128
		}
		prefix = netip.PrefixFrom(parsed, bits)
	}
	return Config{
		Addr:                           "127.0.0.1:8082",
		ControlPlaneURL:                controlPlaneURL,
		GatewayToken:                   testGatewayToken,
		CapabilitySecret:               testGatewaySecret,
		HostPort:                       hostPort,
		AllowedHostCIDRs:               []netip.Prefix{prefix},
		ControlPlaneTimeout:            2 * time.Second,
		CapabilityRevalidationInterval: 5 * time.Second,
		StreamMaxDuration:              10 * time.Second,
		ShutdownGrace:                  2 * time.Second,
		MaxRequestBytes:                1 << 20,
		SecurePreviewCookies:           true,
		MaxConnectionsPerTenant:        4,
		TenantBytesPerSecond:           64 << 20,
		RESTRequestsPerWindow:          600,
		RESTWindow:                     time.Minute,
		RESTLimiterSlots:               1_024,
		RESTMaxActive:                  32,
		RESTMaxActivePerSource:         4,
		RESTBodyTimeout:                15 * time.Second,
		RESTMaxDuration:                150 * time.Second,
		TrustedEdgeIPHeader:            "CF-Connecting-IP",
	}
}

func mustGateway(t *testing.T, cfg Config) *gateway {
	t.Helper()
	g, err := newGateway(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func testServerAddress(t *testing.T, rawURL string) (string, int) {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	return host, port
}

func tokenPayload(subject string, capabilities []string, port *int, now time.Time) map[string]any {
	payload := map[string]any{
		"iss":     capabilityIssuer,
		"aud":     capabilityAudience,
		"sub":     subject,
		"org":     "org-test-123",
		"project": "project-test-123",
		"lease":   "lease-test-123",
		"cap":     capabilities,
		"iat":     now.Unix(),
		"exp":     now.Add(5 * time.Minute).Unix(),
		"jti":     "jti-test-123",
	}
	if port != nil {
		payload["port"] = *port
	}
	return payload
}

func signCapability(t *testing.T, secret string, payload map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func mustReadAll(t *testing.T, reader io.Reader) []byte {
	t.Helper()
	bytes, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return bytes
}

func TestCapabilityTokenMatchesControlPlaneJOSEShape(t *testing.T) {
	t.Parallel()
	port := 8080
	now := time.Now().Truncate(time.Second)
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"tty", "preview"}, &port, now))
	claims, err := verifyCapabilityToken(token, testGatewaySecret, now)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != testPublicID || claims.Organization != "org-test-123" || claims.Project != "project-test-123" || claims.Port == nil || *claims.Port != port {
		t.Fatalf("claims = %#v", claims)
	}
	for _, capability := range []string{"preview", "tty"} {
		if _, ok := claims.Capabilities[capability]; !ok {
			t.Fatalf("missing capability %q", capability)
		}
	}
}

func Example_previewURL() {
	fmt.Println("/preview/m_public-machine-123/3000/index.html#token=<capability>")
	// Output: /preview/m_public-machine-123/3000/index.html#token=<capability>
}
