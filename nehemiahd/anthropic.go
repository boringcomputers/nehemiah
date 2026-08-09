package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// anthropicRequest holds the parameters for a call to the Anthropic Messages API.
type anthropicRequest struct {
	Model      string
	MaxTokens  int
	System     string
	Tools      []any
	Messages   []json.RawMessage
	Effort     string // "low", "medium", "high"; empty omits output_config
	BetaHeader string // non-empty adds the anthropic-beta header
}

// callAnthropicAPI posts a request to the Anthropic Messages API and returns
// the parsed response. Both the computer-use agent and the shell agent use this.
func callAnthropicAPI(cfg Config, req anthropicRequest) (*apiResp, error) {
	body := map[string]any{
		"model":      req.Model,
		"max_tokens": req.MaxTokens,
		"system":     req.System,
		"tools":      req.Tools,
		"messages":   req.Messages,
	}
	if req.Effort != "" {
		body["output_config"] = map[string]any{"effort": req.Effort}
	}

	buf, _ := json.Marshal(body)
	httpReq, err := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-api-key", cfg.AnthropicKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	if req.BetaHeader != "" {
		httpReq.Header.Set("anthropic-beta", req.BetaHeader)
	}

	res, err := (&http.Client{Timeout: 120 * time.Second}).Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("the AI is unreachable right now")
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		json.Unmarshal(data, &e)
		if e.Error.Message != "" {
			return nil, fmt.Errorf("model error: %s", e.Error.Message)
		}
		return nil, fmt.Errorf("model http %d", res.StatusCode)
	}
	var out apiResp
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("bad model response")
	}
	return &out, nil
}

// agentGuard holds the shared boilerplate that both the computer-use agent and
// the shell agent check before entering their main loops.
type agentGuard struct {
	conn    *websocket.Conn
	send    func(typ, text string)
	stopped func() bool
	stop    chan struct{}
}

// setupAgentGuard validates auth, budget and concurrency, upgrades the WebSocket,
// and wires up a stop-detection goroutine. Returns nil if any precondition fails
// (an error response has already been written).
func (s *Server) setupAgentGuard(w http.ResponseWriter, r *http.Request) *agentGuard {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil
	}
	send := func(typ, text string) {
		_ = conn.WriteJSON(map[string]string{"type": typ, "text": text})
	}

	if s.cfg.AnthropicKey == "" {
		send("error", "the agent isn't configured on this server")
		conn.Close()
		return nil
	}
	if n := agentRunsAdd(1); int(n) > s.cfg.AgentMaxConcurrent {
		agentRunsAdd(-1)
		send("error", "too many agents are running right now — try again in a moment")
		conn.Close()
		return nil
	}
	if !s.agentBudget.allow() {
		agentRunsAdd(-1)
		send("error", "the daily AI limit has been reached — please try again tomorrow")
		conn.Close()
		return nil
	}

	stop := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				close(stop)
				return
			}
		}
	}()
	stopped := func() bool {
		select {
		case <-stop:
			return true
		default:
			return false
		}
	}

	return &agentGuard{conn: conn, send: send, stopped: stopped, stop: stop}
}

// close releases the concurrency slot and closes the WebSocket.
func (g *agentGuard) close() {
	agentRunsAdd(-1)
	g.conn.Close()
}
