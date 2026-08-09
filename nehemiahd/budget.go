package main

import (
	"sync"
	"time"
)

// dailyLimit is a global per-UTC-day counter that trips a circuit breaker to cap
// runaway cost on the shared Anthropic key. The per-IP limiters handle normal
// throttling; this is the catastrophe ceiling (viral traffic, distributed
// abuse). max <= 0 disables it.
type dailyLimit struct {
	mu    sync.Mutex
	day   int
	count int
	max   int
}

func newDailyLimit(max int) *dailyLimit { return &dailyLimit{max: max} }

// allow increments today's counter and reports whether we're still under the
// cap, rolling over at UTC midnight.
func (d *dailyLimit) allow() bool {
	if d == nil || d.max <= 0 {
		return true
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if yd := time.Now().UTC().YearDay(); yd != d.day {
		d.day = yd
		d.count = 0
	}
	if d.count >= d.max {
		return false
	}
	d.count++
	return true
}
