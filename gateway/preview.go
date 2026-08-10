package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var previewBootstrap = template.Must(template.New("preview-bootstrap").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening preview…</title></head>
<body><p id="status">Opening authenticated preview…</p><script nonce="{{.}}">
(async()=>{const status=document.getElementById('status');const params=new URLSearchParams(location.hash.slice(1));const token=params.get('token');history.replaceState(null,'',location.pathname+location.search);if(!token){status.textContent='A preview capability is required.';return;}try{const response=await fetch('/v1/capability/exchange',{method:'POST',headers:{authorization:'Bearer '+token},credentials:'same-origin'});if(!response.ok)throw new Error('exchange failed');location.reload();}catch(_){status.textContent='The preview capability is invalid or expired.';}})();
</script></body></html>`))

func previewCookieName(route capabilityRoute) string {
	digest := sha256.Sum256([]byte(route.publicMachineID + ":" + strconv.Itoa(route.previewPort)))
	return "nehemiah_preview_" + hex.EncodeToString(digest[:8])
}

func previewCapabilityCookie(route capabilityRoute, token string, claims capabilityClaims, secure, isolatedOrigin bool, now time.Time) *http.Cookie {
	maxAge := int(time.Until(claims.ExpiresAt).Seconds())
	if now.Before(claims.ExpiresAt) {
		maxAge = int(claims.ExpiresAt.Sub(now).Seconds())
	}
	if maxAge < 1 {
		maxAge = 1
	}
	path := "/preview/" + route.publicMachineID + "/" + strconv.Itoa(route.previewPort) + "/"
	if isolatedOrigin {
		path = "/"
	}
	return &http.Cookie{
		Name:     previewCookieName(route),
		Value:    token,
		Path:     path,
		Expires:  claims.ExpiresAt,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	}
}

func previewHostLabel(route capabilityRoute, leaseID string) string {
	digest := sha256.Sum256([]byte(route.publicMachineID + ":" + leaseID + ":" + strconv.Itoa(route.previewPort)))
	return "p-" + hex.EncodeToString(digest[:16])
}

func requestHostname(r *http.Request) string {
	host := r.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	return strings.ToLower(strings.TrimSuffix(host, "."))
}

func (g *gateway) validPreviewBootstrapHost(r *http.Request) bool {
	if g.cfg.PreviewBaseDomain == "" {
		return true
	}
	host := requestHostname(r)
	suffix := "." + g.cfg.PreviewBaseDomain
	return strings.HasSuffix(host, suffix) && len(strings.TrimSuffix(host, suffix)) == 34 && strings.HasPrefix(host, "p-")
}

func (g *gateway) validPreviewHost(r *http.Request, route capabilityRoute, leaseID string) bool {
	if g.cfg.PreviewBaseDomain == "" {
		return true
	}
	expected := previewHostLabel(route, leaseID) + "." + g.cfg.PreviewBaseDomain
	return hmac.Equal([]byte(requestHostname(r)), []byte(expected))
}

func writePreviewBootstrap(w http.ResponseWriter, r *http.Request) {
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		writeProblem(w, http.StatusInternalServerError, "bootstrap_failed", "The preview bootstrap could not be created.", requestID(r.Context()))
		return
	}
	nonce := hex.EncodeToString(nonceBytes)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; connect-src 'self'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodHead {
		return
	}
	_ = previewBootstrap.Execute(w, nonce)
}

func (g *gateway) servePreviewExchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, http.StatusMethodNotAllowed, "method_not_allowed", "Only POST is accepted.", requestID(r.Context()))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	token, _, err := requestCapabilityToken(r)
	if err != nil {
		writeProblem(w, http.StatusUnauthorized, "invalid_capability", "A valid preview capability is required.", requestID(r.Context()))
		return
	}
	claims, err := verifyCapabilityToken(token, g.cfg.CapabilitySecret, g.now())
	_, previewGranted := claims.Capabilities["preview"]
	if err != nil || !previewGranted || claims.Port == nil {
		writeProblem(w, http.StatusUnauthorized, "invalid_capability", "A valid preview capability is required.", requestID(r.Context()))
		return
	}
	route := capabilityRoute{publicMachineID: claims.Subject, capability: "preview", previewPort: *claims.Port}
	if !g.validPreviewHost(r, route, claims.LeaseID) {
		writeProblem(w, http.StatusMisdirectedRequest, "preview_origin_mismatch", "The preview capability belongs to another isolated origin.", requestID(r.Context()))
		return
	}
	streamID, streamErr := g.nextStreamID()
	if streamErr != nil {
		writeRetryableUnavailable(w, "stream_admission_unavailable", "Global stream admission is unavailable.", requestID(r.Context()))
		return
	}
	lookup := capabilityRouteLookup(route, claims)
	lookup.StreamID = streamID
	lookup.StreamInstance = g.streamInstanceID
	lookup.StreamBandwidth = streamBandwidthReservation(g.cfg)
	lookupContext, cancel := context.WithTimeout(r.Context(), g.cfg.ControlPlaneTimeout)
	resolved, resolveErr := g.resolver.Resolve(lookupContext, lookup)
	cancel()
	if resolveErr == nil {
		defer g.releaseStream(streamID)
	}
	if resolveErr != nil || !resolved.ExpiresAt.After(g.now()) {
		status := http.StatusBadGateway
		code := "route_lookup_failed"
		if errors.Is(resolveErr, errRouteNotFound) || errors.Is(resolveErr, errRouteExpired) || !resolved.ExpiresAt.After(g.now()) {
			status = http.StatusNotFound
			code = "machine_route_not_found"
		} else if errors.Is(resolveErr, errStreamLimit) {
			status = http.StatusTooManyRequests
			code = "stream_quota_exceeded"
			w.Header().Set("Retry-After", "1")
		}
		writeProblem(w, status, code, "No live route exists for this machine.", requestID(r.Context()))
		return
	}
	if !boundedClaim(resolved.LeaseID) || !boundedClaim(resolved.Organization) ||
		!boundedClaim(resolved.Project) || !routeIdentityMatches(claims, resolved) ||
		resolved.StreamID != streamID || resolved.StreamBandwidth != lookup.StreamBandwidth ||
		!resolved.StreamExpiresAt.After(g.now()) {
		writeProblem(w, http.StatusUnauthorized, "capability_scope_mismatch", "The capability does not belong to the current machine route.", requestID(r.Context()))
		return
	}
	http.SetCookie(w, previewCapabilityCookie(route, token, claims, g.cfg.SecurePreviewCookies, g.cfg.PreviewBaseDomain != "", g.now()))
	w.WriteHeader(http.StatusNoContent)
}

func parsePreviewRoute(path string) (capabilityRoute, bool) {
	if !strings.HasPrefix(path, "/preview/") {
		return capabilityRoute{}, false
	}
	remainder := strings.TrimPrefix(path, "/preview/")
	parts := strings.SplitN(remainder, "/", 3)
	if len(parts) < 2 || !validPublicMachineID(parts[0]) {
		return capabilityRoute{}, true
	}
	port, err := strconv.Atoi(parts[1])
	if err != nil || port < 1 || port > 65535 {
		return capabilityRoute{}, true
	}
	tail := ""
	if len(parts) == 3 {
		tail = parts[2]
	}
	for _, segment := range strings.Split(tail, "/") {
		if segment == "." || segment == ".." {
			return capabilityRoute{}, true
		}
	}
	return capabilityRoute{
		publicMachineID: parts[0],
		capability:      "preview",
		previewPort:     port,
		previewTail:     tail,
	}, false
}

// rewritePreviewLocation keeps same-service redirects inside the capability
// route. The capability itself is deliberately never copied into Location.
func rewritePreviewLocation(response *http.Response, route capabilityRoute, _ string) {
	value := response.Header.Get("Location")
	if value == "" {
		return
	}
	location, err := url.Parse(value)
	if err != nil || location.IsAbs() || location.Host != "" || !strings.HasPrefix(location.Path, "/") {
		return
	}
	location.Path = "/preview/" + route.publicMachineID + "/" + strconv.Itoa(route.previewPort) + location.Path
	location.RawPath = ""
	response.Header.Set("Location", location.String())
}
