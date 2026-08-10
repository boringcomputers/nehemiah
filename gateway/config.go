package main

import (
	"crypto/hmac"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultAllowedHostCIDRs = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fd00::/8"

// Config contains the gateway's fixed trust anchors and resource limits. In
// particular, neither the control-plane URL nor the host port is caller
// selectable.
type Config struct {
	Production                     bool
	Addr                           string
	ControlPlaneURL                string
	ControlPlaneCAFile             string
	ControlPlaneServerName         string
	GatewayToken                   string
	CapabilitySecret               string
	PreviewBaseDomain              string
	TrustedSiteDomain              string
	HostPort                       int
	AllowedHostCIDRs               []netip.Prefix
	ControlPlaneTimeout            time.Duration
	CapabilityRevalidationInterval time.Duration
	StreamMaxDuration              time.Duration
	ShutdownGrace                  time.Duration
	MaxRequestBytes                int64
	MaxConnectionsPerTenant        int
	TenantBytesPerSecond           int64
	RESTRequestsPerWindow          int
	RESTWindow                     time.Duration
	RESTLimiterSlots               int
	RESTMaxActive                  int
	RESTMaxActivePerSource         int
	RESTBodyTimeout                time.Duration
	RESTMaxDuration                time.Duration
	TrustedEdgeCIDRs               []netip.Prefix
	TrustedEdgeIPHeader            string
	SecurePreviewCookies           bool
	Telemetry                      TelemetryConfig
}

func LoadConfig() (Config, error) {
	gatewayToken := envString("NEHEMIAH_GATEWAY_TOKEN", "dev-gateway-token")
	cfg := Config{
		Production:             os.Getenv("NEHEMIAH_ENV") == "production" || os.Getenv("NODE_ENV") == "production",
		Addr:                   envString("NEHEMIAH_GATEWAY_ADDR", "0.0.0.0:8082"),
		ControlPlaneURL:        envString("NEHEMIAH_CONTROL_PLANE_URL", "http://127.0.0.1:8081"),
		ControlPlaneCAFile:     strings.TrimSpace(os.Getenv("NEHEMIAH_CONTROL_PLANE_CA_FILE")),
		ControlPlaneServerName: strings.TrimSpace(os.Getenv("NEHEMIAH_CONTROL_PLANE_SERVER_NAME")),
		GatewayToken:           gatewayToken,
		CapabilitySecret:       envString("NEHEMIAH_GATEWAY_SECRET", "dev-gateway-secret"),
		PreviewBaseDomain:      strings.ToLower(strings.TrimSpace(os.Getenv("NEHEMIAH_PREVIEW_BASE_DOMAIN"))),
		TrustedSiteDomain:      strings.ToLower(strings.TrimSpace(os.Getenv("NEHEMIAH_TRUSTED_SITE_DOMAIN"))),
		HostPort:               envInt("NEHEMIAH_HOST_PORT", 8080),
		ControlPlaneTimeout:    envDuration("NEHEMIAH_GATEWAY_CONTROL_TIMEOUT", 10*time.Second),
		CapabilityRevalidationInterval: envDuration(
			"NEHEMIAH_GATEWAY_CAPABILITY_REVALIDATION_INTERVAL",
			5*time.Second,
		),
		StreamMaxDuration:       envDuration("NEHEMIAH_GATEWAY_STREAM_MAX_DURATION", time.Hour),
		ShutdownGrace:           envDuration("NEHEMIAH_GATEWAY_SHUTDOWN_GRACE", 30*time.Second),
		MaxRequestBytes:         envInt64("NEHEMIAH_GATEWAY_MAX_REQUEST_BYTES", 64<<20),
		MaxConnectionsPerTenant: envInt("NEHEMIAH_GATEWAY_TENANT_CONNECTIONS", 32),
		TenantBytesPerSecond:    envInt64("NEHEMIAH_GATEWAY_TENANT_BYTES_PER_SECOND", 8<<20),
		RESTRequestsPerWindow:   envInt("NEHEMIAH_GATEWAY_REST_REQUESTS_PER_WINDOW", 600),
		RESTWindow:              envDuration("NEHEMIAH_GATEWAY_REST_WINDOW", time.Minute),
		RESTLimiterSlots:        envInt("NEHEMIAH_GATEWAY_REST_LIMITER_SLOTS", 65_536),
		RESTMaxActive:           envInt("NEHEMIAH_GATEWAY_REST_MAX_ACTIVE", 256),
		RESTMaxActivePerSource:  envInt("NEHEMIAH_GATEWAY_REST_MAX_ACTIVE_PER_SOURCE", 16),
		RESTBodyTimeout:         envDuration("NEHEMIAH_GATEWAY_REST_BODY_TIMEOUT", 15*time.Second),
		RESTMaxDuration:         envDuration("NEHEMIAH_GATEWAY_REST_MAX_DURATION", 150*time.Second),
		TrustedEdgeIPHeader:     envString("NEHEMIAH_GATEWAY_TRUSTED_EDGE_IP_HEADER", "CF-Connecting-IP"),
		SecurePreviewCookies:    os.Getenv("NEHEMIAH_GATEWAY_INSECURE_PREVIEW_COOKIES") != "1",
	}
	telemetry, err := loadTelemetryConfig(os.LookupEnv)
	if err != nil {
		return Config{}, err
	}
	cfg.Telemetry = telemetry
	prefixes, err := parsePrefixes(envString("NEHEMIAH_GATEWAY_ALLOWED_HOST_CIDRS", defaultAllowedHostCIDRs))
	if err != nil {
		return Config{}, fmt.Errorf("NEHEMIAH_GATEWAY_ALLOWED_HOST_CIDRS: %w", err)
	}
	cfg.AllowedHostCIDRs = prefixes
	if raw := strings.TrimSpace(os.Getenv("NEHEMIAH_GATEWAY_TRUSTED_EDGE_CIDRS")); raw != "" {
		cfg.TrustedEdgeCIDRs, err = parsePrefixes(raw)
		if err != nil {
			return Config{}, fmt.Errorf("NEHEMIAH_GATEWAY_TRUSTED_EDGE_CIDRS: %w", err)
		}
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if _, _, err := net.SplitHostPort(c.Addr); err != nil {
		return fmt.Errorf("NEHEMIAH_GATEWAY_ADDR must be host:port: %w", err)
	}
	target, err := url.Parse(c.ControlPlaneURL)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return errors.New("NEHEMIAH_CONTROL_PLANE_URL must be an absolute http(s) URL")
	}
	if target.User != nil || target.RawQuery != "" || target.Fragment != "" || (target.Path != "" && target.Path != "/") {
		return errors.New("NEHEMIAH_CONTROL_PLANE_URL must not contain credentials, a path, query, or fragment")
	}
	if c.Production && target.Scheme != "https" {
		return errors.New("NEHEMIAH_CONTROL_PLANE_URL must use HTTPS in production")
	}
	if target.Scheme != "https" && (c.ControlPlaneCAFile != "" || c.ControlPlaneServerName != "") {
		return errors.New("control-plane TLS settings require an HTTPS control-plane URL")
	}
	if c.ControlPlaneServerName != "" && (net.ParseIP(c.ControlPlaneServerName) != nil || !validDNSName(strings.ToLower(c.ControlPlaneServerName))) {
		return errors.New("NEHEMIAH_CONTROL_PLANE_SERVER_NAME must be a DNS name")
	}
	if strings.TrimSpace(c.GatewayToken) == "" {
		return errors.New("NEHEMIAH_GATEWAY_TOKEN must not be empty")
	}
	if strings.TrimSpace(c.CapabilitySecret) == "" {
		return errors.New("NEHEMIAH_GATEWAY_SECRET must not be empty")
	}
	if c.Production {
		if len(c.GatewayToken) < 32 {
			return errors.New("NEHEMIAH_GATEWAY_TOKEN must contain at least 32 characters in production")
		}
		if len(c.CapabilitySecret) < 32 {
			return errors.New("NEHEMIAH_GATEWAY_SECRET must contain at least 32 characters in production")
		}
		if hmac.Equal([]byte(c.GatewayToken), []byte(c.CapabilitySecret)) {
			return errors.New("NEHEMIAH_GATEWAY_TOKEN and NEHEMIAH_GATEWAY_SECRET must be distinct")
		}
		if c.PreviewBaseDomain == "" {
			return errors.New("NEHEMIAH_PREVIEW_BASE_DOMAIN is required in production")
		}
		if c.TrustedSiteDomain == "" {
			return errors.New("NEHEMIAH_TRUSTED_SITE_DOMAIN is required in production")
		}
		if !c.SecurePreviewCookies {
			return errors.New("NEHEMIAH_GATEWAY_INSECURE_PREVIEW_COOKIES cannot be set in production")
		}
	}
	if c.PreviewBaseDomain != "" {
		if net.ParseIP(c.PreviewBaseDomain) != nil || !validDNSName(c.PreviewBaseDomain) || !strings.Contains(c.PreviewBaseDomain, ".") {
			return errors.New("NEHEMIAH_PREVIEW_BASE_DOMAIN must be a dedicated DNS base domain")
		}
	}
	if c.TrustedSiteDomain != "" && (!validDNSName(c.TrustedSiteDomain) || !strings.Contains(c.TrustedSiteDomain, ".")) {
		return errors.New("NEHEMIAH_TRUSTED_SITE_DOMAIN must be the dashboard/API registrable domain")
	}
	if c.PreviewBaseDomain != "" && c.TrustedSiteDomain != "" &&
		(c.PreviewBaseDomain == c.TrustedSiteDomain || strings.HasSuffix(c.PreviewBaseDomain, "."+c.TrustedSiteDomain) || strings.HasSuffix(c.TrustedSiteDomain, "."+c.PreviewBaseDomain) || siteBoundarySuffix(c.PreviewBaseDomain) == siteBoundarySuffix(c.TrustedSiteDomain)) {
		return errors.New("preview and trusted application traffic must use different registrable domains")
	}
	if c.HostPort < 1 || c.HostPort > 65535 {
		return errors.New("NEHEMIAH_HOST_PORT must be between 1 and 65535")
	}
	if len(c.AllowedHostCIDRs) == 0 {
		return errors.New("at least one private host CIDR is required")
	}
	if c.ControlPlaneTimeout <= 0 || c.StreamMaxDuration <= 0 {
		return errors.New("gateway timeouts must be positive")
	}
	if c.CapabilityRevalidationInterval < 250*time.Millisecond || c.CapabilityRevalidationInterval > 5*time.Second {
		return errors.New("NEHEMIAH_GATEWAY_CAPABILITY_REVALIDATION_INTERVAL must be between 250ms and 5s")
	}
	if c.ShutdownGrace < time.Second || c.ShutdownGrace > 10*time.Minute {
		return errors.New("NEHEMIAH_GATEWAY_SHUTDOWN_GRACE must be between 1s and 10m")
	}
	if c.MaxRequestBytes <= 0 || c.MaxConnectionsPerTenant < 1 || c.MaxConnectionsPerTenant > 10_000 ||
		c.TenantBytesPerSecond < 1 || c.TenantBytesPerSecond > 1<<40 ||
		streamBandwidthReservation(c) > 1<<30 {
		return errors.New("gateway request, connection, and bandwidth limits are outside their safe bounds")
	}
	if c.RESTRequestsPerWindow < 1 || c.RESTRequestsPerWindow > 1_000_000 {
		return errors.New("NEHEMIAH_GATEWAY_REST_REQUESTS_PER_WINDOW must be between 1 and 1000000")
	}
	if c.RESTWindow < time.Second || c.RESTWindow > time.Hour {
		return errors.New("NEHEMIAH_GATEWAY_REST_WINDOW must be between 1s and 1h")
	}
	if c.RESTLimiterSlots < 1_024 || c.RESTLimiterSlots > 1_048_576 || c.RESTLimiterSlots&(c.RESTLimiterSlots-1) != 0 {
		return errors.New("NEHEMIAH_GATEWAY_REST_LIMITER_SLOTS must be a power of two between 1024 and 1048576")
	}
	if c.RESTMaxActive < 1 || c.RESTMaxActive > 10_000 {
		return errors.New("NEHEMIAH_GATEWAY_REST_MAX_ACTIVE must be between 1 and 10000")
	}
	if c.RESTMaxActivePerSource < 1 || c.RESTMaxActivePerSource > c.RESTMaxActive {
		return errors.New("NEHEMIAH_GATEWAY_REST_MAX_ACTIVE_PER_SOURCE must be between 1 and REST_MAX_ACTIVE")
	}
	if c.RESTBodyTimeout < time.Second || c.RESTBodyTimeout > time.Minute {
		return errors.New("NEHEMIAH_GATEWAY_REST_BODY_TIMEOUT must be between 1s and 1m")
	}
	if c.RESTMaxDuration < 2*time.Minute || c.RESTMaxDuration > 10*time.Minute || c.RESTMaxDuration <= c.RESTBodyTimeout {
		return errors.New("NEHEMIAH_GATEWAY_REST_MAX_DURATION must be between 2m and 10m and exceed the body timeout")
	}
	if !trustedEdgeAddressHeader(c.TrustedEdgeIPHeader) {
		return errors.New("NEHEMIAH_GATEWAY_TRUSTED_EDGE_IP_HEADER must be CF-Connecting-IP, True-Client-IP, or X-Real-IP")
	}
	if err := c.Telemetry.Validate(c.Production, c.GatewayToken, c.CapabilitySecret); err != nil {
		return err
	}
	return nil
}

func validHeaderName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

func trustedEdgeAddressHeader(value string) bool {
	if !validHeaderName(value) {
		return false
	}
	switch http.CanonicalHeaderKey(value) {
	case "Cf-Connecting-Ip", "True-Client-Ip", "X-Real-Ip":
		return true
	default:
		return false
	}
}

// Be conservatively stricter than an eTLD+1 lookup: different preview and
// trusted sites must not even share their final two-label suffix. This catches
// sibling subdomains and fails closed for multi-label public suffixes.
func siteBoundarySuffix(value string) string {
	labels := strings.Split(value, ".")
	if len(labels) < 2 {
		return value
	}
	return strings.Join(labels[len(labels)-2:], ".")
}

func validDNSName(value string) bool {
	if len(value) > 253 || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") || strings.Contains(value, "..") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func parsePrefixes(value string) ([]netip.Prefix, error) {
	parts := strings.Split(value, ",")
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(part))
		if err != nil {
			return nil, fmt.Errorf("invalid prefix %q", part)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return -1
	}
	return parsed
}

func envInt64(name string, fallback int64) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return -1
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return -1
	}
	return parsed
}
