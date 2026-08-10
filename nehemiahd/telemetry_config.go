package main

import (
	"crypto/hmac"
	"errors"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultTelemetryExportInterval = 15 * time.Second
	defaultTelemetryExportTimeout  = 10 * time.Second
	defaultTelemetrySampleRatio    = 0.1
)

var (
	telemetryIdentityPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	telemetryAuthorizationPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,31} [!-~]+$`)
)

// TelemetryConfig is populated without network access during LoadConfig and is
// validated by Config.Validate. EnabledSetting preserves the distinction
// between an absent opt-in and an explicitly disabled exporter.
type TelemetryConfig struct {
	EnabledSetting   string
	TuningConfigured bool
	Endpoint         string
	Authorization    string
	ServiceVersion   string
	InstanceID       string
	DeploymentEnv    string
	ExportInterval   time.Duration
	ExportTimeout    time.Duration
	TraceSample      float64
}

type environmentLookup func(string) (string, bool)

func loadTelemetryConfig(lookup environmentLookup) TelemetryConfig {
	rawEnabled, hasEnabled := lookup("NEHEMIAH_OTEL_ENABLED")
	config := TelemetryConfig{EnabledSetting: rawEnabled}
	tuning := []string{
		"NEHEMIAH_OTEL_ENDPOINT",
		"NEHEMIAH_OTEL_AUTHORIZATION",
		"NEHEMIAH_SERVICE_VERSION",
		"NEHEMIAH_INSTANCE_ID",
		"NEHEMIAH_DEPLOYMENT_ENVIRONMENT",
		"NEHEMIAH_OTEL_EXPORT_INTERVAL_MS",
		"NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS",
		"NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO",
	}
	values := make(map[string]string, len(tuning))
	for _, name := range tuning {
		value, present := lookup(name)
		if present {
			config.TuningConfigured = true
			values[name] = value
		}
	}
	if !hasEnabled && !config.TuningConfigured {
		return TelemetryConfig{}
	}
	config.Endpoint = values["NEHEMIAH_OTEL_ENDPOINT"]
	config.Authorization = values["NEHEMIAH_OTEL_AUTHORIZATION"]
	config.ServiceVersion = values["NEHEMIAH_SERVICE_VERSION"]
	config.InstanceID = values["NEHEMIAH_INSTANCE_ID"]
	config.DeploymentEnv = values["NEHEMIAH_DEPLOYMENT_ENVIRONMENT"]
	config.ExportInterval = parseTelemetryMilliseconds(values["NEHEMIAH_OTEL_EXPORT_INTERVAL_MS"], defaultTelemetryExportInterval)
	config.ExportTimeout = parseTelemetryMilliseconds(values["NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS"], defaultTelemetryExportTimeout)
	config.TraceSample = defaultTelemetrySampleRatio
	if raw := values["NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO"]; raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			config.TraceSample = -1
		} else {
			config.TraceSample = parsed
		}
	}
	return config
}

func parseTelemetryMilliseconds(value string, fallback time.Duration) time.Duration {
	if value == "" {
		return fallback
	}
	milliseconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || milliseconds <= 0 {
		return -1
	}
	return time.Duration(milliseconds) * time.Millisecond
}

func (c TelemetryConfig) Enabled() bool { return c.EnabledSetting == "true" }

func (c TelemetryConfig) Validate(managed bool, platformSecrets ...string) error {
	if c.EnabledSetting == "" {
		if c.TuningConfigured {
			return errors.New("NEHEMIAH_OTEL_ENABLED=true is required before OTLP exporter settings are configured")
		}
		if managed {
			return errors.New("NEHEMIAH_OTEL_ENABLED=true is required on a managed host")
		}
		return nil
	}
	if c.EnabledSetting != "true" && c.EnabledSetting != "false" {
		return errors.New("NEHEMIAH_OTEL_ENABLED must be exactly true or false")
	}
	if !c.Enabled() {
		if c.TuningConfigured {
			return errors.New("OTLP exporter settings require NEHEMIAH_OTEL_ENABLED=true")
		}
		if managed {
			return errors.New("NEHEMIAH_OTEL_ENABLED=true is required on a managed host")
		}
		return nil
	}
	endpoint, err := url.Parse(c.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || net.ParseIP(endpoint.Hostname()) != nil || endpoint.User != nil ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("NEHEMIAH_OTEL_ENDPOINT must be an origin-only HTTPS URL with a DNS hostname")
	}
	if len(c.Authorization) < 16 || len(c.Authorization) > 4096 || !telemetryAuthorizationPattern.MatchString(c.Authorization) {
		return errors.New("NEHEMIAH_OTEL_AUTHORIZATION must be a 16-4096 character HTTP authorization value without whitespace in its credential")
	}
	if !telemetryIdentityPattern.MatchString(c.ServiceVersion) {
		return errors.New("NEHEMIAH_SERVICE_VERSION must be an immutable 1-128 character release identifier")
	}
	if !telemetryIdentityPattern.MatchString(c.InstanceID) || net.ParseIP(c.InstanceID) != nil {
		return errors.New("NEHEMIAH_INSTANCE_ID must be a stable non-IP 1-128 character instance identifier")
	}
	switch c.DeploymentEnv {
	case "development", "test", "staging", "production":
	default:
		return errors.New("NEHEMIAH_DEPLOYMENT_ENVIRONMENT must be development, test, staging, or production")
	}
	if managed && c.DeploymentEnv != "staging" && c.DeploymentEnv != "production" {
		return errors.New("NEHEMIAH_DEPLOYMENT_ENVIRONMENT must be staging or production for a managed host")
	}
	if c.ExportInterval < 5*time.Second || c.ExportInterval > 5*time.Minute {
		return errors.New("NEHEMIAH_OTEL_EXPORT_INTERVAL_MS must be between 5000 and 300000")
	}
	if c.ExportTimeout < time.Second || c.ExportTimeout > 30*time.Second || c.ExportTimeout >= c.ExportInterval {
		return errors.New("NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS must be between 1000 and 30000 and less than the export interval")
	}
	if math.IsNaN(c.TraceSample) || math.IsInf(c.TraceSample, 0) || c.TraceSample < 0.001 || c.TraceSample > 1 {
		return errors.New("NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO must be between 0.001 and 1")
	}
	if managed {
		credential := c.Authorization
		if index := strings.IndexByte(credential, ' '); index >= 0 {
			credential = credential[index+1:]
		}
		for _, secret := range platformSecrets {
			if secret != "" && (hmac.Equal([]byte(c.Authorization), []byte(secret)) || hmac.Equal([]byte(credential), []byte(secret))) {
				return errors.New("NEHEMIAH_OTEL_AUTHORIZATION must be distinct from platform credentials")
			}
		}
	}
	return nil
}
