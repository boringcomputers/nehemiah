package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// inferLimiter is a per-IP sliding-window request cap for the inference gateway
// (it spends real provider money, so public callers are throttled).
type inferLimiter struct {
	mu     sync.Mutex
	hits   map[string][]int64
	perMin int
}

func newInferLimiter(perMin int) *inferLimiter {
	return &inferLimiter{hits: map[string][]int64{}, perMin: perMin}
}

func (l *inferLimiter) allow(ip string) bool {
	now := time.Now().Unix()
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now - 60
	kept := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if t > cut {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.perMin {
		l.hits[ip] = kept
		return false
	}
	l.hits[ip] = append(kept, now)
	return true
}

func isClaudeModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "claude")
}

// anthropicModelID maps a loose model name to a real Anthropic model ID.
func anthropicModelID(model string) string {
	m := strings.ToLower(strings.TrimPrefix(model, "anthropic/"))
	switch {
	case strings.Contains(m, "opus"):
		return "claude-opus-4-8"
	case strings.Contains(m, "haiku"):
		return "claude-haiku-4-5"
	default:
		return "claude-sonnet-4-6"
	}
}

// handleModels advertises the models the gateway can serve.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	var data []map[string]any
	add := func(id string) {
		data = append(data, map[string]any{"id": id, "object": "model", "owned_by": "nehemiah"})
	}
	if s.cfg.AnthropicKey != "" {
		add("claude-opus-4-8")
		add("claude-sonnet-4-6")
		add("claude-haiku-4-5")
	}
	if s.cfg.OpenRouterKey != "" {
		add("openai/gpt-4o-mini")
		add("google/gemini-2.0-flash-001")
		add("meta-llama/llama-3.3-70b-instruct")
		add("deepseek/deepseek-chat")
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

// handleChatCompletions is an OpenAI-compatible endpoint. Claude models go to
// Anthropic natively; everything else goes to OpenRouter. Both keys may be set.
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AnthropicKey == "" && s.cfg.OpenRouterKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "the inference gateway isn't configured"})
		return
	}
	if !s.infer.allow(clientIP(r, s.cfg.TrustProxy)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "a lot of requests right now — slow down a moment"})
		return
	}
	if !s.inferBudget.allow() {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "the daily inference limit has been reached — try again tomorrow"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 512*1024))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "couldn't read body"})
		return
	}
	var req map[string]any
	if json.Unmarshal(body, &req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	model, _ := req["model"].(string)
	stream, _ := req["stream"].(bool)

	// Clamp max_tokens (cost guard).
	maxTok := s.cfg.InferenceMaxTokens
	if mt, ok := req["max_tokens"].(float64); ok && int(mt) > 0 && int(mt) < maxTok {
		maxTok = int(mt)
	}
	req["max_tokens"] = maxTok

	// Route. Claude → Anthropic native (if we have that key), else OpenRouter.
	if isClaudeModel(model) && s.cfg.AnthropicKey != "" {
		s.anthropicChat(w, model, req, stream, maxTok)
		return
	}
	if s.cfg.OpenRouterKey != "" {
		s.proxyOpenRouter(w, req)
		return
	}
	// Only the Anthropic key is set: serve everything from Claude.
	s.anthropicChat(w, model, req, stream, maxTok)
}

// proxyOpenRouter forwards an OpenAI-shaped request to OpenRouter and streams
// the response straight back (OpenRouter is already OpenAI-compatible).
func (s *Server) proxyOpenRouter(w http.ResponseWriter, req map[string]any) {
	buf, _ := json.Marshal(req)
	up, err := http.NewRequest("POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewReader(buf))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal request build error"})
		return
	}
	up.Header.Set("Authorization", "Bearer "+s.cfg.OpenRouterKey)
	up.Header.Set("Content-Type", "application/json")
	up.Header.Set("HTTP-Referer", "https://boringcomputers.com")
	up.Header.Set("X-Title", "Nehemiah")
	res, err := (&http.Client{Timeout: 180 * time.Second}).Do(up)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the model provider is unreachable"})
		return
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(res.StatusCode)
	flusher, _ := w.(http.Flusher)
	b := make([]byte, 4096)
	for {
		n, err := res.Body.Read(b)
		if n > 0 {
			w.Write(b[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// contentToString flattens an OpenAI message content (string, or array of
// {type:"text",text:...}) into plain text.
func contentToString(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, part := range c {
			if p, ok := part.(map[string]any); ok {
				if t, _ := p["text"].(string); t != "" {
					b.WriteString(t)
				}
			}
		}
		return b.String()
	}
	return ""
}

// anthropicChat translates an OpenAI request to the Anthropic Messages API,
// calls it, and translates the response back (streaming or not).
func (s *Server) anthropicChat(w http.ResponseWriter, reqModel string, req map[string]any, stream bool, maxTok int) {
	var system string
	var msgs []map[string]any
	if arr, ok := req["messages"].([]any); ok {
		for _, mi := range arr {
			m, _ := mi.(map[string]any)
			role, _ := m["role"].(string)
			text := contentToString(m["content"])
			if role == "system" {
				if system != "" {
					system += "\n\n"
				}
				system += text
				continue
			}
			if role != "user" && role != "assistant" {
				role = "user"
			}
			msgs = append(msgs, map[string]any{"role": role, "content": text})
		}
	}
	if len(msgs) == 0 {
		msgs = []map[string]any{{"role": "user", "content": "Hello"}}
	}
	amodel := anthropicModelID(reqModel)
	abody := map[string]any{"model": amodel, "max_tokens": maxTok, "messages": msgs, "stream": stream}
	if system != "" {
		abody["system"] = system
	}
	buf, _ := json.Marshal(abody)
	up, err := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(buf))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal request build error"})
		return
	}
	up.Header.Set("content-type", "application/json")
	up.Header.Set("x-api-key", s.cfg.AnthropicKey)
	up.Header.Set("anthropic-version", "2023-06-01")
	res, err := (&http.Client{Timeout: 180 * time.Second}).Do(up)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the model provider is unreachable"})
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 8192))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(res.StatusCode)
		w.Write(data)
		return
	}
	if stream {
		translateAnthropicStream(w, res.Body, amodel)
	} else {
		translateAnthropicJSON(w, res.Body, amodel)
	}
}

func translateAnthropicJSON(w http.ResponseWriter, body io.Reader, model string) {
	data, err := io.ReadAll(body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "failed to read model response"})
		return
	}
	var ar struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &ar); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "invalid model response"})
		return
	}
	var text strings.Builder
	for _, c := range ar.Content {
		if c.Type == "text" {
			text.WriteString(c.Text)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":      "chatcmpl-" + randID(),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index":         0,
			"message":       map[string]any{"role": "assistant", "content": text.String()},
			"finish_reason": "stop",
		}},
		"usage": map[string]any{
			"prompt_tokens":     ar.Usage.InputTokens,
			"completion_tokens": ar.Usage.OutputTokens,
			"total_tokens":      ar.Usage.InputTokens + ar.Usage.OutputTokens,
		},
	})
}

// translateAnthropicStream converts Anthropic SSE into OpenAI chat.completion
// chunk SSE.
func translateAnthropicStream(w http.ResponseWriter, body io.Reader, model string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	id := "chatcmpl-" + randID()
	created := time.Now().Unix()

	emit := func(delta map[string]any, finish any) {
		chunk := map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		}
		b, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", b)
		if flusher != nil {
			flusher.Flush()
		}
	}
	emit(map[string]any{"role": "assistant"}, nil) // opening chunk

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var ev struct {
			Type  string `json:"type"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		}
		if json.Unmarshal([]byte(payload), &ev) != nil {
			continue
		}
		if ev.Type == "content_block_delta" && ev.Delta.Type == "text_delta" && ev.Delta.Text != "" {
			emit(map[string]any{"content": ev.Delta.Text}, nil)
		}
	}
	emit(map[string]any{}, "stop")
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

func randID() string {
	return fmt.Sprintf("%x", time.Now().UnixNano())
}
