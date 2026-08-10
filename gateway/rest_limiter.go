package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	clientAddressHeader   = "X-Nehemiah-Client-Address"
	clientTimestampHeader = "X-Nehemiah-Client-Timestamp"
	clientSignatureHeader = "X-Nehemiah-Client-Signature"
)

type clientAddressContextKey struct{}

type restRateSlot struct {
	windowStarted time.Time
	requests      int
}

// restRateLimiter is a bounded, process-local first line of defense. Slots are
// collision-conservative: unrelated address networks may share capacity, but a
// collision can never increase either caller's allowance.
type restRateLimiter struct {
	mu     sync.Mutex
	slots  []restRateSlot
	limit  int
	window time.Duration
}

func newRESTRateLimiter(limit, slots int, window time.Duration) *restRateLimiter {
	return &restRateLimiter{slots: make([]restRateSlot, slots), limit: limit, window: window}
}

func (l *restRateLimiter) allow(identity string, now time.Time) (bool, time.Duration) {
	digest := sha256.Sum256([]byte(identity))
	index := (uint32(digest[0])<<24 | uint32(digest[1])<<16 | uint32(digest[2])<<8 | uint32(digest[3])) % uint32(len(l.slots))
	l.mu.Lock()
	defer l.mu.Unlock()
	state := &l.slots[index]
	if state.windowStarted.IsZero() || now.Before(state.windowStarted) || now.Sub(state.windowStarted) >= l.window {
		state.windowStarted = now
		state.requests = 1
		return true, 0
	}
	if state.requests < l.limit {
		state.requests++
		return true, 0
	}
	retry := l.window - now.Sub(state.windowStarted)
	if retry <= 0 || retry > l.window {
		retry = time.Second
	}
	return false, retry
}

func directPeerAddress(request *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	address, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}

func addressInPrefixes(address netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (g *gateway) publicClientAddress(request *http.Request) (netip.Addr, bool) {
	peer, ok := directPeerAddress(request)
	if !ok {
		return netip.Addr{}, false
	}
	if !addressInPrefixes(peer, g.cfg.TrustedEdgeCIDRs) {
		return peer, true
	}
	values := request.Header.Values(g.cfg.TrustedEdgeIPHeader)
	if len(values) != 1 || strings.Contains(values[0], ",") {
		return peer, true
	}
	forwarded, err := netip.ParseAddr(strings.TrimSpace(values[0]))
	if err != nil || !forwarded.IsValid() || forwarded.IsUnspecified() || forwarded.IsMulticast() {
		return peer, true
	}
	return forwarded.Unmap(), true
}

func coarseAddress(address netip.Addr, ok bool) string {
	if !ok {
		return "unknown"
	}
	bits := 56
	if address.Is4() {
		bits = 24
	}
	return netip.PrefixFrom(address, bits).Masked().String()
}

func withPublicClientAddress(request *http.Request, address netip.Addr, ok bool) *http.Request {
	value := ""
	if ok {
		value = address.String()
	}
	return request.WithContext(context.WithValue(request.Context(), clientAddressContextKey{}, value))
}

func publicClientAddressFromContext(ctx context.Context) string {
	value, _ := ctx.Value(clientAddressContextKey{}).(string)
	return value
}

func clientAddressSignature(secret, address, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("nehemiah-client-address-v1\n" + timestamp + "\n" + address))
	return hex.EncodeToString(mac.Sum(nil))
}
