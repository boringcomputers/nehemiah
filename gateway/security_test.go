package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type staticResolver struct {
	route   machineRoute
	err     error
	calls   atomic.Int32
	mu      sync.Mutex
	lookups []routeLookup
}

func (r *staticResolver) Resolve(_ context.Context, lookup routeLookup) (machineRoute, error) {
	r.calls.Add(1)
	r.mu.Lock()
	r.lookups = append(r.lookups, lookup)
	resolved := r.route
	if resolved.CapabilityID == "" {
		resolved.CapabilityID = lookup.CapabilityID
	}
	if resolved.Capabilities == nil {
		resolved.Capabilities = append([]string(nil), lookup.Capabilities...)
	}
	if resolved.CapabilityPort == nil && lookup.PreviewPort != nil {
		port := *lookup.PreviewPort
		resolved.CapabilityPort = &port
	}
	if resolved.CapabilityExpiresAt.IsZero() {
		resolved.CapabilityExpiresAt = lookup.ExpiresAt
	}
	if resolved.StreamID == "" {
		resolved.StreamID = lookup.StreamID
	}
	if resolved.StreamBandwidth == 0 {
		resolved.StreamBandwidth = lookup.StreamBandwidth
	}
	if resolved.StreamExpiresAt.IsZero() {
		resolved.StreamExpiresAt = time.Now().Add(15 * time.Second)
	}
	err := r.err
	r.mu.Unlock()
	return resolved, err
}

func (r *staticResolver) setError(err error) {
	r.mu.Lock()
	r.err = err
	r.mu.Unlock()
}

func (r *staticResolver) lastLookup() routeLookup {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lookups[len(r.lookups)-1]
}

func TestCapabilityAuthenticationFailsClosedBeforeLookup(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	base := tokenPayload(testPublicID, []string{"files"}, nil, now)

	tests := []struct {
		name       string
		payload    map[string]any
		secret     string
		path       string
		wantStatus int
	}{
		{name: "invalid signature", payload: clonePayload(base), secret: "wrong-secret", path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "expired", payload: withClaims(base, "iat", now.Add(-10*time.Minute).Unix(), "exp", now.Add(-time.Second).Unix()), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "overlong lifetime", payload: withClaims(base, "exp", now.Add(901*time.Second).Unix()), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "future issue", payload: withClaims(base, "iat", now.Add(time.Minute).Unix(), "exp", now.Add(2*time.Minute).Unix()), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "wrong issuer", payload: withClaims(base, "iss", "attacker"), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "wrong audience", payload: withClaims(base, "aud", "somewhere-else"), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "missing organization", payload: withClaims(base, "org", ""), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "missing project", payload: withClaims(base, "project", ""), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "missing capability identity", payload: withClaims(base, "jti", ""), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "other tenant machine", payload: withClaims(base, "sub", "m_other-tenant-999"), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "wrong capability", payload: withClaims(base, "cap", []string{"tty"}), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusForbidden},
		{name: "unknown capability", payload: withClaims(base, "cap", []string{"admin"}), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "duplicate capability", payload: withClaims(base, "cap", []string{"files", "files"}), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "noncanonical capability order", payload: withClaims(base, "cap", []string{"files", "tty"}), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "port without preview", payload: withClaims(base, "port", 3000), secret: testGatewaySecret, path: "/v1/machines/" + testPublicID + "/download", wantStatus: http.StatusUnauthorized},
		{name: "preview without port", payload: withClaims(base, "cap", []string{"preview"}), secret: testGatewaySecret, path: "/preview/" + testPublicID + "/3000/", wantStatus: http.StatusUnauthorized},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			resolver := &staticResolver{route: safeStaticRoute(now)}
			g := gatewayForStaticResolver(t, resolver)
			token := signCapability(t, test.secret, test.payload)
			request := httptest.NewRequest(http.MethodGet, test.path+"?path=x", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			g.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, test.wantStatus, response.Body.String())
			}
			if resolver.calls.Load() != 0 {
				t.Fatalf("unauthorized request performed %d route lookups", resolver.calls.Load())
			}
		})
	}
}

func TestStreamIDFailureIsRetryableWithoutRouteLookup(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	previewPort := 3000
	for _, test := range []struct {
		name         string
		method       string
		path         string
		capabilities []string
		port         *int
	}{
		{
			name:         "machine capability",
			method:       http.MethodGet,
			path:         "/v1/machines/" + testPublicID + "/download?path=/root/result.txt",
			capabilities: []string{"files"},
		},
		{
			name:         "preview exchange",
			method:       http.MethodPost,
			path:         "/v1/capability/exchange",
			capabilities: []string{"preview"},
			port:         &previewPort,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			resolver := &staticResolver{route: safeStaticRoute(now)}
			g := gatewayForStaticResolver(t, resolver)
			g.streamIDGenerator = func() (string, error) {
				return "", errors.New("entropy unavailable")
			}
			token := signCapability(
				t,
				testGatewaySecret,
				tokenPayload(testPublicID, test.capabilities, test.port, now),
			)
			request := httptest.NewRequest(test.method, test.path, nil)
			request.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()

			g.ServeHTTP(response, request)

			if response.Code != http.StatusServiceUnavailable ||
				response.Header().Get("Retry-After") != "1" {
				t.Fatalf(
					"status = %d, Retry-After = %q, body = %s",
					response.Code,
					response.Header().Get("Retry-After"),
					response.Body.String(),
				)
			}
			var body problemBody
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Title != "stream_admission_unavailable" || body.Status != http.StatusServiceUnavailable {
				t.Fatalf("problem = %#v", body)
			}
			if resolver.calls.Load() != 0 {
				t.Fatalf("entropy failure performed %d route lookups", resolver.calls.Load())
			}
		})
	}
}

func TestPreviewPortIsCryptographicallyBound(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	grantedPort := 3000
	resolver := &staticResolver{route: safeStaticRoute(now)}
	g := gatewayForStaticResolver(t, resolver)
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"preview"}, &grantedPort, now))
	request := httptest.NewRequest(http.MethodGet, "/preview/"+testPublicID+"/3001/", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	g.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if resolver.calls.Load() != 0 {
		t.Fatal("wrong-port token reached route lookup")
	}
}

func TestRouteLookupCarriesExactPreviewGrantBinding(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	port := 3000
	resolver := &staticResolver{route: safeStaticRoute(now)}
	g := gatewayForStaticResolver(t, resolver)
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"preview"}, &port, now))
	request := httptest.NewRequest(http.MethodGet, "/preview/"+testPublicID+"/3000/", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	g.ServeHTTP(response, request)
	lookup := resolver.lastLookup()
	if lookup.PublicMachineID != testPublicID || lookup.Capability != "preview" ||
		lookup.CapabilityID != "jti-test-123" || lookup.PreviewPort == nil ||
		*lookup.PreviewPort != port || !lookup.ExpiresAt.Equal(now.Add(5*time.Minute)) ||
		lookup.Organization != "org-test-123" || lookup.Project != "project-test-123" ||
		lookup.LeaseID != "lease-test-123" || len(lookup.Capabilities) != 1 ||
		lookup.Capabilities[0] != "preview" {
		t.Fatalf("route lookup = %#v", lookup)
	}
}

func TestAuthoritativeRouteTenantBindingFailsBeforeProxy(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"files"}, nil, now))
	for _, test := range []struct {
		name  string
		route machineRoute
	}{
		{name: "wrong organization", route: func() machineRoute { route := safeStaticRoute(now); route.Organization = "org-attacker"; return route }()},
		{name: "wrong project", route: func() machineRoute { route := safeStaticRoute(now); route.Project = "project-attacker"; return route }()},
		{name: "wrong current lease", route: func() machineRoute { route := safeStaticRoute(now); route.LeaseID = "lease-replaced"; return route }()},
		{name: "wrong grant identity", route: func() machineRoute { route := safeStaticRoute(now); route.CapabilityID = "other-grant"; return route }()},
		{name: "wrong capability set", route: func() machineRoute { route := safeStaticRoute(now); route.Capabilities = []string{"tty"}; return route }()},
		{name: "wrong capability port", route: func() machineRoute {
			route := safeStaticRoute(now)
			port := 3000
			route.CapabilityPort = &port
			return route
		}()},
		{name: "wrong capability expiry", route: func() machineRoute {
			route := safeStaticRoute(now)
			route.CapabilityExpiresAt = now.Add(4 * time.Minute)
			return route
		}()},
		{name: "route outlives capability", route: func() machineRoute {
			route := safeStaticRoute(now)
			route.ExpiresAt = now.Add(6 * time.Minute)
			return route
		}()},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &staticResolver{route: test.route}
			g := gatewayForStaticResolver(t, resolver)
			request := httptest.NewRequest(http.MethodGet, "/v1/machines/"+testPublicID+"/download?path=x", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			g.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestCapabilityQueryTokensAreRejectedWithoutLookup(t *testing.T) {
	resolver := &staticResolver{route: safeStaticRoute(time.Now())}
	g := gatewayForStaticResolver(t, resolver)
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/machines/"+testPublicID+"/download?path=x&token=must-not-be-in-a-url",
		nil,
	)
	response := httptest.NewRecorder()
	g.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || resolver.calls.Load() != 0 {
		t.Fatalf("status = %d, lookups = %d", response.Code, resolver.calls.Load())
	}
}

func TestPreviewLeaseUsesAnIsolatedWildcardOrigin(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	port := 3000
	route := capabilityRoute{publicMachineID: testPublicID, capability: "preview", previewPort: port}
	resolver := &staticResolver{route: safeStaticRoute(now)}
	g := gatewayForStaticResolver(t, resolver)
	g.cfg.PreviewBaseDomain = "example-user-content.net"
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"preview"}, &port, now))

	wrong := httptest.NewRequest(http.MethodPost, "/v1/capability/exchange", nil)
	wrong.Host = "gateway.example.com"
	wrong.Header.Set("Authorization", "Bearer "+token)
	wrongResponse := httptest.NewRecorder()
	g.ServeHTTP(wrongResponse, wrong)
	if wrongResponse.Code != http.StatusMisdirectedRequest || resolver.calls.Load() != 0 {
		t.Fatalf("wrong-origin status = %d, lookups = %d", wrongResponse.Code, resolver.calls.Load())
	}

	valid := httptest.NewRequest(http.MethodPost, "/v1/capability/exchange", nil)
	valid.Host = previewHostLabel(route, "lease-test-123") + ".example-user-content.net"
	valid.Header.Set("Authorization", "Bearer "+token)
	validResponse := httptest.NewRecorder()
	g.ServeHTTP(validResponse, valid)
	if validResponse.Code != http.StatusNoContent || len(validResponse.Result().Cookies()) != 1 {
		t.Fatalf("valid-origin status = %d, cookies = %#v", validResponse.Code, validResponse.Result().Cookies())
	}
	if validResponse.Result().Cookies()[0].Path != "/" {
		t.Fatalf("isolated cookie path = %q", validResponse.Result().Cookies()[0].Path)
	}
}

func TestPreviewRejectsPathTraversalBeforeLookup(t *testing.T) {
	t.Parallel()
	resolver := &staticResolver{route: safeStaticRoute(time.Now())}
	g := gatewayForStaticResolver(t, resolver)
	request := httptest.NewRequest(http.MethodGet, "/preview/"+testPublicID+"/3000/../../internal/v1/host", nil)
	response := httptest.NewRecorder()
	g.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || resolver.calls.Load() != 0 {
		t.Fatalf("status = %d, lookups = %d", response.Code, resolver.calls.Load())
	}
}

func TestSpecialRoutesRejectAPIKeysAndNonUpgradeStreams(t *testing.T) {
	t.Parallel()
	resolver := &staticResolver{route: safeStaticRoute(time.Now())}
	g := gatewayForStaticResolver(t, resolver)

	nonUpgrade := httptest.NewRequest(http.MethodGet, "/v1/machines/"+testPublicID+"/tty", nil)
	nonUpgrade.Header.Set("Authorization", "Bearer customer-api-key")
	response := httptest.NewRecorder()
	g.ServeHTTP(response, nonUpgrade)
	if response.Code != http.StatusUpgradeRequired {
		t.Fatalf("non-upgrade status = %d", response.Code)
	}

	apiKey := httptest.NewRequest(http.MethodGet, "/v1/machines/"+testPublicID+"/download?path=x", nil)
	apiKey.Header.Set("Authorization", "Bearer customer-api-key")
	response = httptest.NewRecorder()
	g.ServeHTTP(response, apiKey)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("API key status = %d", response.Code)
	}
	if resolver.calls.Load() != 0 {
		t.Fatal("rejected credentials reached route lookup")
	}
}

func TestHostTargetRejectsSSRFAddresses(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t, "http://127.0.0.1:8081", "10.0.0.1", 8080)
	cfg.AllowedHostCIDRs = []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("fd00::/8"),
	}
	g := mustGateway(t, cfg)

	for _, address := range []string{
		"127.0.0.1", "169.254.169.254", "100.64.0.1", "8.8.8.8", "0.0.0.0", "224.0.0.1",
		"::1", "fe80::1", "2001:4860:4860::8888", "localhost", "metadata.google.internal",
		"http://10.0.0.1", "10.0.0.1:8080", "2130706433", "0177.0.0.1", "10.0.0.1%25eth0",
	} {
		address := address
		t.Run(address, func(t *testing.T) {
			t.Parallel()
			if _, _, err := g.hostTarget(address); err == nil {
				t.Fatalf("accepted hostile route address %q", address)
			}
		})
	}
	for _, address := range []string{"10.20.30.40", "172.16.0.1", "192.168.100.20", "fd42::123"} {
		if _, expected, err := g.hostTarget(address); err != nil || !strings.Contains(expected, address) {
			t.Fatalf("private address %q rejected: target=%q error=%v", address, expected, err)
		}
	}
}

func TestProductionConfigRequiresSeparateStrongTrustDomains(t *testing.T) {
	cfg := testConfig(t, "https://control.example.com", "10.0.0.1", 8080)
	cfg.Production = true
	cfg.GatewayToken = strings.Repeat("g", 40)
	cfg.CapabilitySecret = strings.Repeat("c", 40)
	cfg.PreviewBaseDomain = "example-user-content.net"
	cfg.TrustedSiteDomain = "example.com"
	cfg.Telemetry = TelemetryConfig{
		Enabled: true, Endpoint: "https://otel.example.net", Authorization: "Bearer telemetry-secret-value",
		ServiceVersion: "2026.08.09", InstanceID: "gateway-ca-1-a", DeploymentEnv: "production",
		Region: "ca-tor-1", ExportInterval: 15 * time.Second, ExportTimeout: 10 * time.Second, TraceSample: 0.1,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid production config rejected: %v", err)
	}
	cfg.PreviewBaseDomain = "preview.example.com"
	if err := cfg.Validate(); err == nil {
		t.Fatal("same-site preview domain was accepted")
	}
	cfg.TrustedSiteDomain = "dashboard.example.com"
	if err := cfg.Validate(); err == nil {
		t.Fatal("sibling same-site preview domain was accepted")
	}
}

func TestUnsafeControlPlaneRouteNeverDials(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"files"}, nil, now))
	for _, address := range []string{"127.0.0.1", "169.254.169.254", "8.8.8.8", "localhost", "http://10.0.0.1"} {
		resolver := &staticResolver{route: machineRoute{
			HostAddress: address, HostMachineID: testLocalID, LeaseID: "lease-test-123",
			Organization: "org-test-123", Project: "project-test-123", ExpiresAt: now.Add(time.Minute),
		}}
		g := gatewayForStaticResolver(t, resolver)
		g.cfg.AllowedHostCIDRs = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
		request := httptest.NewRequest(http.MethodGet, "/v1/machines/"+testPublicID+"/download?path=x", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		g.ServeHTTP(response, request)
		if response.Code != http.StatusBadGateway {
			t.Fatalf("address %q status = %d, body = %s", address, response.Code, response.Body.String())
		}
	}
}

func TestExpiredLeaseAndInvalidLocalIDFailClosed(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"files"}, nil, now))
	for _, test := range []struct {
		name       string
		route      machineRoute
		wantStatus int
	}{
		{name: "expired lease", route: machineRoute{HostAddress: "127.0.0.1", HostMachineID: testLocalID, LeaseID: "lease-test-123", Organization: "org-test-123", Project: "project-test-123", ExpiresAt: now.Add(-time.Second)}, wantStatus: http.StatusNotFound},
		{name: "invalid local id", route: machineRoute{HostAddress: "127.0.0.1", HostMachineID: "../other", LeaseID: "lease-test-123", Organization: "org-test-123", Project: "project-test-123", ExpiresAt: now.Add(time.Minute)}, wantStatus: http.StatusBadGateway},
		{name: "stale capability lease", route: machineRoute{HostAddress: "127.0.0.1", HostMachineID: testLocalID, LeaseID: "new-lease", Organization: "org-test-123", Project: "project-test-123", ExpiresAt: now.Add(time.Minute)}, wantStatus: http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &staticResolver{route: test.route}
			g := gatewayForStaticResolver(t, resolver)
			request := httptest.NewRequest(http.MethodGet, "/v1/machines/"+testPublicID+"/download?path=x", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			g.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", response.Code, test.wantStatus, response.Body.String())
			}
		})
	}
}

func TestPerTenantConnectionLimit(t *testing.T) {
	t.Parallel()
	entered := make(chan struct{}, 1)
	releaseHost := make(chan struct{})
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-releaseHost
		_, _ = w.Write([]byte("done"))
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	controlPlane := routeControlPlane(t, hostName, testLocalID, time.Now().Add(time.Minute), nil)
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, hostName, hostPort)
	cfg.MaxConnectionsPerTenant = 1
	gatewayServer := httptest.NewServer(mustGateway(t, cfg))
	defer gatewayServer.Close()
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"files"}, nil, time.Now()))
	endpoint := gatewayServer.URL + "/v1/machines/" + testPublicID + "/download?path=x"
	client := &http.Client{}
	request := func() *http.Request {
		req, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return req
	}

	firstDone := make(chan error, 1)
	go func() {
		response, err := client.Do(request())
		if err == nil {
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				err = errors.New(response.Status)
			}
		}
		firstDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("first request did not reach host")
	}
	second, err := client.Do(request())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Body.Close()
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second status = %d, body = %s", second.StatusCode, mustReadAll(t, second.Body))
	}
	close(releaseHost)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func TestActiveWebSocketClosesAfterCapabilityRevocation(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			kind, payload, readErr := connection.ReadMessage()
			if readErr != nil {
				return
			}
			if writeErr := connection.WriteMessage(kind, payload); writeErr != nil {
				return
			}
		}
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	cfg := testConfig(t, "http://127.0.0.1:1", hostName, hostPort)
	cfg.CapabilityRevalidationInterval = 250 * time.Millisecond
	resolver := &staticResolver{route: machineRoute{
		HostAddress: hostName, HostMachineID: testLocalID, LeaseID: "lease-test-123",
		Organization: "org-test-123", Project: "project-test-123", HostToken: testHostToken,
		ExpiresAt: time.Now().Add(time.Minute),
	}}
	g := mustGateway(t, cfg)
	g.resolver = resolver
	server := httptest.NewServer(g)
	defer server.Close()

	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"tty"}, nil, time.Now()))
	websocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/machines/" + testPublicID + "/tty"
	header := http.Header{}
	header.Set("Sec-WebSocket-Protocol", capabilityWebSocketProtocolPrefix+token)
	connection, response, err := websocket.DefaultDialer.Dial(websocketURL, header)
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial: %v (status %d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.WriteMessage(websocket.TextMessage, []byte("before revoke")); err != nil {
		t.Fatal(err)
	}
	if _, payload, err := connection.ReadMessage(); err != nil || string(payload) != "before revoke" {
		t.Fatalf("pre-revoke echo = %q, %v", payload, err)
	}

	resolver.setError(errRouteNotFound)
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := connection.ReadMessage(); err == nil {
		t.Fatal("revoked capability left the upgraded stream open")
	}
	if resolver.calls.Load() < 2 {
		t.Fatalf("route lookups = %d, want initial plus revalidation", resolver.calls.Load())
	}
}

func TestActiveHTTPStreamClosesAtAbsoluteCapabilityExpiry(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	hostCanceled := make(chan struct{})
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("stream started"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
		close(hostCanceled)
	}))
	defer host.Close()
	hostName, hostPort := testServerAddress(t, host.URL)
	cfg := testConfig(t, "http://127.0.0.1:1", hostName, hostPort)
	resolver := &staticResolver{route: machineRoute{
		HostAddress: hostName, HostMachineID: testLocalID, LeaseID: "lease-test-123",
		Organization: "org-test-123", Project: "project-test-123", HostToken: testHostToken,
		ExpiresAt: now.Add(2 * time.Second),
	}}
	g := mustGateway(t, cfg)
	g.resolver = resolver
	server := httptest.NewServer(g)
	defer server.Close()

	payload := tokenPayload(testPublicID, []string{"files"}, nil, now)
	payload["exp"] = now.Add(2 * time.Second).Unix()
	token := signCapability(t, testGatewaySecret, payload)
	request, err := http.NewRequest(http.MethodGet, server.URL+"/v1/machines/"+testPublicID+"/download?path=x", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	_, _ = io.ReadAll(response.Body)
	select {
	case <-hostCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("capability expiry did not cancel the active upstream stream")
	}
}

func TestTokenParserRejectsAlgorithmConfusionAndTrailingJSON(t *testing.T) {
	t.Parallel()
	now := time.Now().Truncate(time.Second)
	payload := tokenPayload(testPublicID, []string{"files"}, nil, now)
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{
		`{"alg":"none","typ":"JWT"}`,
		`{"alg":"HS512","typ":"JWT"}`,
		`{"alg":"HS256","typ":"JWT"}{}`,
	} {
		unsigned := base64.RawURLEncoding.EncodeToString([]byte(header)) + "." + base64.RawURLEncoding.EncodeToString(encodedPayload)
		token := unsigned + "." + base64.RawURLEncoding.EncodeToString([]byte("not-a-signature"))
		if _, err := verifyCapabilityToken(token, testGatewaySecret, now); err == nil {
			t.Fatalf("accepted token header %q", header)
		}
	}
}

func gatewayForStaticResolver(t *testing.T, resolver routeResolver) *gateway {
	t.Helper()
	cfg := testConfig(t, "http://127.0.0.1:8081", "127.0.0.1", 1)
	return &gateway{
		cfg:              cfg,
		now:              time.Now,
		resolver:         resolver,
		controlProxy:     nil,
		limits:           newTenantLimiter(cfg.MaxConnectionsPerTenant, cfg.TenantBytesPerSecond),
		restLimits:       newRESTRateLimiter(cfg.RESTRequestsPerWindow, cfg.RESTLimiterSlots, cfg.RESTWindow),
		streams:          newStreamDrainer(),
		streamInstanceID: "gateway-test",
	}
}

func safeStaticRoute(now time.Time) machineRoute {
	return machineRoute{
		HostAddress: "127.0.0.1", HostMachineID: testLocalID, LeaseID: "lease-test-123",
		Organization: "org-test-123", Project: "project-test-123", HostToken: testHostToken, ExpiresAt: now.Add(time.Minute),
	}
}

func clonePayload(payload map[string]any) map[string]any {
	clone := make(map[string]any, len(payload))
	for key, value := range payload {
		clone[key] = value
	}
	return clone
}

func withClaims(payload map[string]any, values ...any) map[string]any {
	clone := clonePayload(payload)
	for index := 0; index < len(values); index += 2 {
		clone[values[index].(string)] = values[index+1]
	}
	return clone
}
