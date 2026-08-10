package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestPublicRESTActiveLimiterSurvivesRateWindowRollover(t *testing.T) {
	started := make(chan struct{})
	releaseUpstream := make(chan struct{})
	var upstream atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstream.Add(1)
		select {
		case <-started:
		default:
			close(started)
		}
		<-releaseUpstream
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 1)
	cfg.RESTMaxActive = 1
	cfg.RESTMaxActivePerSource = 1
	g := mustGateway(t, cfg)
	now := time.Now().Truncate(time.Second)
	g.now = func() time.Time { return now }

	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		request := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
		request.RemoteAddr = "203.0.113.44:1234"
		g.ServeHTTP(firstResponse, request)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("first request did not reach the control plane")
	}

	now = now.Add(2 * cfg.RESTWindow)
	limitedRequest := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
	limitedRequest.RemoteAddr = "203.0.113.44:5678"
	limitedResponse := httptest.NewRecorder()
	g.ServeHTTP(limitedResponse, limitedRequest)
	if limitedResponse.Code != http.StatusTooManyRequests || limitedResponse.Header().Get("Retry-After") != "1" {
		t.Fatalf("active limit response = %d, Retry-After %q, body %s", limitedResponse.Code, limitedResponse.Header().Get("Retry-After"), limitedResponse.Body.String())
	}
	if upstream.Load() != 1 {
		t.Fatalf("control-plane calls = %d, want 1", upstream.Load())
	}

	close(releaseUpstream)
	select {
	case <-firstDone:
	case <-time.After(2 * time.Second):
		t.Fatal("first request did not release")
	}
	if firstResponse.Code != http.StatusNoContent {
		t.Fatalf("first status = %d", firstResponse.Code)
	}

	next := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
	next.RemoteAddr = "203.0.113.44:9012"
	nextResponse := httptest.NewRecorder()
	g.ServeHTTP(nextResponse, next)
	if nextResponse.Code != http.StatusNoContent || upstream.Load() != 2 {
		t.Fatalf("released capacity status=%d calls=%d", nextResponse.Code, upstream.Load())
	}
}

func TestRESTMaximumDurationCancelsAnUpstreamRequest(t *testing.T) {
	started := make(chan struct{})
	controlPlane := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 1)
	g := mustGateway(t, cfg)
	g.cfg.RESTMaxDuration = 50 * time.Millisecond

	request := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
	request.RemoteAddr = "203.0.113.44:1234"
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		g.ServeHTTP(response, request.WithContext(context.Background()))
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not reach upstream")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("gateway did not enforce the REST duration")
	}
	if response.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestRESTBodyDeadlineStopsASlowChunkedUpload(t *testing.T) {
	upstreamStarted := make(chan struct{})
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		close(upstreamStarted)
		_, _ = io.Copy(io.Discard, request.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 1)
	g := mustGateway(t, cfg)
	// Production validation keeps the bound at >=1s. A short injected value
	// makes the socket-deadline regression fast without weakening the contract.
	g.cfg.RESTBodyTimeout = 100 * time.Millisecond
	public := httptest.NewServer(g)
	defer public.Close()

	reader, writer := io.Pipe()
	request, err := http.NewRequest(http.MethodPost, public.URL+"/v1/machines", reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	type responseResult struct {
		response *http.Response
		err      error
	}
	result := make(chan responseResult, 1)
	go func() {
		response, requestErr := http.DefaultClient.Do(request)
		result <- responseResult{response: response, err: requestErr}
	}()
	if _, err := writer.Write([]byte("{")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-upstreamStarted:
	case <-time.After(time.Second):
		t.Fatal("slow upload did not reach the proxy")
	}

	select {
	case observed := <-result:
		_ = writer.Close()
		if observed.err != nil {
			t.Fatalf("request failed without bounded response: %v", observed.err)
		}
		defer observed.response.Body.Close()
		if observed.response.StatusCode != http.StatusRequestTimeout {
			body, _ := io.ReadAll(observed.response.Body)
			t.Fatalf("status = %d, body = %s", observed.response.StatusCode, body)
		}
	case <-time.After(2 * time.Second):
		_ = writer.Close()
		t.Fatal("slow request body survived its gateway deadline")
	}
}

func TestReadinessIsSingleFlightAndBrieflyCached(t *testing.T) {
	started := make(chan struct{})
	releaseUpstream := make(chan struct{})
	var upstream atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/readyz" {
			t.Fatalf("upstream path = %s", request.URL.Path)
		}
		upstream.Add(1)
		select {
		case <-started:
		default:
			close(started)
		}
		<-releaseUpstream
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	}))
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 1)
	cfg.RESTMaxActive = 16
	cfg.RESTMaxActivePerSource = 16
	g := mustGateway(t, cfg)
	now := time.Now().Truncate(time.Second)
	g.now = func() time.Time { return now }

	const requests = 8
	responses := make([]*httptest.ResponseRecorder, requests)
	done := make(chan struct{}, requests)
	for index := 0; index < requests; index++ {
		responses[index] = httptest.NewRecorder()
		go func(index int) {
			request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
			request.RemoteAddr = "203.0.113.44:1234"
			g.ServeHTTP(responses[index], request)
			done <- struct{}{}
		}(index)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("readiness probe did not reach the control plane")
	}
	if upstream.Load() != 1 {
		t.Fatalf("concurrent readiness calls = %d, want 1", upstream.Load())
	}
	close(releaseUpstream)
	for index := 0; index < requests; index++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("readiness request did not complete")
		}
	}
	for _, response := range responses {
		if response.Code != http.StatusOK || response.Body.String() != `{"status":"ready"}` {
			t.Fatalf("cached readiness = %d %s", response.Code, response.Body.String())
		}
	}

	cached := httptest.NewRecorder()
	cachedRequest := httptest.NewRequest(http.MethodHead, "/readyz", nil)
	cachedRequest.RemoteAddr = "203.0.113.44:1234"
	g.ServeHTTP(cached, cachedRequest)
	if cached.Code != http.StatusOK || cached.Body.Len() != 0 || upstream.Load() != 1 {
		t.Fatalf("HEAD cache status=%d bytes=%d calls=%d", cached.Code, cached.Body.Len(), upstream.Load())
	}

	now = now.Add(2 * readinessCacheTTL)
	refreshed := httptest.NewRecorder()
	refreshedRequest := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	refreshedRequest.RemoteAddr = "203.0.113.44:1234"
	g.ServeHTTP(refreshed, refreshedRequest)
	if refreshed.Code != http.StatusOK || upstream.Load() != 2 {
		t.Fatalf("refreshed status=%d calls=%d", refreshed.Code, upstream.Load())
	}
}

func TestPublicRESTLimiterRejectsBeforeControlPlane(t *testing.T) {
	var upstream atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstream.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	cfg := testConfig(t, controlPlane.URL, "127.0.0.1", 1)
	cfg.RESTRequestsPerWindow = 2
	g := mustGateway(t, cfg)
	now := time.Now().Truncate(time.Second)
	g.now = func() time.Time { return now }

	for index := 0; index < 3; index++ {
		request := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
		request.RemoteAddr = "203.0.113.44:1234"
		response := httptest.NewRecorder()
		g.ServeHTTP(response, request)
		if index < 2 && response.Code != http.StatusNoContent {
			t.Fatalf("request %d status = %d", index, response.Code)
		}
		if index == 2 {
			if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "60" {
				t.Fatalf("limited response = %d, Retry-After %q, body %s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
			}
		}
	}
	if upstream.Load() != 2 {
		t.Fatalf("control-plane requests = %d, want 2", upstream.Load())
	}
}

func TestPublicLimiterCoversCapabilityExchangeBeforeAuthenticationAndLookup(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	port := 3000
	route := capabilityRoute{publicMachineID: testPublicID, capability: "preview", previewPort: port}
	resolved := safeStaticRoute(now)
	resolved.CapabilityID = "jti-test-123"
	resolved.Capabilities = []string{"preview"}
	resolved.CapabilityPort = &port
	resolved.CapabilityExpiresAt = now.Add(5 * time.Minute)
	resolved.StreamExpiresAt = now.Add(15 * time.Second)
	resolver := &staticResolver{route: resolved}
	g := gatewayForStaticResolver(t, resolver)
	g.cfg.PreviewBaseDomain = "example-user-content.net"
	g.restLimits = newRESTRateLimiter(1, 1_024, time.Minute)
	g.now = func() time.Time { return now }
	token := signCapability(t, testGatewaySecret, tokenPayload(testPublicID, []string{"preview"}, &port, now))

	for index := 0; index < 2; index++ {
		request := httptest.NewRequest(http.MethodPost, "/v1/capability/exchange", nil)
		request.RemoteAddr = "203.0.113.44:1234"
		request.Host = previewHostLabel(route, "lease-test-123") + ".example-user-content.net"
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		g.ServeHTTP(response, request)
		if index == 0 && response.Code != http.StatusNoContent {
			t.Fatalf("first exchange status = %d, body = %s", response.Code, response.Body.String())
		}
		if index == 1 && (response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "60") {
			t.Fatalf("limited exchange = %d, Retry-After %q, body %s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
		}
	}
	if resolver.calls.Load() != 1 {
		t.Fatalf("capability route lookups = %d, want 1", resolver.calls.Load())
	}
}

func TestPublicRESTLimiterCoarsensAddressesAndBoundsSlots(t *testing.T) {
	limiter := newRESTRateLimiter(1, 1_024, time.Minute)
	now := time.Now()
	if allowed, _ := limiter.allow(coarseAddress(netip.MustParseAddr("203.0.113.10"), true), now); !allowed {
		t.Fatal("first request rejected")
	}
	if allowed, _ := limiter.allow(coarseAddress(netip.MustParseAddr("203.0.113.200"), true), now); allowed {
		t.Fatal("second address in the same IPv4 /24 received separate capacity")
	}
	if len(limiter.slots) != 1_024 {
		t.Fatalf("slot cardinality = %d", len(limiter.slots))
	}
}

func TestTrustedPublicEdgeHeaderCannotBeSpoofedByDirectPeers(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:8081", "127.0.0.1", 1)
	cfg.TrustedEdgeCIDRs = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	g := mustGateway(t, cfg)

	trusted := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
	trusted.RemoteAddr = "192.0.2.10:443"
	trusted.Header.Set(cfg.TrustedEdgeIPHeader, "203.0.113.81")
	if address, ok := g.publicClientAddress(trusted); !ok || address.String() != "203.0.113.81" {
		t.Fatalf("trusted edge address = %v, %v", address, ok)
	}

	untrusted := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
	untrusted.RemoteAddr = "198.51.100.10:443"
	untrusted.Header.Set(cfg.TrustedEdgeIPHeader, "203.0.113.81")
	if address, ok := g.publicClientAddress(untrusted); !ok || address.String() != "198.51.100.10" {
		t.Fatalf("direct peer spoof was trusted: %v, %v", address, ok)
	}

	malformed := httptest.NewRequest(http.MethodGet, "/v1/machines", nil)
	malformed.RemoteAddr = "192.0.2.10:443"
	malformed.Header.Set(cfg.TrustedEdgeIPHeader, "203.0.113.81, 198.51.100.1")
	if address, _ := g.publicClientAddress(malformed); address.String() != "192.0.2.10" {
		t.Fatalf("ambiguous edge header did not collapse to direct peer: %v", address)
	}
}

func TestRESTLimiterConfigurationIsStrictlyBounded(t *testing.T) {
	base := testConfig(t, "http://127.0.0.1:8081", "127.0.0.1", 1)
	for name, mutate := range map[string]func(*Config){
		"zero requests": func(cfg *Config) { cfg.RESTRequestsPerWindow = 0 },
		"long window":   func(cfg *Config) { cfg.RESTWindow = time.Hour + time.Second },
		"tiny slots":    func(cfg *Config) { cfg.RESTLimiterSlots = 512 },
		"uneven slots":  func(cfg *Config) { cfg.RESTLimiterSlots = 3_000 },
		"zero active":   func(cfg *Config) { cfg.RESTMaxActive = 0 },
		"peer exceeds global": func(cfg *Config) {
			cfg.RESTMaxActivePerSource = cfg.RESTMaxActive + 1
		},
		"short total duration": func(cfg *Config) { cfg.RESTMaxDuration = time.Minute },
		"long body timeout":    func(cfg *Config) { cfg.RESTBodyTimeout = time.Minute + time.Second },
		"internal header": func(cfg *Config) {
			cfg.TrustedEdgeIPHeader = clientAddressHeader
		},
		"credential header": func(cfg *Config) { cfg.TrustedEdgeIPHeader = "Authorization" },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := base
			mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("unsafe limiter configuration was accepted")
			}
		})
	}
	if got := strconv.Itoa(base.RESTRequestsPerWindow); got != "600" {
		t.Fatalf("unexpected test default %s", got)
	}
}
