package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	publicMachineIDPattern = regexp.MustCompile(`^m_[A-Za-z0-9_-]{1,126}$`)
	localMachineIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

type gateway struct {
	cfg               Config
	now               func() time.Time
	streamIDGenerator func() (string, error)
	resolver          routeResolver
	controlProxy      *httputil.ReverseProxy
	limits            *tenantLimiter
	restLimits        *restRateLimiter
	restActive        *restActiveLimiter
	readiness         *readinessCache
	streams           *streamDrainer
	telemetry         *gatewayTelemetry
	streamInstanceID  string
}

type capabilityRoute struct {
	publicMachineID string
	capability      string
	action          string
	previewPort     int
	previewTail     string
}

func capabilityRouteLookup(route capabilityRoute, claims capabilityClaims) routeLookup {
	capabilities := make([]string, 0, len(claims.Capabilities))
	for _, capability := range gatewayCapabilityOrder {
		if _, ok := claims.Capabilities[capability]; ok {
			capabilities = append(capabilities, capability)
		}
	}
	lookup := routeLookup{
		PublicMachineID: route.publicMachineID,
		Capability:      route.capability,
		CapabilityID:    claims.JWTID,
		Capabilities:    capabilities,
		Organization:    claims.Organization,
		Project:         claims.Project,
		LeaseID:         claims.LeaseID,
		PreviewPort:     claims.Port,
		ExpiresAt:       claims.ExpiresAt,
	}
	return lookup
}

type streamRouteReleaser interface {
	Release(context.Context, string, string) error
}

func newStreamID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func (g *gateway) nextStreamID() (string, error) {
	if g.streamIDGenerator == nil {
		return newStreamID()
	}
	return g.streamIDGenerator()
}

func streamBandwidthReservation(cfg Config) int64 {
	connections := int64(cfg.MaxConnectionsPerTenant)
	return (cfg.TenantBytesPerSecond + connections - 1) / connections
}

func (g *gateway) releaseStream(streamID string) {
	releaser, ok := g.resolver.(streamRouteReleaser)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = releaser.Release(ctx, streamID, g.streamInstanceID)
}

// Hash first so comparisons take fixed-size inputs even for malformed or
// attacker-controlled claims. Callers evaluate every tenant/lease comparison
// before branching, avoiding a field-by-field scope oracle.
func equalIdentityClaim(left, right string) bool {
	leftHash := sha256.Sum256([]byte(left))
	rightHash := sha256.Sum256([]byte(right))
	return hmac.Equal(leftHash[:], rightHash[:])
}

func routeIdentityMatches(claims capabilityClaims, route machineRoute) bool {
	organizationMatches := equalIdentityClaim(claims.Organization, route.Organization)
	projectMatches := equalIdentityClaim(claims.Project, route.Project)
	leaseMatches := equalIdentityClaim(claims.LeaseID, route.LeaseID)
	capabilityIDMatches := equalIdentityClaim(claims.JWTID, route.CapabilityID)
	expectedCapabilities := make([]string, 0, len(claims.Capabilities))
	for _, capability := range gatewayCapabilityOrder {
		if _, ok := claims.Capabilities[capability]; ok {
			expectedCapabilities = append(expectedCapabilities, capability)
		}
	}
	capabilitiesMatch := len(expectedCapabilities) == len(route.Capabilities)
	for index, capability := range expectedCapabilities {
		if index >= len(route.Capabilities) || capability != route.Capabilities[index] {
			capabilitiesMatch = false
		}
	}
	portMatches := (claims.Port == nil) == (route.CapabilityPort == nil)
	if claims.Port != nil && route.CapabilityPort != nil && *claims.Port != *route.CapabilityPort {
		portMatches = false
	}
	expiryMatches := claims.ExpiresAt.Equal(route.CapabilityExpiresAt)
	return organizationMatches && projectMatches && leaseMatches && capabilityIDMatches &&
		capabilitiesMatch && portMatches && expiryMatches && !route.ExpiresAt.After(claims.ExpiresAt)
}

func (g *gateway) revalidateStream(
	ctx context.Context,
	cancel context.CancelFunc,
	lookup routeLookup,
	claims capabilityClaims,
	leaseUpdates chan<- time.Time,
) {
	ticker := time.NewTicker(g.cfg.CapabilityRevalidationInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			timeout := g.cfg.ControlPlaneTimeout
			if timeout > g.cfg.CapabilityRevalidationInterval {
				timeout = g.cfg.CapabilityRevalidationInterval
			}
			lookupContext, cancelLookup := context.WithTimeout(ctx, timeout)
			resolved, err := g.resolver.Resolve(lookupContext, lookup)
			cancelLookup()
			if err != nil || !resolved.ExpiresAt.After(g.now()) ||
				resolved.StreamID != lookup.StreamID || resolved.StreamBandwidth != lookup.StreamBandwidth ||
				!routeIdentityMatches(claims, resolved) {
				cancel()
				return
			}
			select {
			case leaseUpdates <- resolved.StreamExpiresAt:
			case <-ctx.Done():
				return
			}
		}
	}
}

func (g *gateway) enforceStreamLease(
	ctx context.Context,
	cancel context.CancelFunc,
	initialExpiry time.Time,
	leaseUpdates <-chan time.Time,
) {
	delay := initialExpiry.Sub(g.now())
	if delay <= 0 {
		cancel()
		return
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cancel()
			return
		case expiry := <-leaseUpdates:
			delay = expiry.Sub(g.now())
			if delay <= 0 {
				cancel()
				return
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(delay)
		}
	}
}

func newGateway(cfg Config, runtimes ...*gatewayTelemetry) (*gateway, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	target, err := url.Parse(cfg.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	transport, err := newControlPlaneTransport(cfg)
	if err != nil {
		return nil, err
	}
	telemetry := &gatewayTelemetry{}
	if len(runtimes) > 0 && runtimes[0] != nil {
		telemetry = runtimes[0]
	}
	resolver, err := newControlPlaneResolver(cfg, transport, telemetry)
	if err != nil {
		return nil, err
	}
	instanceID := cfg.Telemetry.InstanceID
	if instanceID == "" {
		generated, generateErr := newStreamID()
		if generateErr != nil {
			return nil, fmt.Errorf("generate gateway stream instance identity: %w", generateErr)
		}
		instanceID = "gateway-" + strings.ReplaceAll(generated, "-", "")
	}
	return &gateway{
		cfg:               cfg,
		now:               time.Now,
		streamIDGenerator: newStreamID,
		resolver:          resolver,
		controlProxy:      newControlPlaneProxy(target, transport, cfg, telemetry),
		limits:            newTenantLimiter(cfg.MaxConnectionsPerTenant, cfg.TenantBytesPerSecond),
		restLimits:        newRESTRateLimiter(cfg.RESTRequestsPerWindow, cfg.RESTLimiterSlots, cfg.RESTWindow),
		restActive:        newRESTActiveLimiter(cfg.RESTMaxActive, cfg.RESTMaxActivePerSource),
		readiness:         &readinessCache{},
		streams:           newStreamDrainer(),
		telemetry:         telemetry,
		streamInstanceID:  instanceID,
	}, nil
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Any response that can be produced before a framed request body is read
	// must not make net/http drain attacker-controlled bytes afterward. Closing
	// HTTP/1.x body-bearing connections is conservative for legitimate POSTs,
	// while bounded proxy/body admission still governs their actual processing.
	if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		w.Header().Set("Connection", "close")
	}
	if r.URL.IsAbs() || r.URL.Host != "" {
		writeProblem(w, http.StatusBadRequest, "invalid_request_target", "Absolute request targets are not accepted.", requestID(r.Context()))
		return
	}
	if r.URL.Path == "/healthz" {
		// Liveness is deliberately DB-free and exempt from the ordinary REST
		// admission path, so it must also be incapable of retaining a request
		// body. Check framing before the method so even an invalid method cannot
		// make net/http drain an incomplete attacker-controlled chunk stream.
		if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
			w.Header().Set("Connection", "close")
			writeProblem(w, http.StatusBadRequest, "request_body_not_allowed", "Liveness requests cannot contain a body.", requestID(r.Context()))
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeProblem(w, http.StatusMethodNotAllowed, "method_not_allowed", "Only GET and HEAD are accepted.", requestID(r.Context()))
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
		return
	}
	if g.streams.isDraining() {
		writeRetryableUnavailable(w, "gateway_draining", "The gateway is draining active connections.", requestID(r.Context()))
		return
	}
	if r.ContentLength > g.cfg.MaxRequestBytes {
		writeProblem(w, http.StatusRequestEntityTooLarge, "request_too_large", "The request body is too large.", requestID(r.Context()))
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, g.cfg.MaxRequestBytes)
	}
	address, addressOK := g.publicClientAddress(r)
	if allowed, retry := g.restLimits.allow(coarseAddress(address, addressOK), g.now()); !allowed {
		retrySeconds := int((retry + time.Second - 1) / time.Second)
		if retrySeconds < 1 {
			retrySeconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retrySeconds))
		writeProblem(w, http.StatusTooManyRequests, "rate_limit_exceeded", "The gateway request rate limit has been reached.", requestID(r.Context()))
		return
	}
	if r.URL.Path == "/v1/capability/exchange" {
		g.servePreviewExchange(w, r)
		return
	}
	// Internal control-plane endpoints belong to the private host/control-plane
	// trust boundary. Never make them reachable through the public gateway,
	// even though the control plane also authenticates them independently.
	if r.URL.Path == "/internal" || strings.HasPrefix(r.URL.Path, "/internal/") {
		writeProblem(w, http.StatusNotFound, "not_found", "The requested resource was not found.", requestID(r.Context()))
		return
	}
	if route, malformed := parsePreviewRoute(r.URL.Path); malformed {
		writeProblem(w, http.StatusBadRequest, "invalid_preview_route", "The preview machine or port is invalid.", requestID(r.Context()))
		return
	} else if route.capability != "" {
		if !g.validPreviewBootstrapHost(r) {
			writeProblem(w, http.StatusMisdirectedRequest, "preview_origin_mismatch", "Use the isolated preview origin issued for this session.", requestID(r.Context()))
			return
		}
		g.serveCapability(w, r, route)
		return
	}
	if route, ok := parseMachineCapabilityRoute(r.URL.Path); ok {
		g.serveCapability(w, r, route)
		return
	}
	g.serveControlPlaneREST(w, withPublicClientAddress(r, address, addressOK), coarseAddress(address, addressOK))
}

func (g *gateway) serveControlPlaneREST(w http.ResponseWriter, request *http.Request, source string) {
	release, ok := g.restActive.acquire(source)
	if !ok {
		w.Header().Set("Connection", "close")
		w.Header().Set("Retry-After", "1")
		writeProblem(w, http.StatusTooManyRequests, "active_request_limit", "The gateway active request limit has been reached.", requestID(request.Context()))
		return
	}
	defer release()
	requestContext, cancel := context.WithTimeout(request.Context(), g.cfg.RESTMaxDuration)
	defer cancel()
	request = request.WithContext(requestContext)
	request, clearBodyDeadline := applyRESTBodyDeadline(w, request, g.cfg.RESTBodyTimeout)
	defer clearBodyDeadline()
	if request.URL.Path == "/readyz" && (request.Method == http.MethodGet || request.Method == http.MethodHead) {
		g.serveReadiness(w, request)
		return
	}
	g.controlProxy.ServeHTTP(w, request)
}

func parseMachineCapabilityRoute(path string) (capabilityRoute, bool) {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) != 4 || parts[0] != "v1" || parts[1] != "machines" || !validPublicMachineID(parts[2]) {
		return capabilityRoute{}, false
	}
	capability := ""
	switch parts[3] {
	case "tty":
		capability = "tty"
	case "vnc":
		capability = "vnc"
	case "agent", "shell-agent":
		capability = "agent"
	case "upload", "download":
		capability = "files"
	default:
		return capabilityRoute{}, false
	}
	return capabilityRoute{publicMachineID: parts[2], capability: capability, action: parts[3]}, true
}

func (g *gateway) serveCapability(w http.ResponseWriter, r *http.Request, route capabilityRoute) {
	if !route.methodAllowed(r.Method) {
		w.Header().Set("Allow", route.allowedMethods())
		writeProblem(w, http.StatusMethodNotAllowed, "method_not_allowed", "The method is not valid for this capability.", requestID(r.Context()))
		return
	}
	if route.requiresWebSocket() && !isWebSocketUpgrade(r) {
		w.Header().Set("Upgrade", "websocket")
		writeProblem(w, http.StatusUpgradeRequired, "websocket_required", "This endpoint requires a WebSocket upgrade.", requestID(r.Context()))
		return
	}
	if r.ContentLength > g.cfg.MaxRequestBytes {
		writeProblem(w, http.StatusRequestEntityTooLarge, "request_too_large", "The request body is too large.", requestID(r.Context()))
		return
	}
	token, tokenViaSubprotocol, err := requestCapabilityToken(r)
	explicitToken := err == nil
	if errors.Is(err, errCapabilityRequired) && route.capability == "preview" {
		if cookie, cookieErr := r.Cookie(previewCookieName(route)); cookieErr == nil {
			token, err = cookie.Value, nil
		} else if r.Method == http.MethodGet || r.Method == http.MethodHead {
			writePreviewBootstrap(w, r)
			return
		}
	}
	if err != nil {
		writeProblem(w, http.StatusUnauthorized, "invalid_capability", "A valid capability token is required.", requestID(r.Context()))
		return
	}
	claims, err := verifyCapabilityToken(token, g.cfg.CapabilitySecret, g.now())
	if err != nil || claims.Subject != route.publicMachineID {
		writeProblem(w, http.StatusUnauthorized, "invalid_capability", "A valid capability token is required.", requestID(r.Context()))
		return
	}
	if _, ok := claims.Capabilities[route.capability]; !ok {
		writeProblem(w, http.StatusForbidden, "insufficient_capability", "The token does not grant this capability.", requestID(r.Context()))
		return
	}
	if route.capability == "preview" {
		if claims.Port == nil || *claims.Port != route.previewPort {
			writeProblem(w, http.StatusForbidden, "preview_port_denied", "The token does not grant this preview port.", requestID(r.Context()))
			return
		}
		if !g.validPreviewHost(r, route, claims.LeaseID) {
			writeProblem(w, http.StatusMisdirectedRequest, "preview_origin_mismatch", "The preview capability belongs to another isolated origin.", requestID(r.Context()))
			return
		}
	}
	streamID, err := g.nextStreamID()
	if err != nil {
		writeRetryableUnavailable(w, "stream_admission_unavailable", "Global stream admission is unavailable.", requestID(r.Context()))
		return
	}
	lookup := capabilityRouteLookup(route, claims)
	lookup.StreamID = streamID
	lookup.StreamInstance = g.streamInstanceID
	lookup.StreamBandwidth = streamBandwidthReservation(g.cfg)
	lookupContext, cancelLookup := context.WithTimeout(r.Context(), g.cfg.ControlPlaneTimeout)
	resolved, err := g.resolver.Resolve(lookupContext, lookup)
	cancelLookup()
	if err != nil {
		switch {
		case errors.Is(err, errRouteNotFound), errors.Is(err, errRouteExpired):
			writeProblem(w, http.StatusNotFound, "machine_route_not_found", "No live route exists for this machine.", requestID(r.Context()))
		case errors.Is(err, errStreamLimit):
			w.Header().Set("Retry-After", "1")
			writeProblem(w, http.StatusTooManyRequests, "stream_quota_exceeded", "The organization or project stream quota is exhausted.", requestID(r.Context()))
		default:
			writeProblem(w, http.StatusBadGateway, "route_lookup_failed", "The machine route could not be resolved.", requestID(r.Context()))
		}
		return
	}
	defer g.releaseStream(streamID)
	if !resolved.ExpiresAt.After(g.now()) {
		writeProblem(w, http.StatusNotFound, "machine_route_not_found", "No live route exists for this machine.", requestID(r.Context()))
		return
	}
	if !validLocalMachineID(resolved.HostMachineID) || !boundedClaim(resolved.LeaseID) ||
		!boundedClaim(resolved.Organization) || !boundedClaim(resolved.Project) {
		writeProblem(w, http.StatusBadGateway, "invalid_machine_route", "The machine route is invalid.", requestID(r.Context()))
		return
	}
	if !routeIdentityMatches(claims, resolved) {
		writeProblem(w, http.StatusUnauthorized, "capability_scope_mismatch", "The capability does not belong to the current machine route.", requestID(r.Context()))
		return
	}
	if resolved.StreamID != streamID || resolved.StreamBandwidth != lookup.StreamBandwidth ||
		!resolved.StreamExpiresAt.After(g.now()) {
		writeProblem(w, http.StatusBadGateway, "invalid_machine_route", "The stream admission lease is invalid.", requestID(r.Context()))
		return
	}
	trackedContext, finishTrackedStream, accepted := g.streams.begin(r.Context())
	if !accepted {
		writeRetryableUnavailable(w, "gateway_draining", "The gateway is draining active connections.", requestID(r.Context()))
		return
	}
	defer finishTrackedStream()
	r = r.WithContext(trackedContext)
	release, _, ok := g.limits.acquire(claims.Organization, claims.Project)
	if !ok {
		w.Header().Set("Retry-After", "1")
		writeProblem(w, http.StatusTooManyRequests, "connection_limit", "The tenant connection limit has been reached.", requestID(r.Context()))
		return
	}
	defer release()
	bandwidth := &byteLimiter{bytesPerSecond: resolved.StreamBandwidth}
	finishStreamTelemetry := g.telemetry.streamStarted(r.Context(), route.capability)
	defer finishStreamTelemetry()
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, g.cfg.MaxRequestBytes)
	}
	deadline := g.now().Add(g.cfg.StreamMaxDuration)
	if claims.ExpiresAt.Before(deadline) {
		deadline = claims.ExpiresAt
	}
	if resolved.ExpiresAt.Before(deadline) {
		deadline = resolved.ExpiresAt
	}
	streamContext, cancelStream := context.WithDeadline(r.Context(), deadline)
	defer cancelStream()
	leaseUpdates := make(chan time.Time)
	go g.enforceStreamLease(streamContext, cancelStream, resolved.StreamExpiresAt, leaseUpdates)
	go g.revalidateStream(
		streamContext,
		cancelStream,
		lookup,
		claims,
		leaseUpdates,
	)
	var capabilityCookie *http.Cookie
	if route.capability == "preview" && explicitToken {
		capabilityCookie = previewCapabilityCookie(route, token, claims, g.cfg.SecurePreviewCookies, g.cfg.PreviewBaseDomain != "", g.now())
	}
	// Echo the capability subprotocol on the 101 only when the client actually
	// offered it that way (browser TTY/VNC clients do; header-bearer clients do
	// not). RFC 6455 requires the selected subprotocol to be one the client
	// offered, and browsers fail the handshake when none is selected.
	echoSubprotocol := tokenViaSubprotocol && route.requiresWebSocket()
	g.proxyToHost(w, r.WithContext(streamContext), route, resolved, bandwidth, capabilityCookie, token, echoSubprotocol)
}

func (r capabilityRoute) methodAllowed(method string) bool {
	if r.capability == "preview" {
		return method != http.MethodConnect && method != http.MethodTrace
	}
	switch r.action {
	case "upload":
		return method == http.MethodPost
	case "download":
		return method == http.MethodGet || method == http.MethodHead
	default:
		return method == http.MethodGet
	}
}

func (r capabilityRoute) allowedMethods() string {
	if r.capability == "preview" {
		return "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
	}
	if r.action == "upload" {
		return "POST"
	}
	if r.action == "download" {
		return "GET, HEAD"
	}
	return "GET"
}

func (r capabilityRoute) requiresWebSocket() bool {
	return r.capability == "tty" || r.capability == "vnc" || r.capability == "agent"
}

func (r capabilityRoute) upstreamPath(localMachineID string) string {
	id := url.PathEscape(localMachineID)
	if r.capability == "preview" {
		return "/v1/machines/" + id + "/web/" + strconv.Itoa(r.previewPort) + "/" + r.previewTail
	}
	return "/v1/machines/" + id + "/" + r.action
}

func validPublicMachineID(value string) bool { return publicMachineIDPattern.MatchString(value) }
func validLocalMachineID(value string) bool  { return localMachineIDPattern.MatchString(value) }

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") &&
		headerContainsToken(r.Header.Values("Connection"), "upgrade")
}

func headerContainsToken(values []string, wanted string) bool {
	for _, value := range values {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), wanted) {
				return true
			}
		}
	}
	return false
}

type problemBody struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail"`
	RequestID string `json:"request_id,omitempty"`
}

func writeProblem(w http.ResponseWriter, status int, code, detail, id string) {
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problemBody{
		Type:      fmt.Sprintf("https://docs.boringcomputers.com/problems/%s", code),
		Title:     code,
		Status:    status,
		Detail:    detail,
		RequestID: id,
	})
}

func writeRetryableUnavailable(w http.ResponseWriter, code, detail, id string) {
	w.Header().Set("Retry-After", "1")
	writeProblem(w, http.StatusServiceUnavailable, code, detail, id)
}

func handler(cfg Config, logger *slog.Logger, runtimes ...*gatewayTelemetry) (http.Handler, error) {
	telemetry := &gatewayTelemetry{}
	if len(runtimes) > 0 && runtimes[0] != nil {
		telemetry = runtimes[0]
	}
	gateway, err := newGateway(cfg, telemetry)
	if err != nil {
		return nil, err
	}
	return withRequestTelemetry(logger, gateway, telemetry), nil
}
