package main

import (
	"strings"
	"testing"
	"time"
)

func hostTelemetryEnvironment(values map[string]string) environmentLookup {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}

func validHostTelemetryEnvironment() map[string]string {
	return map[string]string{
		"NEHEMIAH_OTEL_ENABLED":            "true",
		"NEHEMIAH_OTEL_ENDPOINT":           "https://otel.example.test",
		"NEHEMIAH_OTEL_AUTHORIZATION":      "Bearer telemetry-secret-value",
		"NEHEMIAH_SERVICE_VERSION":         "2026.08.09",
		"NEHEMIAH_INSTANCE_ID":             "host-ca-1-a",
		"NEHEMIAH_DEPLOYMENT_ENVIRONMENT":  "test",
		"NEHEMIAH_OTEL_EXPORT_INTERVAL_MS": "15000",
		"NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS":  "10000",
		"NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO": "0.2",
	}
}

func TestHostTelemetryConfigurationIsExplicitAndTLSOnly(t *testing.T) {
	disabled := loadTelemetryConfig(hostTelemetryEnvironment(nil))
	if disabled.Enabled() || disabled.TuningConfigured {
		t.Fatalf("disabled telemetry = %#v", disabled)
	}
	if err := disabled.Validate(true); err == nil {
		t.Fatal("managed host accepted disabled telemetry")
	}
	valid := loadTelemetryConfig(hostTelemetryEnvironment(validHostTelemetryEnvironment()))
	if err := valid.Validate(false); err != nil {
		t.Fatalf("valid telemetry: %v", err)
	}
	if !valid.Enabled() || valid.ExportInterval != 15*time.Second || valid.ExportTimeout != 10*time.Second || valid.TraceSample != 0.2 {
		t.Fatalf("valid telemetry = %#v", valid)
	}

	for _, mutate := range []func(map[string]string){
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENABLED"] = "1" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENABLED"] = "false" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENDPOINT"] = "http://otel.example.test" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENDPOINT"] = "https://192.0.2.1" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_ENDPOINT"] = "https://user@otel.example.test/path" },
		func(env map[string]string) { env["NEHEMIAH_INSTANCE_ID"] = "192.0.2.1" },
		func(env map[string]string) { delete(env, "NEHEMIAH_OTEL_AUTHORIZATION") },
		func(env map[string]string) { env["NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS"] = "15000" },
		func(env map[string]string) { env["NEHEMIAH_DEPLOYMENT_ENVIRONMENT"] = "qa" },
		func(env map[string]string) { env["NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO"] = "NaN" },
	} {
		environment := validHostTelemetryEnvironment()
		mutate(environment)
		config := loadTelemetryConfig(hostTelemetryEnvironment(environment))
		if err := config.Validate(false); err == nil {
			t.Fatalf("invalid telemetry environment accepted: %#v", environment)
		}
	}
}

func TestManagedHostTelemetryCredentialMustBeDistinct(t *testing.T) {
	config := loadTelemetryConfig(hostTelemetryEnvironment(validHostTelemetryEnvironment()))
	config.DeploymentEnv = "staging"
	if err := config.Validate(true, "telemetry-secret-value"); err == nil {
		t.Fatal("telemetry authorization reused a managed host credential")
	}
	config.DeploymentEnv = "development"
	if err := config.Validate(true, "another-secret"); err == nil {
		t.Fatal("managed host accepted a development telemetry environment")
	}
}

func TestHostTelemetryRejectsRawIPRegion(t *testing.T) {
	config := Config{
		Region:    "192.0.2.1",
		Telemetry: loadTelemetryConfig(hostTelemetryEnvironment(validHostTelemetryEnvironment())),
	}
	if err := config.Validate(); err == nil {
		t.Fatal("telemetry accepted a raw IP as its cloud region resource attribute")
	}
}

func TestHostTelemetryResourceAttributesAreAllowlisted(t *testing.T) {
	telemetry := loadTelemetryConfig(hostTelemetryEnvironment(validHostTelemetryEnvironment()))
	telemetry.Authorization = "Bearer NEHEMIAH-REDACTION-CANARY-7f91"
	attributes := hostTelemetryResourceAttributes(Config{Region: "ca-central-1", Telemetry: telemetry})
	got := make(map[string]string, len(attributes))
	for _, item := range attributes {
		got[string(item.Key)] = item.Value.AsString()
	}
	want := map[string]string{
		"service.name":                "nehemiahd",
		"service.version":             "2026.08.09",
		"service.instance.id":         "host-ca-1-a",
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

func TestHostRoutesAreNormalizedWithoutCustomerContent(t *testing.T) {
	tests := map[string]string{
		"/internal/v1/machines/customer-machine-secret/fork":                                  "/internal/v1/machines/:id/fork",
		"/internal/v1/machines/customer-machine-secret/template-exports/export-secret/upload": "/internal/v1/machines/:id/template-exports/:export/upload",
		"/v1/machines/customer-machine-secret/web/3000/private/customer/path":                 "/v1/machines/:id/web/:port/*",
		"/customer/private/path": "/_unmatched",
	}
	for path, want := range tests {
		got := normalizedHostRoute(path)
		if got != want {
			t.Errorf("normalizedHostRoute(%q) = %q, want %q", path, got, want)
		}
		for _, forbidden := range []string{"customer", "secret", "private", "3000"} {
			if strings.Contains(got, forbidden) {
				t.Errorf("normalized route leaked %q: %q", forbidden, got)
			}
		}
	}
}
