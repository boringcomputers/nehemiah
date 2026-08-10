package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// hostTelemetry owns only fixed-name, bounded-cardinality instruments. The
// zero value is disabled and performs no network I/O.
type hostTelemetry struct {
	enabled         bool
	tracer          trace.Tracer
	requestCount    metric.Int64Counter
	requestDuration metric.Float64Histogram
	activeRequests  metric.Int64UpDownCounter
	operationCount  metric.Int64Counter
	operationTime   metric.Float64Histogram
	syncCount       metric.Int64Counter
	syncDuration    metric.Float64Histogram
	registration    metric.Registration
	tracerProvider  *sdktrace.TracerProvider
	meterProvider   *sdkmetric.MeterProvider
}

func newHostTelemetry(ctx context.Context, cfg Config, mgr *Manager) (*hostTelemetry, error) {
	telemetry := cfg.Telemetry
	if !telemetry.Enabled() {
		return &hostTelemetry{}, nil
	}
	headers := map[string]string{"Authorization": telemetry.Authorization}
	traceExporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(strings.TrimSuffix(telemetry.Endpoint, "/")+"/v1/traces"),
		otlptracehttp.WithHeaders(headers),
		otlptracehttp.WithTimeout(telemetry.ExportTimeout),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize OTLP trace exporter: %w", err)
	}
	metricExporter, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(strings.TrimSuffix(telemetry.Endpoint, "/")+"/v1/metrics"),
		otlpmetrichttp.WithHeaders(headers),
		otlpmetrichttp.WithTimeout(telemetry.ExportTimeout),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize OTLP metric exporter: %w", err)
	}
	res := resource.NewWithAttributes("", hostTelemetryResourceAttributes(cfg)...)
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(telemetry.TraceSample))),
		sdktrace.WithBatcher(traceExporter,
			sdktrace.WithMaxQueueSize(2048),
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithBatchTimeout(telemetry.ExportInterval),
			sdktrace.WithExportTimeout(telemetry.ExportTimeout),
		),
	)
	reader := sdkmetric.NewPeriodicReader(metricExporter,
		sdkmetric.WithInterval(telemetry.ExportInterval),
		sdkmetric.WithTimeout(telemetry.ExportTimeout),
	)
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(reader))
	otel.SetTracerProvider(tracerProvider)
	otel.SetMeterProvider(meterProvider)
	// Deliberately exclude baggage; traceparent and tracestate are the only
	// cross-service context accepted or emitted.
	otel.SetTextMapPropagator(propagation.TraceContext{})

	meter := meterProvider.Meter("nehemiahd")
	runtime := &hostTelemetry{
		enabled:        true,
		tracer:         tracerProvider.Tracer("nehemiahd"),
		tracerProvider: tracerProvider,
		meterProvider:  meterProvider,
	}
	cleanup := func(initializationError error) (*hostTelemetry, error) {
		return nil, errors.Join(initializationError, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	if runtime.requestCount, err = meter.Int64Counter("nehemiah.host.http.server.request.count"); err != nil {
		return cleanup(err)
	}
	if runtime.requestDuration, err = meter.Float64Histogram("nehemiah.host.http.server.request.duration", metric.WithUnit("s")); err != nil {
		return cleanup(err)
	}
	if runtime.activeRequests, err = meter.Int64UpDownCounter("nehemiah.host.http.server.active_requests"); err != nil {
		return cleanup(err)
	}
	if runtime.operationCount, err = meter.Int64Counter("nehemiah.host.machine.operation.count"); err != nil {
		return cleanup(err)
	}
	if runtime.operationTime, err = meter.Float64Histogram("nehemiah.host.machine.operation.duration", metric.WithUnit("s")); err != nil {
		return cleanup(err)
	}
	if runtime.syncCount, err = meter.Int64Counter("nehemiah.host.control_plane.sync.count"); err != nil {
		return cleanup(err)
	}
	if runtime.syncDuration, err = meter.Float64Histogram("nehemiah.host.control_plane.sync.duration", metric.WithUnit("s")); err != nil {
		return cleanup(err)
	}
	if err := runtime.registerHostGauges(meter, mgr); err != nil {
		return cleanup(err)
	}
	return runtime, nil
}

func hostTelemetryResourceAttributes(cfg Config) []attribute.KeyValue {
	telemetry := cfg.Telemetry
	return []attribute.KeyValue{
		attribute.String("service.name", "nehemiahd"),
		attribute.String("service.version", telemetry.ServiceVersion),
		attribute.String("service.instance.id", telemetry.InstanceID),
		attribute.String("deployment.environment.name", telemetry.DeploymentEnv),
		attribute.String("cloud.region", cfg.Region),
	}
}

func (t *hostTelemetry) registerHostGauges(meter metric.Meter, mgr *Manager) error {
	cpu, err := meter.Int64ObservableGauge("nehemiah.host.cpu.cores")
	if err != nil {
		return err
	}
	memory, err := meter.Int64ObservableGauge("nehemiah.host.memory.bytes", metric.WithUnit("By"))
	if err != nil {
		return err
	}
	disk, err := meter.Int64ObservableGauge("nehemiah.host.disk.bytes", metric.WithUnit("By"))
	if err != nil {
		return err
	}
	machines, err := meter.Int64ObservableGauge("nehemiah.host.machine.count")
	if err != nil {
		return err
	}
	health, err := meter.Int64ObservableGauge("nehemiah.host.health")
	if err != nil {
		return err
	}
	kvm, err := meter.Int64ObservableGauge("nehemiah.host.kvm.available")
	if err != nil {
		return err
	}
	meteringBacklog, err := meter.Int64ObservableGauge("nehemiah.host.metering.backlog")
	if err != nil {
		return err
	}
	registration, err := meter.RegisterCallback(func(ctx context.Context, observer metric.Observer) error {
		if mgr == nil {
			return nil
		}
		status := mgr.HostStatus(systemHostProbe{})
		observer.ObserveInt64(cpu, int64(status.TotalCPU), metric.WithAttributes(attribute.String("capacity", "total")))
		observer.ObserveInt64(cpu, int64(status.AvailableCPU), metric.WithAttributes(attribute.String("capacity", "available")))
		observer.ObserveInt64(memory, int64(status.TotalMemoryMB)*1024*1024, metric.WithAttributes(attribute.String("capacity", "total")))
		observer.ObserveInt64(memory, int64(status.AvailableMemoryMB)*1024*1024, metric.WithAttributes(attribute.String("capacity", "available")))
		observer.ObserveInt64(disk, safeUint64Metric(status.TotalDiskBytes), metric.WithAttributes(attribute.String("capacity", "total")))
		observer.ObserveInt64(disk, safeUint64Metric(status.AvailableDiskBytes), metric.WithAttributes(attribute.String("capacity", "available")))
		for state, value := range map[string]int{
			"total": status.Machines.Total, "starting": status.Machines.Starting,
			"running": status.Machines.Running, "stopping": status.Machines.Stopping,
		} {
			observer.ObserveInt64(machines, int64(value), metric.WithAttributes(attribute.String("state", state)))
		}
		observer.ObserveInt64(health, 1, metric.WithAttributes(attribute.String("state", safeHostState(status.State))))
		kvmAvailable := int64(0)
		if status.KVM {
			kvmAvailable = 1
		}
		observer.ObserveInt64(kvm, kvmAvailable)
		observer.ObserveInt64(meteringBacklog, int64(mgr.meteringBacklog()))
		return nil
	}, cpu, memory, disk, machines, health, kvm, meteringBacklog)
	if err != nil {
		return err
	}
	t.registration = registration
	return nil
}

func safeUint64Metric(value uint64) int64 {
	if value > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(value)
}

func safeHostState(value string) string {
	switch value {
	case "ready", "draining", "unhealthy":
		return value
	default:
		return "unknown"
	}
}

func (t *hostTelemetry) shutdown(ctx context.Context) error {
	if t == nil || !t.enabled {
		return nil
	}
	if t.registration != nil {
		_ = t.registration.Unregister()
	}
	return errors.Join(t.tracerProvider.Shutdown(ctx), t.meterProvider.Shutdown(ctx))
}

func (t *hostTelemetry) inject(ctx context.Context, header http.Header) {
	if t == nil || !t.enabled {
		return
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(header))
}

func (t *hostTelemetry) synchronize(ctx context.Context, operation func(context.Context) error) error {
	if t == nil || !t.enabled {
		return operation(ctx)
	}
	ctx, span := t.tracer.Start(ctx, "control-plane synchronization")
	started := time.Now()
	result := "success"
	err := operation(ctx)
	if err != nil {
		result = "failure"
		span.SetStatus(codes.Error, result)
		span.SetAttributes(attribute.String("error.type", safeTelemetryErrorType(err)))
	}
	attributes := metric.WithAttributes(attribute.String("result", result))
	t.syncCount.Add(ctx, 1, attributes)
	t.syncDuration.Record(ctx, time.Since(started).Seconds(), attributes)
	span.End()
	return err
}

func (t *hostTelemetry) serveHTTP(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
	if t == nil || !t.enabled {
		next(w, r)
		return
	}
	method := normalizedHostMethod(r.Method)
	route := normalizedHostRoute(r.URL.Path)
	parent := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
	ctx, span := t.tracer.Start(parent, method+" "+route, trace.WithAttributes(
		attribute.String("http.request.method", method),
		attribute.String("http.route", route),
	))
	base := []attribute.KeyValue{
		attribute.String("http.request.method", method),
		attribute.String("http.route", route),
	}
	t.activeRequests.Add(ctx, 1, metric.WithAttributes(base...))
	recorder := &hostStatusRecorder{ResponseWriter: w, status: http.StatusOK}
	started := time.Now()
	defer func() {
		panicked := recover()
		if panicked != nil {
			recorder.status = http.StatusInternalServerError
		}
		t.activeRequests.Add(ctx, -1, metric.WithAttributes(base...))
		statusClass := telemetryStatusClass(recorder.status)
		result := append(base, attribute.String("http.response.status_class", statusClass))
		t.requestCount.Add(ctx, 1, metric.WithAttributes(result...))
		duration := time.Since(started).Seconds()
		t.requestDuration.Record(ctx, duration, metric.WithAttributes(result...))
		if operation := hostLifecycleOperation(method, route); operation != "" {
			attributes := metric.WithAttributes(attribute.String("operation", operation), attribute.String("result", statusClass))
			t.operationCount.Add(ctx, 1, attributes)
			t.operationTime.Record(ctx, duration, attributes)
		}
		span.SetAttributes(attribute.Int("http.response.status_code", recorder.status))
		if recorder.status >= 500 {
			span.SetStatus(codes.Error, statusClass)
		}
		span.End()
		if panicked != nil {
			panic(panicked)
		}
	}()
	next(recorder, r.WithContext(ctx))
}

func normalizedHostMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

func normalizedHostRoute(path string) string {
	if path == "/healthz" || path == "/internal/tls-check" || path == "/internal/v1/host" || path == "/internal/v1/events" {
		return path
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "internal" && parts[1] == "v1" {
		if parts[2] == "machines" {
			switch len(parts) {
			case 3:
				return "/internal/v1/machines"
			case 4:
				return "/internal/v1/machines/:id"
			case 5:
				switch parts[4] {
				case "extend", "fork", "exec", "template-exports":
					return "/internal/v1/machines/:id/" + parts[4]
				}
			case 7:
				if parts[4] == "template-exports" && parts[6] == "upload" {
					return "/internal/v1/machines/:id/template-exports/:export/upload"
				}
			}
		}
		if len(parts) == 5 && parts[2] == "templates" && parts[4] == "activate" {
			return "/internal/v1/templates/:name/activate"
		}
		return "/internal/_unmatched"
	}
	if len(parts) >= 2 && parts[0] == "v1" {
		if len(parts) == 3 && parts[1] == "chat" && parts[2] == "completions" {
			return "/v1/chat/completions"
		}
		if len(parts) == 2 && parts[1] == "models" {
			return "/v1/models"
		}
		if parts[1] == "machines" {
			if len(parts) == 2 {
				return "/v1/machines"
			}
			if len(parts) == 3 {
				return "/v1/machines/:id"
			}
			if len(parts) >= 4 {
				switch parts[3] {
				case "agent", "branch", "download", "exec", "extend", "publish", "save", "screenshot", "shell-agent", "tty", "upload", "vnc":
					return "/v1/machines/:id/" + parts[3]
				case "web":
					return "/v1/machines/:id/web/:port/*"
				}
			}
		}
		if parts[1] == "templates" {
			if len(parts) == 2 {
				return "/v1/templates"
			}
			if len(parts) == 3 {
				return "/v1/templates/:name"
			}
		}
		if parts[1] == "volumes" {
			if len(parts) == 2 {
				return "/v1/volumes"
			}
			if len(parts) == 3 {
				return "/v1/volumes/:id"
			}
			if len(parts) == 4 && (parts[3] == "file" || parts[3] == "files") {
				return "/v1/volumes/:id/" + parts[3]
			}
		}
	}
	return "/_unmatched"
}

func hostLifecycleOperation(method, route string) string {
	if method == http.MethodPost && (route == "/v1/machines" || route == "/internal/v1/machines") {
		return "create"
	}
	if method == http.MethodDelete && (route == "/v1/machines/:id" || route == "/internal/v1/machines/:id") {
		return "destroy"
	}
	if method == http.MethodPost && (route == "/v1/machines/:id/branch" || route == "/internal/v1/machines/:id/fork") {
		return "fork"
	}
	if method == http.MethodPost && strings.HasSuffix(route, "/extend") {
		return "extend"
	}
	if method == http.MethodPost && route == "/internal/v1/templates/:name/activate" {
		return "template_activate"
	}
	if method == http.MethodPost && route == "/internal/v1/machines/:id/template-exports" {
		return "template_export"
	}
	return ""
}

func telemetryStatusClass(status int) string {
	if status < 100 || status > 599 {
		return "unknown"
	}
	return fmt.Sprintf("%dxx", status/100)
}

func safeTelemetryErrorType(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	default:
		var networkError net.Error
		if errors.As(err, &networkError) {
			return "network"
		}
		return "internal"
	}
}

type hostStatusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *hostStatusRecorder) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *hostStatusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	w.status = http.StatusSwitchingProtocols
	w.wroteHeader = true
	return hijacker.Hijack()
}

func (w *hostStatusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *hostStatusRecorder) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
