package main

import (
	"context"
	"sync"
)

// streamDrainer owns the lifetime of every capability stream. net/http does
// not track hijacked WebSocket connections during Server.Shutdown, so the
// gateway must stop admitting new streams and retain explicit cancellation
// handles for the ones already in flight.
type streamDrainer struct {
	mu       sync.Mutex
	draining bool
	nextID   uint64
	streams  map[uint64]context.CancelFunc
	idle     chan struct{}
}

func newStreamDrainer() *streamDrainer {
	idle := make(chan struct{})
	close(idle)
	return &streamDrainer{streams: make(map[uint64]context.CancelFunc), idle: idle}
}

func (d *streamDrainer) begin(parent context.Context) (context.Context, func(), bool) {
	d.mu.Lock()
	if d.draining {
		d.mu.Unlock()
		return nil, nil, false
	}
	if len(d.streams) == 0 {
		d.idle = make(chan struct{})
	}
	d.nextID++
	id := d.nextID
	ctx, cancel := context.WithCancel(parent)
	d.streams[id] = cancel
	d.mu.Unlock()

	var once sync.Once
	finish := func() {
		once.Do(func() {
			cancel()
			d.mu.Lock()
			delete(d.streams, id)
			if len(d.streams) == 0 {
				close(d.idle)
			}
			d.mu.Unlock()
		})
	}
	return ctx, finish, true
}

func (d *streamDrainer) startDrain() {
	d.mu.Lock()
	d.draining = true
	d.mu.Unlock()
}

func (d *streamDrainer) isDraining() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.draining
}

func (d *streamDrainer) active() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.streams)
}

func (d *streamDrainer) wait(ctx context.Context) error {
	d.mu.Lock()
	idle := d.idle
	d.mu.Unlock()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// forceClose cancels every tracked request context. ReverseProxy observes that
// cancellation while copying an upgraded connection and closes both the
// private upstream and the public hijacked socket.
func (d *streamDrainer) forceClose() {
	d.mu.Lock()
	cancellations := make([]context.CancelFunc, 0, len(d.streams))
	for _, cancel := range d.streams {
		cancellations = append(cancellations, cancel)
	}
	d.mu.Unlock()
	for _, cancel := range cancellations {
		cancel()
	}
}
