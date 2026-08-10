package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

var errRESTBodyTimeout = errors.New("gateway REST request body deadline exceeded")

// restActiveLimiter is an exact, bounded in-memory semaphore for ordinary
// REST requests. Active identities cannot grow beyond the global ceiling and
// entries disappear immediately after the last request releases its slot.
type restActiveLimiter struct {
	mu           sync.Mutex
	maximumTotal int
	maximumPeer  int
	total        int
	byPeer       map[string]int
}

func newRESTActiveLimiter(maximumTotal, maximumPeer int) *restActiveLimiter {
	return &restActiveLimiter{
		maximumTotal: maximumTotal,
		maximumPeer:  maximumPeer,
		byPeer:       make(map[string]int),
	}
}

func (l *restActiveLimiter) acquire(peer string) (func(), bool) {
	l.mu.Lock()
	if l.total >= l.maximumTotal || l.byPeer[peer] >= l.maximumPeer {
		l.mu.Unlock()
		return nil, false
	}
	l.total++
	l.byPeer[peer]++
	l.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.total--
			l.byPeer[peer]--
			if l.byPeer[peer] == 0 {
				delete(l.byPeer, peer)
			}
			l.mu.Unlock()
		})
	}, true
}

type requestBodyDeadline struct {
	body  io.ReadCloser
	clear func()
	once  sync.Once
	state *restBodyDeadlineState
}

type restBodyDeadlineState struct{ timedOut atomic.Bool }

type restBodyDeadlineContextKey struct{}

func (b *requestBodyDeadline) Read(buffer []byte) (int, error) {
	count, err := b.body.Read(buffer)
	if err != nil {
		b.once.Do(b.clear)
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			b.state.timedOut.Store(true)
			return count, errors.Join(errRESTBodyTimeout, err)
		}
	}
	return count, err
}

func restBodyTimedOut(request *http.Request) bool {
	state, _ := request.Context().Value(restBodyDeadlineContextKey{}).(*restBodyDeadlineState)
	return state != nil && state.timedOut.Load()
}

func (b *requestBodyDeadline) Close() error {
	b.once.Do(b.clear)
	return b.body.Close()
}

func applyRESTBodyDeadline(w http.ResponseWriter, request *http.Request, timeout time.Duration) (*http.Request, func()) {
	if request.Body == nil || request.Body == http.NoBody {
		return request, func() {}
	}
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		// The released gateway always runs under net/http (and the telemetry
		// wrapper exposes Unwrap), where read deadlines are supported. Some unit
		// response recorders do not expose a connection; max active duration still
		// bounds those synthetic calls.
		return request, func() {}
	}
	clear := func() { _ = controller.SetReadDeadline(time.Time{}) }
	state := &restBodyDeadlineState{}
	wrapped := &requestBodyDeadline{body: request.Body, clear: clear, state: state}
	request.Body = wrapped
	request = request.WithContext(context.WithValue(request.Context(), restBodyDeadlineContextKey{}, state))
	return request, func() { wrapped.once.Do(clear) }
}
