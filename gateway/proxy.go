package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	errRouteNotFound = errors.New("machine route not found")
	errRouteExpired  = errors.New("machine route expired")
	errStreamLimit   = errors.New("global stream quota exceeded")
	errBadRoute      = errors.New("control plane returned an invalid route")
)

type machineRoute struct {
	HostAddress         string
	HostMachineID       string
	LeaseID             string
	Organization        string
	Project             string
	CapabilityID        string
	Capabilities        []string
	CapabilityPort      *int
	CapabilityExpiresAt time.Time
	StreamID            string
	StreamBandwidth     int64
	StreamExpiresAt     time.Time
	HostToken           string
	ExpiresAt           time.Time
}

type routeLookup struct {
	PublicMachineID string
	Capability      string
	CapabilityID    string
	Capabilities    []string
	Organization    string
	Project         string
	LeaseID         string
	PreviewPort     *int
	ExpiresAt       time.Time
	StreamID        string
	StreamInstance  string
	StreamBandwidth int64
}

type routeResolver interface {
	Resolve(context.Context, routeLookup) (machineRoute, error)
}

type controlPlaneResolver struct {
	baseURL   *url.URL
	token     string
	client    *http.Client
	now       func() time.Time
	telemetry *gatewayTelemetry
}

func newControlPlaneResolver(cfg Config, transport http.RoundTripper, runtimes ...*gatewayTelemetry) (*controlPlaneResolver, error) {
	baseURL, err := url.Parse(cfg.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	telemetry := &gatewayTelemetry{}
	if len(runtimes) > 0 && runtimes[0] != nil {
		telemetry = runtimes[0]
	}
	return &controlPlaneResolver{
		baseURL: baseURL,
		token:   cfg.GatewayToken,
		client: &http.Client{
			Transport: transport,
			Timeout:   cfg.ControlPlaneTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("control-plane redirects are disabled")
			},
		},
		now:       time.Now,
		telemetry: telemetry,
	}, nil
}

func (r *controlPlaneResolver) Resolve(ctx context.Context, lookup routeLookup) (machineRoute, error) {
	endpoint := *r.baseURL
	endpoint.Path = "/internal/v1/routing/machines/" + url.PathEscape(lookup.PublicMachineID)
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return machineRoute{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+r.token)
	request.Header.Set("X-Nehemiah-Capability", lookup.Capability)
	request.Header.Set("X-Nehemiah-Capability-ID", lookup.CapabilityID)
	request.Header.Set("X-Nehemiah-Capabilities", strings.Join(lookup.Capabilities, ","))
	request.Header.Set("X-Nehemiah-Capability-Organization-ID", lookup.Organization)
	request.Header.Set("X-Nehemiah-Capability-Project-ID", lookup.Project)
	request.Header.Set("X-Nehemiah-Capability-Lease-ID", lookup.LeaseID)
	request.Header.Set("X-Nehemiah-Capability-Expires-At", lookup.ExpiresAt.UTC().Format(time.RFC3339Nano))
	if lookup.StreamID != "" {
		request.Header.Set("X-Nehemiah-Stream-ID", lookup.StreamID)
		request.Header.Set("X-Nehemiah-Stream-Instance-ID", lookup.StreamInstance)
		request.Header.Set("X-Nehemiah-Stream-Bandwidth-Bytes-Per-Second", strconv.FormatInt(lookup.StreamBandwidth, 10))
	}
	if lookup.PreviewPort != nil {
		request.Header.Set("X-Nehemiah-Preview-Port", strconv.Itoa(*lookup.PreviewPort))
	}
	if id := requestID(ctx); id != "" {
		request.Header.Set("X-Request-ID", id)
	}
	r.telemetry.inject(ctx, request.Header)
	response, err := r.client.Do(request)
	if err != nil {
		return machineRoute{}, fmt.Errorf("route lookup failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return machineRoute{}, errRouteNotFound
	}
	if response.StatusCode == http.StatusTooManyRequests {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return machineRoute{}, errStreamLimit
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return machineRoute{}, fmt.Errorf("route lookup returned %d", response.StatusCode)
	}
	var body struct {
		HostAddress         string   `json:"host_address"`
		HostMachineID       string   `json:"host_machine_id"`
		LeaseID             string   `json:"lease_id"`
		Organization        string   `json:"organization_id"`
		Project             string   `json:"project_id"`
		CapabilityID        string   `json:"capability_id"`
		Capabilities        []string `json:"capabilities"`
		CapabilityPort      *int     `json:"capability_port"`
		CapabilityExpiresAt string   `json:"capability_expires_at"`
		StreamID            string   `json:"stream_id"`
		StreamBandwidth     int64    `json:"stream_bandwidth_bytes_per_second"`
		StreamExpiresAt     string   `json:"stream_expires_at"`
		HostToken           string   `json:"host_token"`
		ExpiresAt           string   `json:"expires_at"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return machineRoute{}, fmt.Errorf("%w: %v", errBadRoute, err)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, body.ExpiresAt)
	capabilityExpiresAt, capabilityExpiryErr := time.Parse(time.RFC3339Nano, body.CapabilityExpiresAt)
	var streamExpiresAt time.Time
	var streamExpiryErr error
	if lookup.StreamID != "" {
		streamExpiresAt, streamExpiryErr = time.Parse(time.RFC3339Nano, body.StreamExpiresAt)
	}
	now := r.now()
	if err != nil || !validLocalMachineID(body.HostMachineID) || !boundedClaim(body.LeaseID) ||
		!boundedClaim(body.Organization) || !boundedClaim(body.Project) ||
		!boundedClaim(body.CapabilityID) || capabilityExpiryErr != nil ||
		body.StreamID != lookup.StreamID || body.StreamBandwidth != lookup.StreamBandwidth ||
		(lookup.StreamID != "" && (streamExpiryErr != nil || !streamExpiresAt.After(now) || streamExpiresAt.After(now.Add(30*time.Second)))) ||
		(lookup.StreamID == "" && body.StreamExpiresAt != "") ||
		len(body.HostToken) < 32 || len(body.HostToken) > 512 || strings.TrimSpace(body.HostToken) != body.HostToken {
		return machineRoute{}, errBadRoute
	}
	if !expiresAt.After(now) {
		return machineRoute{}, errRouteExpired
	}
	return machineRoute{
		HostAddress:         body.HostAddress,
		HostMachineID:       body.HostMachineID,
		LeaseID:             body.LeaseID,
		Organization:        body.Organization,
		Project:             body.Project,
		CapabilityID:        body.CapabilityID,
		Capabilities:        body.Capabilities,
		CapabilityPort:      body.CapabilityPort,
		CapabilityExpiresAt: capabilityExpiresAt,
		StreamID:            body.StreamID,
		StreamBandwidth:     body.StreamBandwidth,
		StreamExpiresAt:     streamExpiresAt,
		HostToken:           body.HostToken,
		ExpiresAt:           expiresAt,
	}, nil
}

func (r *controlPlaneResolver) Release(ctx context.Context, streamID, instanceID string) error {
	endpoint := *r.baseURL
	endpoint.Path = "/internal/v1/routing/streams/" + url.PathEscape(streamID)
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+r.token)
	request.Header.Set("X-Nehemiah-Stream-Instance-ID", instanceID)
	if id := requestID(ctx); id != "" {
		request.Header.Set("X-Request-ID", id)
	}
	r.telemetry.inject(ctx, request.Header)
	response, err := r.client.Do(request)
	if err != nil {
		return fmt.Errorf("stream release failed: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("stream release returned %d", response.StatusCode)
	}
	return nil
}

func newBaseTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

func newControlPlaneTransport(cfg Config) (*http.Transport, error) {
	transport := newBaseTransport()
	target, err := url.Parse(cfg.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	if target.Scheme != "https" {
		return transport, nil
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.ControlPlaneServerName}
	if cfg.ControlPlaneCAFile != "" {
		info, statErr := os.Stat(cfg.ControlPlaneCAFile)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 1<<20 {
			return nil, errors.New("control-plane CA file must be a non-empty regular file no larger than 1 MiB")
		}
		certificate, readErr := os.ReadFile(cfg.ControlPlaneCAFile)
		if readErr != nil {
			return nil, fmt.Errorf("read control-plane CA file: %w", readErr)
		}
		roots, rootsErr := x509.SystemCertPool()
		if rootsErr != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(certificate) {
			return nil, errors.New("control-plane CA file contains no valid certificates")
		}
		tlsConfig.RootCAs = roots
	}
	transport.TLSClientConfig = tlsConfig
	return transport, nil
}

func newControlPlaneProxy(target *url.URL, transport http.RoundTripper, cfg Config, runtimes ...*gatewayTelemetry) *httputil.ReverseProxy {
	telemetry := &gatewayTelemetry{}
	if len(runtimes) > 0 && runtimes[0] != nil {
		telemetry = runtimes[0]
	}
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.Host = target.Host
			stripHopByHop(request.Out.Header)
			if isWebSocketUpgrade(request.In) {
				request.Out.Header.Set("Connection", "Upgrade")
				request.Out.Header.Set("Upgrade", "websocket")
			}
			stripForwardingHeaders(request.Out.Header)
			request.Out.Header.Del(cfg.TrustedEdgeIPHeader)
			request.Out.Header.Del(clientAddressHeader)
			request.Out.Header.Del(clientTimestampHeader)
			request.Out.Header.Del(clientSignatureHeader)
			request.Out.Header["X-Forwarded-For"] = nil
			if address := publicClientAddressFromContext(request.In.Context()); address != "" {
				timestamp := strconv.FormatInt(time.Now().Unix(), 10)
				request.Out.Header.Set(clientAddressHeader, address)
				request.Out.Header.Set(clientTimestampHeader, timestamp)
				request.Out.Header.Set(clientSignatureHeader, clientAddressSignature(cfg.GatewayToken, address, timestamp))
			}
			if id := requestID(request.In.Context()); id != "" {
				request.Out.Header.Set("X-Request-ID", id)
			}
			telemetry.inject(request.In.Context(), request.Out.Header)
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode != http.StatusSwitchingProtocols {
				stripHopByHop(response.Header)
			}
			return nil
		},
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, proxyErr error) {
		if errors.Is(r.Context().Err(), context.DeadlineExceeded) {
			writeProblem(w, http.StatusGatewayTimeout, "request_duration_exceeded", "The gateway request duration limit was reached.", requestID(r.Context()))
			return
		}
		if errors.Is(proxyErr, errRESTBodyTimeout) || restBodyTimedOut(r) {
			writeProblem(w, http.StatusRequestTimeout, "request_body_timeout", "The request body was not received before the deadline.", requestID(r.Context()))
			return
		}
		var networkError net.Error
		if errors.As(proxyErr, &networkError) && networkError.Timeout() {
			writeProblem(w, http.StatusRequestTimeout, "request_body_timeout", "The request body was not received before the deadline.", requestID(r.Context()))
			return
		}
		writeProblem(w, http.StatusBadGateway, "control_plane_unavailable", "The control plane is unavailable.", requestID(r.Context()))
	}
	return proxy
}

func (g *gateway) proxyToHost(w http.ResponseWriter, r *http.Request, route capabilityRoute, resolved machineRoute, bandwidth *byteLimiter, capabilityCookie *http.Cookie, capabilityToken string, echoSubprotocol bool) {
	target, expectedAddress, err := g.hostTarget(resolved.HostAddress)
	if err != nil {
		writeProblem(w, http.StatusBadGateway, "invalid_machine_route", "The machine route is invalid.", requestID(r.Context()))
		return
	}
	publicPath := r.URL.Path
	proxy := &httputil.ReverseProxy{
		Transport: g.hostTransport(expectedAddress, bandwidth, r.Context(), route.capability),
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.Host = target.Host
			request.Out.URL.Path = route.upstreamPath(resolved.HostMachineID)
			request.Out.URL.RawPath = ""
			query := request.Out.URL.Query()
			query.Del("token")
			query.Del("upstream")
			request.Out.URL.RawQuery = query.Encode()
			stripHopByHop(request.Out.Header)
			if isWebSocketUpgrade(request.In) {
				request.Out.Header.Set("Connection", "Upgrade")
				request.Out.Header.Set("Upgrade", "websocket")
			}
			stripForwardingHeaders(request.Out.Header)
			stripSensitiveHostHeaders(request.Out.Header)
			request.Out.Header["X-Forwarded-For"] = nil
			request.Out.Header.Set("Authorization", "Bearer "+resolved.HostToken)
			request.Out.Header.Set("X-Nehemiah-Lease-ID", resolved.LeaseID)
			if id := requestID(request.In.Context()); id != "" {
				request.Out.Header.Set("X-Request-ID", id)
			}
			g.telemetry.inject(request.In.Context(), request.Out.Header)
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode != http.StatusSwitchingProtocols {
				stripHopByHop(response.Header)
			} else if echoSubprotocol && response.Header.Get("Sec-WebSocket-Protocol") == "" {
				// The client offered the capability as a subprotocol and the host
				// selected none; echo it so the browser handshake completes. If the
				// host already selected an offered subprotocol, leave it in place.
				response.Header.Set("Sec-WebSocket-Protocol", capabilityWebSocketProtocolPrefix+capabilityToken)
			}
			response.Header.Del("Server")
			if route.capability == "preview" {
				// A guest must never set or overwrite a gateway-origin capability
				// cookie. Preview state belongs on an isolated application origin.
				response.Header.Del("Set-Cookie")
				response.Header.Del("Service-Worker-Allowed")
				response.Header.Del("Clear-Site-Data")
				if capabilityCookie != nil {
					response.Header.Add("Set-Cookie", capabilityCookie.String())
				}
				rewritePreviewLocation(response, route, publicPath)
				response.Header.Set("Referrer-Policy", "no-referrer")
				response.Header.Set("X-Content-Type-Options", "nosniff")
			}
			return nil
		},
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, request *http.Request, _ error) {
		writeProblem(w, http.StatusBadGateway, "machine_unavailable", "The machine endpoint is unavailable.", requestID(request.Context()))
	}
	proxy.ServeHTTP(w, r)
}

func (g *gateway) hostTarget(rawAddress string) (*url.URL, string, error) {
	address, err := netip.ParseAddr(rawAddress)
	if err != nil {
		return nil, "", fmt.Errorf("host address must be an IP literal")
	}
	address = address.Unmap()
	if !address.IsValid() || address.IsUnspecified() || address.IsMulticast() {
		return nil, "", errors.New("invalid host address")
	}
	allowed := false
	for _, prefix := range g.cfg.AllowedHostCIDRs {
		if prefix.Contains(address) {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, "", errors.New("host address is outside the private overlay")
	}
	host := net.JoinHostPort(address.String(), strconv.Itoa(g.cfg.HostPort))
	return &url.URL{Scheme: "http", Host: host}, host, nil
}

func (g *gateway) hostTransport(expectedAddress string, bandwidth *byteLimiter, requestContext context.Context, capabilities ...string) *http.Transport {
	capability := "unknown"
	if len(capabilities) > 0 {
		capability = safeCapability(capabilities[0])
	}
	transport := newBaseTransport()
	transport.ForceAttemptHTTP2 = false
	transport.DisableKeepAlives = true
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != expectedAddress {
			return nil, errors.New("refusing unexpected upstream address")
		}
		connection, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &limitedConn{Conn: connection, limiter: bandwidth, ctx: requestContext, telemetry: g.telemetry, capability: capability}, nil
	}
	return transport
}

func stripForwardingHeaders(header http.Header) {
	for _, name := range []string{
		"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port", "X-Real-IP",
	} {
		header.Del(name)
	}
}

func stripSensitiveHostHeaders(header http.Header) {
	for _, name := range []string{
		"Authorization", "Proxy-Authorization", "Cookie", "X-API-Key", "X-Nehemiah-Upstream", "Cf-Access-Jwt-Assertion",
	} {
		header.Del(name)
	}
	for name := range header {
		canonical := http.CanonicalHeaderKey(name)
		if strings.HasPrefix(canonical, "X-Nehemiah-") || canonical == "X-Original-Url" || canonical == "X-Rewrite-Url" {
			header.Del(name)
		}
	}
}

func stripHopByHop(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			header.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		header.Del(name)
	}
}

type tenantLimiter struct {
	mu             sync.Mutex
	entries        map[string]*tenantLimitState
	maxConnections int
	bytesPerSecond int64
	idleTTL        time.Duration
}

type tenantLimitState struct {
	active    int
	lastSeen  time.Time
	bandwidth *byteLimiter
}

func newTenantLimiter(maxConnections int, bytesPerSecond int64) *tenantLimiter {
	return &tenantLimiter{
		entries:        make(map[string]*tenantLimitState),
		maxConnections: maxConnections,
		bytesPerSecond: bytesPerSecond,
		idleTTL:        time.Hour,
	}
}

func (l *tenantLimiter) acquire(organization, project string) (func(), *byteLimiter, bool) {
	now := time.Now()
	key := organization + "\x00" + project
	l.mu.Lock()
	for existingKey, state := range l.entries {
		if state.active == 0 && now.Sub(state.lastSeen) > l.idleTTL {
			delete(l.entries, existingKey)
		}
	}
	state := l.entries[key]
	if state == nil {
		state = &tenantLimitState{bandwidth: &byteLimiter{bytesPerSecond: l.bytesPerSecond}}
		l.entries[key] = state
	}
	if state.active >= l.maxConnections {
		state.lastSeen = now
		l.mu.Unlock()
		return nil, nil, false
	}
	state.active++
	state.lastSeen = now
	l.mu.Unlock()
	released := false
	release := func() {
		l.mu.Lock()
		if !released {
			released = true
			state.active--
			state.lastSeen = time.Now()
		}
		l.mu.Unlock()
	}
	return release, state.bandwidth, true
}

// byteLimiter serializes byte reservations across every connection belonging
// to one tenant. Reads and writes share the same budget, which bounds aggregate
// ingress plus egress instead of allowing the configured rate in each direction.
type byteLimiter struct {
	mu             sync.Mutex
	bytesPerSecond int64
	next           time.Time
}

func (l *byteLimiter) wait(ctx context.Context, bytes int) error {
	if bytes <= 0 {
		return nil
	}
	now := time.Now()
	duration := time.Duration(float64(bytes) / float64(l.bytesPerSecond) * float64(time.Second))
	l.mu.Lock()
	start := now
	if l.next.After(start) {
		start = l.next
	}
	l.next = start.Add(duration)
	l.mu.Unlock()
	delay := time.Until(start)
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type limitedConn struct {
	net.Conn
	limiter    *byteLimiter
	ctx        context.Context
	telemetry  *gatewayTelemetry
	capability string
}

func (c *limitedConn) Read(buffer []byte) (int, error) {
	count, err := c.Conn.Read(buffer)
	if count > 0 {
		c.telemetry.addStreamBytes(c.ctx, c.capability, "host_to_client", count)
		if limitErr := c.limiter.wait(c.ctx, count); limitErr != nil && err == nil {
			err = limitErr
		}
	}
	return count, err
}

func (c *limitedConn) Write(buffer []byte) (int, error) {
	if err := c.limiter.wait(c.ctx, len(buffer)); err != nil {
		return 0, err
	}
	count, err := c.Conn.Write(buffer)
	if count > 0 {
		c.telemetry.addStreamBytes(c.ctx, c.capability, "client_to_host", count)
	}
	return count, err
}
