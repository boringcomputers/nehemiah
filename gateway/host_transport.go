package main

import (
	"net/http"
	"net/netip"
	"strings"
)

// Host transports (ADR 0002 and ADR 0005). The overlay dials a host's
// WireGuard address directly. The Cloudflare Tunnel transport keeps that
// address as the host's identity but reaches it through the host's own
// tunnel, published under a hostname derived from the address and guarded by
// a Cloudflare Access service token.
const (
	hostTransportOverlay          = "overlay"
	hostTransportCloudflareTunnel = "cloudflare-tunnel"

	accessClientIDHeader     = "CF-Access-Client-Id"
	accessClientSecretHeader = "CF-Access-Client-Secret"
)

// hostTunnelLabel is the DNS label a host's tunnel is published under: dotted
// IPv4 with dashes (10.64.0.7 -> 10-64-0-7) or the fully expanded IPv6 groups
// joined with dashes. It must stay identical to the control plane's
// hostTunnelLabel and to what operators configure in cloudflared on the host.
func hostTunnelLabel(address netip.Addr) string {
	address = address.Unmap()
	if address.Is4() {
		return strings.ReplaceAll(address.String(), ".", "-")
	}
	return strings.ReplaceAll(address.StringExpanded(), ":", "-")
}

// validAccessCredential accepts the opaque Access service-token client id and
// secret: printable ASCII without whitespace, bounded in length.
func validAccessCredential(value string) bool {
	if len(value) < 8 || len(value) > 512 {
		return false
	}
	for _, character := range value {
		if character < '!' || character > '~' {
			return false
		}
	}
	return true
}

// accessHeaderTransport adds the Cloudflare Access service-token headers to
// every request. The original request is not mutated.
type accessHeaderTransport struct {
	next         http.RoundTripper
	clientID     string
	clientSecret string
}

func (t *accessHeaderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set(accessClientIDHeader, t.clientID)
	clone.Header.Set(accessClientSecretHeader, t.clientSecret)
	return t.next.RoundTrip(clone)
}
