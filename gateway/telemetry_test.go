package main

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func telemetryEnvironment(values map[string]string) environmentLookup {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}

func validTelemetryEnvironment() map[string]string {
	return map[string]string{
		"NEHEMIAH_OTEL_ENABLED":            "true",
		"NEHEMIAH_OTEL_ENDPOINT":           "https://otel.example.test",
		"NEHEMIAH_OTEL_AUTHORIZATION":      "Bearer telemetry-secret-value",
		"NEHEMIAH_SERVICE_VERSION":         "2026.08.09",
		"NEHEMIAH_INSTANCE_ID":             "gateway-ca-1-a",
		"NEHEMIAH_DEPLOYMENT_ENVIRONMENT":  "test",
		"NEHEMIAH_REGION":                  "ca-central-1",
		"NEHEMIAH_OTEL_EXPORT_INTERVAL_MS": "15000",
		"NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS":  "10000",
		"NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO": "0.25",
	}
}

func TestTelemetryConfigurationIsExplicitAndTLSOnly(t *testing.T) {
	disabled, err := loadTelemetryConfig(telemetryEnvironment(nil))
	if err != nil || disabled.Enabled {
		t.Fatalf("disabled config = %#v, err = %v", disabled, err)
	}
	if err := disabled.Validate(true); err == nil {
		t.Fatal("production gateway accepted disabled telemetry")
	}

	valid, err := loadTelemetryConfig(telemetryEnvironment(validTelemetryEnvironment()))
	if err != nil {
		t.Fatalf("valid telemetry: %v", err)
	}
	if !valid.Enabled || valid.ExportInterval != 15*time.Second || valid.ExportTimeout != 10*time.Second || valid.TraceSample != 0.25 {
		t.Fatalf("valid config = %#v", valid)
	}

	for _, mutate := range []func(map[string]string){
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENABLED"] = "1" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENABLED"] = "false" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENDPOINT"] = "http://otel.example.test" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENDPOINT"] = "https://192.0.2.1" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENDPOINT"] = "https://user@otel.example.test/path" },
		func(env map[string]string) { env["NEHEMIAH_INSTANCE_ID"] = "192.0.2.1" },
		func(env map[string]string) { env["NEHEMIAH_REGION"] = "192.0.2.1" },
		func(env map[string]string) { delete(env, "NEHEMIAH_OTEL_AUTHORIZATION") },
		func(env map[string]string) { env["NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS"] = "15000" },
		func(env map[string]string) { env["NEHEMIAH_DEPLOYMENT_ENVIRONMENT"] = "qa" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO"] = "NaN" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO"] = "1.1" },
	} {
		env := validTelemetryEnvironment()
		mutate(env)
		if _, err := loadTelemetryConfig(telemetryEnvironment(env)); err == nil {
			t.Fatalf("invalid telemetry environment accepted: %#v", env)
		}
	}
}

func TestProductionTelemetryCredentialMustBeDistinct(t *testing.T) {
	cfg, err := loadTelemetryConfig(telemetryEnvironment(validTelemetryEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	cfg.DeploymentEnv = "staging"
	if err := cfg.Validate(true, "telemetry-secret-value", "another-secret"); err == nil {
		t.Fatal("telemetry authorization reused a platform credential")
	}
	cfg.DeploymentEnv = "development"
	if err := cfg.Validate(true, "another-secret"); err == nil {
		t.Fatal("production gateway accepted a development telemetry environment")
	}
}

func TestGatewayTelemetryResourceAttributesAreAllowlisted(t *testing.T) {
	cfg, err := loadTelemetryConfig(telemetryEnvironment(validTelemetryEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Authorization = "Bearer NEHEMIAH-REDACTION-CANARY-7f91"
	attributes := gatewayTelemetryResourceAttributes(cfg)
	got := make(map[string]string, len(attributes))
	for _, item := range attributes {
		got[string(item.Key)] = item.Value.AsString()
	}
	want := map[string]string{
		"service.name":                "nehemiah-gateway",
		"service.version":             "2026.08.09",
		"service.instance.id":         "gateway-ca-1-a",
		"deployment.environment.name": "test",
		"cloud.region":                "ca-central-1",
	}
	if len(got) != len(want) {
		t.Fatalf("resource attributes = %#v", got)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("resource attribute %s = %q, want %q", key, got[key], value)
		}
	}
	for _, value := range got {
		if strings.Contains(value, "NEHEMIAH-REDACTION-CANARY") {
			t.Fatalf("resource attributes leaked authorization: %#v", got)
		}
	}
}

func TestRequestTelemetryLogsOnlyNormalizedRoute(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := withRequestTelemetry(logger, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet,
		"/v1/machines/m_customer-secret-123/download?token=auth-secret&path=/customer/private.txt", nil)
	request.Header.Set("Authorization", "Bearer another-secret")
	request.Header.Set("Cookie", "session=customer-secret")
	request.Header.Set("X-Request-ID", "customer-secret-request-id")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	record := output.String()
	for _, forbidden := range []string{
		"m_customer-secret-123", "auth-secret", "another-secret", "customer-secret", "private.txt", "?token=",
	} {
		if strings.Contains(record, forbidden) {
			t.Fatalf("log record leaked %q: %s", forbidden, record)
		}
	}
	if !strings.Contains(record, `"route":"/v1/machines/:machine/download"`) {
		t.Fatalf("log record did not contain normalized route: %s", record)
	}
}
