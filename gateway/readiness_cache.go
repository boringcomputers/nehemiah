package main

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const (
	readinessCacheTTL      = time.Second
	readinessResponseLimit = 16 << 10
)

type readinessResult struct {
	status      int
	contentType string
	retryAfter  string
	body        []byte
	expiresAt   time.Time
}

type readinessCache struct {
	mu       sync.Mutex
	result   *readinessResult
	inFlight chan struct{}
}

func (c *readinessCache) get(
	ctx context.Context,
	now func() time.Time,
	fetch func() readinessResult,
) (readinessResult, error) {
	for {
		c.mu.Lock()
		if c.result != nil && c.result.expiresAt.After(now()) {
			result := *c.result
			result.body = append([]byte(nil), c.result.body...)
			c.mu.Unlock()
			return result, nil
		}
		if c.inFlight != nil {
			inFlight := c.inFlight
			c.mu.Unlock()
			select {
			case <-inFlight:
				continue
			case <-ctx.Done():
				return readinessResult{}, ctx.Err()
			}
		}
		inFlight := make(chan struct{})
		c.inFlight = inFlight
		c.mu.Unlock()

		result, err := runReadinessFetch(now, fetch)
		c.mu.Lock()
		if err == nil {
			c.result = &result
		}
		c.inFlight = nil
		close(inFlight)
		c.mu.Unlock()
		return result, err
	}
}

// runReadinessFetch runs the probe and converts a panic into an error rather than
// letting it unwind through get(). httputil.ReverseProxy panics with
// http.ErrAbortHandler on a mid-body copy error (for example when the control
// plane resets the connection); without this recovery the single-flight barrier
// (c.inFlight) would never be cleared and every later /readyz would block until
// its context expired — a permanent wedge from one transient blip.
func runReadinessFetch(now func() time.Time, fetch func() readinessResult) (result readinessResult, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("readiness probe panicked: %v", r)
			result = readinessResult{}
		}
	}()
	result = fetch()
	result.expiresAt = now().Add(readinessCacheTTL)
	return result, nil
}

type boundedReadinessWriter struct {
	header      http.Header
	status      int
	wroteHeader bool
	body        []byte
	overflow    bool
}

func newBoundedReadinessWriter() *boundedReadinessWriter {
	return &boundedReadinessWriter{header: make(http.Header), status: http.StatusOK}
}

func (w *boundedReadinessWriter) Header() http.Header { return w.header }

func (w *boundedReadinessWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
}

func (w *boundedReadinessWriter) Write(value []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	// Report success even past the bound so httputil.ReverseProxy's copy loop does
	// not see a write error and panic with http.ErrAbortHandler. We stop retaining
	// body bytes (bounded memory) and flag overflow so readinessResult returns the
	// 502 fallback instead of a truncated body.
	if w.overflow {
		return len(value), nil
	}
	if len(w.body)+len(value) > readinessResponseLimit {
		w.overflow = true
		return len(value), nil
	}
	w.body = append(w.body, value...)
	return len(value), nil
}

func (g *gateway) readinessResult(request *http.Request) readinessResult {
	recorder := newBoundedReadinessWriter()
	probe := request.Clone(request.Context())
	probe.Method = http.MethodGet
	probe.Body = http.NoBody
	probe.ContentLength = 0
	g.controlProxy.ServeHTTP(recorder, probe)
	if recorder.overflow {
		return readinessResult{
			status:      http.StatusBadGateway,
			contentType: "application/problem+json",
			body:        []byte(`{"title":"control_plane_unavailable","status":502}`),
		}
	}
	return readinessResult{
		status:      recorder.status,
		contentType: recorder.header.Get("Content-Type"),
		retryAfter:  recorder.header.Get("Retry-After"),
		body:        append([]byte(nil), recorder.body...),
	}
}

func (g *gateway) serveReadiness(w http.ResponseWriter, request *http.Request) {
	result, err := g.readiness.get(request.Context(), g.now, func() readinessResult {
		return g.readinessResult(request)
	})
	if err != nil {
		writeProblem(w, http.StatusGatewayTimeout, "request_duration_exceeded", "The gateway request duration limit was reached.", requestID(request.Context()))
		return
	}
	if result.contentType != "" {
		w.Header().Set("Content-Type", result.contentType)
	}
	if result.retryAfter != "" {
		w.Header().Set("Retry-After", result.retryAfter)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(result.status)
	if request.Method != http.MethodHead {
		_, _ = w.Write(result.body)
	}
}
