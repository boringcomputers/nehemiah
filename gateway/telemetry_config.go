package main

import (
	"crypto/hmac"
	"errors"
	"fmt"
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

// TelemetryConfig is deliberately opt-in. A disabled zero value installs no
// exporters and performs no network I/O.
type TelemetryConfig struct {
	Enabled        bool
	Endpoint       string
	Authorization  string
	ServiceVersion string
	InstanceID     string
	DeploymentEnv  string
	Region         string
	ExportInterval time.Duration
	ExportTimeout  time.Duration
	TraceSample    float64
}

type environmentLookup func(string) (string, bool)

func loadTelemetryConfig(lookup environmentLookup) (TelemetryConfig, error) {
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
	rawEnabled, hasEnabled := lookup("NEHEMIAH_OTEL_ENABLED")
	configured := hasEnabled
	for _, name := range tuning {
		_, present := lookup(name)
		configured = configured || present
	}
	if !configured {
		return TelemetryConfig{}, nil
	}
	if rawEnabled != "true" && rawEnabled != "false" {
		return TelemetryConfig{}, errors.New("NEHEMIAH_OTEL_ENABLED must be exactly true or false")
	}
	if rawEnabled == "false" {
		for _, name := range tuning {
			if _, present := lookup(name); present {
				return TelemetryConfig{}, fmt.Errorf("%s requires NEHEMIAH_OTEL_ENABLED=true", name)
			}
		}
		return TelemetryConfig{}, nil
	}

	value := func(name string) string {
		result, _ := lookup(name)
		return result
	}
	interval, err := telemetryMilliseconds(value("NEHEMIAH_OTEL_EXPORT_INTERVAL_MS"), defaultTelemetryExportInterval)
	if err != nil {
		return TelemetryConfig{}, fmt.Errorf("NEHEMIAH_OTEL_EXPORT_INTERVAL_MS: %w", err)
	}
	timeout, err := telemetryMilliseconds(value("NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS"), defaultTelemetryExportTimeout)
	if err != nil {
		return TelemetryConfig{}, fmt.Errorf("NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS: %w", err)
	}
	sample := defaultTelemetrySampleRatio
	if raw := value("NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO"); raw != "" {
		sample, err = strconv.ParseFloat(raw, 64)
		if err != nil {
			return TelemetryConfig{}, errors.New("NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO must be a decimal between 0.001 and 1")
		}
	}
	config := TelemetryConfig{
		Enabled:        true,
		Endpoint:       value("NEHEMIAH_OTEL_ENDPOINT"),
		Authorization:  value("NEHEMIAH_OTEL_AUTHORIZATION"),
		ServiceVersion: value("NEHEMIAH_SERVICE_VERSION"),
		InstanceID:     value("NEHEMIAH_INSTANCE_ID"),
		DeploymentEnv:  value("NEHEMIAH_DEPLOYMENT_ENVIRONMENT"),
		Region:         value("NEHEMIAH_REGION"),
		ExportInterval: interval,
		ExportTimeout:  timeout,
		TraceSample:    sample,
	}
	if err := config.Validate(false, "", ""); err != nil {
		return TelemetryConfig{}, err
	}
	return config, nil
}

func telemetryMilliseconds(value string, fallback time.Duration) (time.Duration, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, errors.New("must be a positive integer number of milliseconds")
	}
	return time.Duration(parsed) * time.Millisecond, nil
}

func (c TelemetryConfig) Validate(production bool, platformSecrets ...string) error {
	if !c.Enabled {
		if c != (TelemetryConfig{}) {
			return errors.New("telemetry exporter settings require NEHEMIAH_OTEL_ENABLED=true")
		}
		if production {
			return errors.New("NEHEMIAH_OTEL_ENABLED=true is required for a production gateway")
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
	if production && c.DeploymentEnv != "staging" && c.DeploymentEnv != "production" {
		return errors.New("NEHEMIAH_DEPLOYMENT_ENVIRONMENT must be staging or production for a production gateway")
	}
	if !telemetryIdentityPattern.MatchString(c.Region) || net.ParseIP(c.Region) != nil {
		return errors.New("NEHEMIAH_REGION must be a bounded non-IP 1-128 character region identifier")
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
	if production {
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
