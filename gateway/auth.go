package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	capabilityIssuer   = "nehemiah-control-plane"
	capabilityAudience = "nehemiah-gateway"
	maxCapabilityTTL   = 15 * time.Minute
	maxJWTBytes        = 8 << 10
)

var gatewayCapabilityOrder = []string{"tty", "vnc", "agent", "files", "preview"}

var validCapabilities = map[string]struct{}{
	"tty": {}, "vnc": {}, "agent": {}, "files": {}, "preview": {},
}

var errCapabilityRequired = errors.New("capability token is required")

const capabilityWebSocketProtocolPrefix = "nehemiah.capability."

type capabilityClaims struct {
	Issuer       string
	Subject      string
	Organization string
	Project      string
	LeaseID      string
	JWTID        string
	Capabilities map[string]struct{}
	Port         *int
	IssuedAt     time.Time
	ExpiresAt    time.Time
}

type jwtPayload struct {
	Issuer       string          `json:"iss"`
	Audience     json.RawMessage `json:"aud"`
	Subject      string          `json:"sub"`
	Organization string          `json:"org"`
	Project      string          `json:"project"`
	LeaseID      string          `json:"lease"`
	Capabilities []string        `json:"cap"`
	Port         *int            `json:"port,omitempty"`
	IssuedAt     int64           `json:"iat"`
	ExpiresAt    int64           `json:"exp"`
	JWTID        string          `json:"jti,omitempty"`
}

func verifyCapabilityToken(token, secret string, now time.Time) (capabilityClaims, error) {
	if token == "" || len(token) > maxJWTBytes {
		return capabilityClaims{}, errors.New("missing or oversized capability token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return capabilityClaims{}, errors.New("malformed capability token")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return capabilityClaims{}, errors.New("malformed capability header")
	}
	var header struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}
	if err := decodeOneJSON(headerBytes, &header); err != nil || header.Algorithm != "HS256" || (header.Type != "" && header.Type != "JWT") {
		return capabilityClaims{}, errors.New("unsupported capability algorithm")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return capabilityClaims{}, errors.New("malformed capability signature")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return capabilityClaims{}, errors.New("invalid capability signature")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return capabilityClaims{}, errors.New("malformed capability claims")
	}
	var payload jwtPayload
	if err := decodeOneJSON(payloadBytes, &payload); err != nil {
		return capabilityClaims{}, errors.New("malformed capability claims")
	}
	if payload.Issuer != capabilityIssuer || !hasAudience(payload.Audience, capabilityAudience) {
		return capabilityClaims{}, errors.New("invalid capability issuer or audience")
	}
	if !boundedClaim(payload.Subject) || !boundedClaim(payload.Organization) || !boundedClaim(payload.Project) || !boundedClaim(payload.LeaseID) || !boundedClaim(payload.JWTID) {
		return capabilityClaims{}, errors.New("invalid capability identity claims")
	}
	if len(payload.Capabilities) == 0 {
		return capabilityClaims{}, errors.New("capability list is required")
	}
	capabilities := make(map[string]struct{}, len(payload.Capabilities))
	for _, capability := range payload.Capabilities {
		if _, ok := validCapabilities[capability]; !ok {
			return capabilityClaims{}, errors.New("unknown capability")
		}
		if _, duplicate := capabilities[capability]; duplicate {
			return capabilityClaims{}, errors.New("duplicate capability")
		}
		capabilities[capability] = struct{}{}
	}
	canonical := make([]string, 0, len(capabilities))
	for _, capability := range gatewayCapabilityOrder {
		if _, ok := capabilities[capability]; ok {
			canonical = append(canonical, capability)
		}
	}
	for index := range canonical {
		if canonical[index] != payload.Capabilities[index] {
			return capabilityClaims{}, errors.New("capabilities are not canonical")
		}
	}
	_, hasPreview := capabilities["preview"]
	if (payload.Port != nil) != hasPreview ||
		(payload.Port != nil && (*payload.Port < 1 || *payload.Port > 65535)) {
		return capabilityClaims{}, errors.New("invalid capability port")
	}
	if payload.IssuedAt <= 0 || payload.ExpiresAt <= 0 {
		return capabilityClaims{}, errors.New("capability timestamps are required")
	}
	issuedAt := time.Unix(payload.IssuedAt, 0)
	expiresAt := time.Unix(payload.ExpiresAt, 0)
	if !expiresAt.After(now) {
		return capabilityClaims{}, errors.New("capability token expired")
	}
	if issuedAt.After(now.Add(30 * time.Second)) {
		return capabilityClaims{}, errors.New("capability token issued in the future")
	}
	if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > maxCapabilityTTL {
		return capabilityClaims{}, errors.New("capability token is not short-lived")
	}
	return capabilityClaims{
		Issuer:       payload.Issuer,
		Subject:      payload.Subject,
		Organization: payload.Organization,
		Project:      payload.Project,
		LeaseID:      payload.LeaseID,
		JWTID:        payload.JWTID,
		Capabilities: capabilities,
		Port:         payload.Port,
		IssuedAt:     issuedAt,
		ExpiresAt:    expiresAt,
	}, nil
}

func decodeOneJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func hasAudience(raw json.RawMessage, wanted string) bool {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return single == wanted
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return false
	}
	for _, audience := range many {
		if audience == wanted {
			return true
		}
	}
	return false
}

func boundedClaim(value string) bool {
	return value != "" && len(value) <= 256 && strings.TrimSpace(value) == value
}

// requestCapabilityToken extracts the capability token from the Authorization
// header or the Sec-WebSocket-Protocol header. The second return value reports
// whether the token was offered as a WebSocket subprotocol: when it was, the
// gateway must echo the capability subprotocol on the 101 response, because a
// browser fails a handshake in which it offered subprotocols and the server
// selected none.
func requestCapabilityToken(r *http.Request) (string, bool, error) {
	headerToken, err := bearerToken(r.Header.Get("Authorization"))
	if err != nil {
		return "", false, err
	}
	if r.URL.Query().Has("token") {
		return "", false, errors.New("query-string capability tokens are not accepted")
	}
	protocolToken := ""
	keptProtocols := make([]string, 0)
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, value := range strings.Split(header, ",") {
			protocol := strings.TrimSpace(value)
			if strings.HasPrefix(protocol, capabilityWebSocketProtocolPrefix) {
				candidate := strings.TrimPrefix(protocol, capabilityWebSocketProtocolPrefix)
				if candidate == "" || protocolToken != "" {
					return "", false, errors.New("invalid websocket capability protocol")
				}
				protocolToken = candidate
				continue
			}
			if protocol != "" {
				keptProtocols = append(keptProtocols, protocol)
			}
		}
	}
	if protocolToken != "" {
		if headerToken != "" && !hmac.Equal([]byte(headerToken), []byte(protocolToken)) {
			return "", false, errors.New("conflicting capability tokens")
		}
		if len(keptProtocols) == 0 {
			r.Header.Del("Sec-WebSocket-Protocol")
		} else {
			r.Header.Set("Sec-WebSocket-Protocol", strings.Join(keptProtocols, ", "))
		}
		return protocolToken, true, nil
	}
	if headerToken != "" {
		return headerToken, false, nil
	}
	return "", false, errCapabilityRequired
}

func bearerToken(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	scheme, token, ok := strings.Cut(value, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.TrimSpace(token) != token || strings.Contains(token, " ") {
		return "", fmt.Errorf("invalid authorization header")
	}
	return token, nil
}
