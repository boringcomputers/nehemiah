package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
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

type contextKey string

const requestIDKey contextKey = "request-id"

// gatewayTelemetry owns the gateway's bounded-cardinality instruments. It is
// a no-op when disabled; the zero value performs no network I/O.
type gatewayTelemetry struct {
	enabled         bool
	tracer          trace.Tracer
	requestCount    metric.Int64Counter
	requestDuration metric.Float64Histogram
	activeRequests  metric.Int64UpDownCounter
	streamCount     metric.Int64Counter
	activeStreams   metric.Int64UpDownCounter
	streamBytes     metric.Int64Counter
	tracerProvider  *sdktrace.TracerProvider
	meterProvider   *sdkmetric.MeterProvider
}

func newGatewayTelemetry(ctx context.Context, cfg TelemetryConfig) (*gatewayTelemetry, error) {
	if !cfg.Enabled {
		return &gatewayTelemetry{}, nil
	}
	headers := map[string]string{"Authorization": cfg.Authorization}
	traceExporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(strings.TrimSuffix(cfg.Endpoint, "/")+"/v1/traces"),
		otlptracehttp.WithHeaders(headers),
		otlptracehttp.WithTimeout(cfg.ExportTimeout),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize OTLP trace exporter: %w", err)
	}
	metricExporter, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(strings.TrimSuffix(cfg.Endpoint, "/")+"/v1/metrics"),
		otlpmetrichttp.WithHeaders(headers),
		otlpmetrichttp.WithTimeout(cfg.ExportTimeout),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize OTLP metric exporter: %w", err)
	}
	res := resource.NewWithAttributes("", gatewayTelemetryResourceAttributes(cfg)...)
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.TraceSample))),
		sdktrace.WithBatcher(traceExporter,
			sdktrace.WithMaxQueueSize(2048),
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithBatchTimeout(cfg.ExportInterval),
			sdktrace.WithExportTimeout(cfg.ExportTimeout),
		),
	)
	reader := sdkmetric.NewPeriodicReader(metricExporter,
		sdkmetric.WithInterval(cfg.ExportInterval),
		sdkmetric.WithTimeout(cfg.ExportTimeout),
	)
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(reader))
	otel.SetTracerProvider(tracerProvider)
	otel.SetMeterProvider(meterProvider)
	// Baggage is intentionally excluded: only W3C traceparent/tracestate cross
	// service boundaries.
	otel.SetTextMapPropagator(propagation.TraceContext{})

	meter := meterProvider.Meter("nehemiah-gateway")
	requestCount, err := meter.Int64Counter("nehemiah.gateway.http.server.request.count")
	if err != nil {
		return nil, errors.Join(err, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	requestDuration, err := meter.Float64Histogram("nehemiah.gateway.http.server.request.duration", metric.WithUnit("s"))
	if err != nil {
		return nil, errors.Join(err, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	activeRequests, err := meter.Int64UpDownCounter("nehemiah.gateway.http.server.active_requests")
	if err != nil {
		return nil, errors.Join(err, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	streamCount, err := meter.Int64Counter("nehemiah.gateway.stream.count")
	if err != nil {
		return nil, errors.Join(err, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	activeStreams, err := meter.Int64UpDownCounter("nehemiah.gateway.stream.active")
	if err != nil {
		return nil, errors.Join(err, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	streamBytes, err := meter.Int64Counter("nehemiah.gateway.stream.bytes", metric.WithUnit("By"))
	if err != nil {
		return nil, errors.Join(err, tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	return &gatewayTelemetry{
		enabled:         true,
		tracer:          tracerProvider.Tracer("nehemiah-gateway"),
		requestCount:    requestCount,
		requestDuration: requestDuration,
		activeRequests:  activeRequests,
		streamCount:     streamCount,
		activeStreams:   activeStreams,
		streamBytes:     streamBytes,
		tracerProvider:  tracerProvider,
		meterProvider:   meterProvider,
	}, nil
}

func gatewayTelemetryResourceAttributes(cfg TelemetryConfig) []attribute.KeyValue {
	return []attribute.KeyValue{
		attribute.String("service.name", "nehemiah-gateway"),
		attribute.String("service.version", cfg.ServiceVersion),
		attribute.String("service.instance.id", cfg.InstanceID),
		attribute.String("deployment.environment.name", cfg.DeploymentEnv),
		attribute.String("cloud.region", cfg.Region),
	}
}

func (t *gatewayTelemetry) shutdown(ctx context.Context) error {
	if t == nil || !t.enabled {
		return nil
	}
	return errors.Join(t.tracerProvider.Shutdown(ctx), t.meterProvider.Shutdown(ctx))
}

func (t *gatewayTelemetry) inject(ctx context.Context, header http.Header) {
	if t == nil || !t.enabled {
		return
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(header))
}

func (t *gatewayTelemetry) streamStarted(ctx context.Context, capability string) func() {
	if t == nil || !t.enabled {
		return func() {}
	}
	attributes := metric.WithAttributes(attribute.String("capability", safeCapability(capability)))
	t.streamCount.Add(ctx, 1, attributes)
	t.activeStreams.Add(ctx, 1, attributes)
	return func() { t.activeStreams.Add(ctx, -1, attributes) }
}

func (t *gatewayTelemetry) addStreamBytes(ctx context.Context, capability, direction string, count int) {
	if t == nil || !t.enabled || count <= 0 {
		return
	}
	t.streamBytes.Add(ctx, int64(count), metric.WithAttributes(
		attribute.String("capability", safeCapability(capability)),
		attribute.String("direction", safeStreamDirection(direction)),
	))
}

func safeCapability(value string) string {
	switch value {
	case "agent", "files", "preview", "tty", "vnc":
		return value
	default:
		return "unknown"
	}
}

func safeStreamDirection(value string) string {
	switch value {
	case "client_to_host", "host_to_client":
		return value
	default:
		return "unknown"
	}
}

func withRequestTelemetry(logger *slog.Logger, next http.Handler, runtimes ...*gatewayTelemetry) http.Handler {
	telemetry := &gatewayTelemetry{}
	if len(runtimes) > 0 && runtimes[0] != nil {
		telemetry = runtimes[0]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		// The public edge owns correlation identifiers. Never log or propagate a
		// caller-controlled header value as trusted metadata.
		id := newRequestID()
		route := normalizedGatewayRoute(r.URL.Path)
		method := normalizedMethod(r.Method)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		var span trace.Span
		if telemetry.enabled {
			ctx, span = telemetry.tracer.Start(ctx, method+" "+route, trace.WithAttributes(
				attribute.String("http.request.method", method),
				attribute.String("http.route", route),
			))
			telemetry.activeRequests.Add(ctx, 1, metric.WithAttributes(
				attribute.String("http.request.method", method),
				attribute.String("http.route", route),
			))
		}
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		recorder.Header().Set("X-Request-ID", id)
		defer func() {
			panicked := recover()
			if panicked != nil {
				recorder.status = http.StatusInternalServerError
			}
			statusClass := httpStatusClass(recorder.status)
			if telemetry.enabled {
				base := []attribute.KeyValue{
					attribute.String("http.request.method", method),
					attribute.String("http.route", route),
				}
				telemetry.activeRequests.Add(ctx, -1, metric.WithAttributes(base...))
				result := append(base, attribute.String("http.response.status_class", statusClass))
				telemetry.requestCount.Add(ctx, 1, metric.WithAttributes(result...))
				telemetry.requestDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(result...))
				span.SetAttributes(attribute.Int("http.response.status_code", recorder.status))
				if recorder.status >= 500 {
					span.SetStatus(codes.Error, statusClass)
				}
				span.End()
			}
			logger.Info("request complete",
				"request_id", id,
				"method", method,
				"route", route,
				"status", recorder.status,
				"duration_ms", time.Since(started).Milliseconds(),
			)
			if panicked != nil {
				panic(panicked)
			}
		}()
		next.ServeHTTP(recorder, r.WithContext(ctx))
	})
}

func normalizedGatewayRoute(path string) string {
	if path == "/healthz" {
		return "/healthz"
	}
	if path == "/v1/capability/exchange" {
		return "/v1/capability/exchange"
	}
	if path == "/internal" || strings.HasPrefix(path, "/internal/") {
		return "/internal/*"
	}
	if _, malformed := parsePreviewRoute(path); malformed {
		return "/preview/:machine/:port/*"
	} else if route, ok := previewTelemetryRoute(path); ok && route.capability == "preview" {
		return "/preview/:machine/:port/*"
	}
	if route, ok := parseMachineCapabilityRoute(path); ok {
		return "/v1/machines/:machine/" + route.action
	}
	// All public control-plane passthrough paths collapse into one route so an
	// attacker cannot create unbounded series or export customer path data.
	return "/_control_plane"
}

func previewTelemetryRoute(path string) (capabilityRoute, bool) {
	route, malformed := parsePreviewRoute(path)
	return route, !malformed && route.capability != ""
}

func normalizedMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

func httpStatusClass(status int) string {
	if status < 100 || status > 599 {
		return "unknown"
	}
	return fmt.Sprintf("%dxx", status/100)
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusRecorder) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	w.status = http.StatusSwitchingProtocols
	w.wroteHeader = true
	return hijacker.Hijack()
}

func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusRecorder) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

func newRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}
