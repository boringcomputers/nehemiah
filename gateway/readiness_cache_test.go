package main

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

// TestReadinessCacheRecoversFromPanickingProbe proves a probe that panics (as
// httputil.ReverseProxy does with http.ErrAbortHandler on a mid-body copy error)
// does not permanently wedge the single-flight barrier. Before the fix, the panic
// unwound through get() leaving c.inFlight non-nil forever, so every later /readyz
// blocked until its context expired — one transient control-plane blip killed
// readiness until a gateway restart.
func TestReadinessCacheRecoversFromPanickingProbe(t *testing.T) {
	t.Parallel()
	cache := &readinessCache{}
	now := func() time.Time { return time.Unix(1_700_000_000, 0) }

	_, err := cache.get(context.Background(), now, func() readinessResult {
		panic(http.ErrAbortHandler)
	})
	if err == nil {
		t.Fatal("expected an error from a panicking probe")
	}
	if cache.inFlight != nil {
		t.Fatal("inFlight was not cleared after the probe panicked — cache is wedged")
	}

	// A subsequent probe must run (not block) and its result must be served.
	result, err := cache.get(context.Background(), now, func() readinessResult {
		return readinessResult{status: http.StatusOK, body: []byte("ready")}
	})
	if err != nil {
		t.Fatalf("recovery probe failed: %v", err)
	}
	if result.status != http.StatusOK || string(result.body) != "ready" {
		t.Fatalf("recovery result = (%d, %q)", result.status, result.body)
	}
}

// TestReadinessCacheConcurrentWaitersUnblockAfterPanic proves goroutines parked on
// the in-flight barrier are released (not deadlocked) when the leader's probe panics.
func TestReadinessCacheConcurrentWaitersUnblockAfterPanic(t *testing.T) {
	t.Parallel()
	cache := &readinessCache{}
	now := func() time.Time { return time.Unix(1_700_000_000, 0) }

	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(8)
	for i := 0; i < 8; i++ {
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = cache.get(ctx, now, func() readinessResult {
				<-release
				panic(http.ErrAbortHandler)
			})
		}()
	}
	// Let the goroutines converge — one becomes leader, the rest park on inFlight.
	time.Sleep(50 * time.Millisecond)
	close(release)

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("waiters deadlocked after the leader probe panicked")
	}
	if cache.inFlight != nil {
		t.Fatal("inFlight left set after panic")
	}
}

// TestBoundedReadinessWriterOverflowDoesNotError proves the recorder never returns
// a write error past the bound (which would make ReverseProxy panic); instead it
// flags overflow so readinessResult can return the 502 fallback, and it stops
// retaining body bytes.
func TestBoundedReadinessWriterOverflowDoesNotError(t *testing.T) {
	t.Parallel()
	w := newBoundedReadinessWriter()
	chunk := make([]byte, readinessResponseLimit)
	if n, err := w.Write(chunk); err != nil || n != len(chunk) {
		t.Fatalf("first write = (%d, %v), want (%d, nil)", n, err, len(chunk))
	}
	overflowChunk := []byte("this pushes past the readiness bound")
	if n, err := w.Write(overflowChunk); err != nil || n != len(overflowChunk) {
		t.Fatalf("overflow write = (%d, %v), want (%d, nil) — an error here panics ReverseProxy", n, err, len(overflowChunk))
	}
	if !w.overflow {
		t.Fatal("overflow flag not set")
	}
	if len(w.body) > readinessResponseLimit {
		t.Fatalf("retained %d body bytes past the %d bound", len(w.body), readinessResponseLimit)
	}
}
