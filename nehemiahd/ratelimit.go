package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter caps abuse from a single client: how many machines one IP may hold at
// once, and how fast it may create them (token bucket, refilled per minute).
// Both matter for a public, anonymous endpoint running untrusted code.
type Limiter struct {
	mu        sync.Mutex
	perIPMax  int
	rate      float64 // tokens per second
	burst     float64
	live      map[string]int
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter builds a limiter allowing perIPMax concurrent machines per IP and
// ratePerMin creations per minute per IP (burst = ratePerMin).
func NewLimiter(perIPMax, ratePerMin int) *Limiter {
	if perIPMax < 1 {
		perIPMax = 1
	}
	if ratePerMin < 1 {
		ratePerMin = 1
	}
	return &Limiter{
		perIPMax:  perIPMax,
		rate:      float64(ratePerMin) / 60.0,
		burst:     float64(ratePerMin),
		live:      make(map[string]int),
		buckets:   make(map[string]*bucket),
		lastSweep: time.Now(),
	}
}

// Acquire reserves a create slot for ip, enforcing both the rate and the
// concurrency cap. On success the caller must eventually call Release(ip).
func (l *Limiter) Acquire(ip string) error {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// Concurrency cap first (cheap, and the primary abuse control).
	if l.live[ip] >= l.perIPMax {
		return ErrRateLimited
	}

	// Token bucket for create rate.
	b := l.buckets[ip]
	if b == nil {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return ErrRateLimited
	}
	b.tokens--
	l.live[ip]++

	l.sweep(now)
	return nil
}

// Release frees a concurrency slot for ip.
func (l *Limiter) Release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.live[ip] > 0 {
		l.live[ip]--
	}
	if l.live[ip] == 0 {
		delete(l.live, ip)
	}
}

// sweep drops idle buckets so the maps don't grow unbounded. Caller holds mu.
func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < 5*time.Minute {
		return
	}
	l.lastSweep = now
	for ip, b := range l.buckets {
		if l.live[ip] == 0 && now.Sub(b.last) > 10*time.Minute {
			delete(l.buckets, ip)
		}
	}
}

// clientIP extracts the client address. Behind the public gateway we trust the
// left-most X-Forwarded-For entry (set by Caddy); otherwise the socket peer.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i >= 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
