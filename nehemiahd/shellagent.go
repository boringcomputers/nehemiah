package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

// The local/self-hosted terminal agent drives a shell toward a natural-language
// goal over serial. Managed cloud issues no agent capability or provider model
// credential. Narration uses the computer-use agent's JSON protocol.

const shellAgentSystem = `You build and run things in a Linux computer to accomplish the user's goal. This is a LIVE demo on a public website — a real person is watching the terminal as you type.

The computer has python3, pip, node, npm, git, curl and full internet access; you run as root. Use the run_command tool to run ONE command at a time; you get its combined output back.

Before each command, write ONE short, friendly, first-person sentence about what you're doing (e.g. "Writing the server file now." or "Installing express."). One sentence — don't over-explain.

Write each file in ONE command — the whole file in a single cat > file <<'EOF' … EOF heredoc (or one printf). Do NOT append line-by-line; it wastes your limited steps. Keep commands non-interactive (-y, --quiet) and NEVER block the terminal — run servers in the BACKGROUND with & .

If the goal is a web app, game, site, or server: build it as a self-contained page when possible, START a server in the BACKGROUND bound to 0.0.0.0 on a port (python3 may be absent — a tiny node http server is the safe choice, e.g. node -e 'require("http").createServer((q,r)=>{r.end(require("fs").readFileSync("index.html"))}).listen(8000,"0.0.0.0")' & — or python3 -m http.server 8000 --bind 0.0.0.0 & if python3 exists), then curl localhost:<port> to confirm it responds. As SOON as it responds, output a line with exactly PORT=<the port> on its own — that immediately gives the user a live, playable link. Do this before any final summary.

You have a limited number of steps — be efficient. When done, reply with one sentence starting with "Done:" and stop calling tools.`

const agentPrompt = "@> " // unique PS1 so output capture works on any shell

const (
	shellAgentStartTimeout  = 5 * time.Second
	shellAgentLifetime      = 5 * time.Minute
	shellAgentGoalLimit     = 4096
	shellAgentCommandLimit  = 16 << 10
	shellAgentOutputLimit   = 64 << 10
	shellAgentContextOutput = 6000
	shellAgentStepLimit     = 30
)

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r`)
var promptRe = regexp.MustCompile(regexp.QuoteMeta(agentPrompt))
var portRe = regexp.MustCompile(`PORT=(\d{2,5})`)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

func (s *Server) runShellAgent(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	if s.cfg.NehemiahMode && r.URL.Query().Has("goal") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "goal_query_not_allowed"})
		return
	}
	id := r.PathValue("id")
	goal := ""
	var guard *agentGuard
	var runCommand func(context.Context, string) (string, bool)

	if s.cfg.NehemiahMode {
		var ok bool
		guard, goal, ok = s.setupShellAgentGuard(w, r)
		if !ok {
			return
		}
		defer guard.close()
		client, err := s.managedShellGuestAgent(r)
		if err != nil {
			guard.send("error", "the guest command channel is unavailable")
			return
		}
		runCommand = func(ctx context.Context, command string) (string, bool) {
			return runManagedShellCommand(ctx, client, id, command)
		}
	} else {
		console, consoleLock, ok := s.mgr.ConsoleLock(id)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
		if !consoleLock.TryLock() {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "machine console is busy (an exec or another agent is running)"})
			return
		}
		defer consoleLock.Unlock()

		goal = strings.TrimSpace(r.URL.Query().Get("goal"))
		if goal != "" {
			if len(goal) > 400 {
				goal = goal[:400]
			}
			guard = s.setupAgentGuard(w, r)
			if guard == nil {
				return
			}
		} else {
			var frameOK bool
			guard, goal, frameOK = s.setupShellAgentGuard(w, r)
			if !frameOK {
				return
			}
		}
		defer guard.close()

		_, sub := console.Subscribe()
		defer console.Unsubscribe(sub)
		if _, err := console.Write([]byte("PS1='" + agentPrompt + "'\n")); err != nil {
			guard.send("error", "the terminal is no longer available")
			return
		}
		time.Sleep(300 * time.Millisecond)
		runCommand = func(_ context.Context, command string) (string, bool) {
			return runGuestCommand(console, sub, command, 30*time.Second), false
		}
	}

	tool := map[string]any{
		"name":        "run_command",
		"description": "Run one shell command in the Linux terminal and get its combined stdout/stderr back.",
		"input_schema": map[string]any{
			"type":       "object",
			"properties": map[string]any{"command": map[string]any{"type": "string", "description": "the shell command to run"}},
			"required":   []string{"command"},
		},
	}
	messages := []json.RawMessage{userTextMessage("Your task: " + goal)}

	guard.send("say", "On it — let me get to work in the terminal.")
	steps := s.cfg.AgentMaxSteps
	if steps > shellAgentStepLimit {
		steps = shellAgentStepLimit
	}
	for step := 0; step < steps; step++ {
		if guard.stopped() {
			return
		}
		// Local demos preserve their historical convenience extension. Managed
		// expiry is an absolute control-plane lease and cannot be extended by a
		// host-local model loop.
		if !s.cfg.NehemiahMode {
			s.mgr.ExtendIfExpiring(id, 2*time.Minute)
		}
		resp, err := s.shellModel(guard.ctx, s.cfg, anthropicRequest{
			Model:     s.cfg.AgentModel,
			MaxTokens: 4096,
			System:    shellAgentSystem,
			Tools:     []any{tool},
			Messages:  messages,
			Effort:    "low",
		})
		if err != nil {
			if guard.stopped() || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return
			}
			if s.cfg.NehemiahMode {
				guard.send("error", "the agent model is temporarily unavailable")
			} else {
				guard.send("error", err.Error())
			}
			return
		}
		messages = append(messages, assistantMessage(resp.Content))

		var results []json.RawMessage
		for _, raw := range resp.Content {
			var b blockHead
			if json.Unmarshal(raw, &b) != nil {
				continue
			}
			switch b.Type {
			case "text":
				if t := strings.TrimSpace(b.Text); t != "" {
					guard.send("say", t)
					if m := portRe.FindStringSubmatch(b.Text); m != nil {
						if port, _ := strconv.Atoi(m[1]); port > 0 && port < 65536 {
							guard.send("preview", m[1])
						}
					}
				}
			case "tool_use":
				if guard.stopped() {
					return
				}
				cmd, _ := b.Input["command"].(string)
				cmd = strings.TrimSpace(cmd)
				if cmd == "" {
					results = append(results, textToolResult(b.ID, "(empty command)", true))
					continue
				}
				if len(cmd) > shellAgentCommandLimit {
					results = append(results, textToolResult(b.ID, "command exceeds the 16 KiB limit", true))
					continue
				}
				guard.send("action", "$ "+cmd)
				out, commandErr := runCommand(guard.ctx, cmd)
				if guard.stopped() {
					return
				}
				results = append(results, textToolResult(b.ID, out, commandErr))
			}
		}
		if len(results) == 0 {
			guard.send("done", "")
			return
		}
		messages = append(messages, userToolResults(results))
	}
	guard.send("done", "reached the step limit")
}

type shellAgentStart struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	Goal    string `json:"goal"`
}

func parseShellAgentStart(messageType int, payload []byte) (string, error) {
	if messageType != websocket.TextMessage {
		return "", errors.New("start frame must be text JSON")
	}
	if len(payload) == 0 || len(payload) > agentControlFrameLimit {
		return "", errors.New("start frame exceeds the 64 KiB limit")
	}
	if !utf8.Valid(payload) {
		return "", errors.New("start frame must be valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var start shellAgentStart
	if err := decoder.Decode(&start); err != nil {
		return "", errors.New("invalid start frame")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return "", errors.New("invalid start frame")
	}
	goal := strings.TrimSpace(start.Goal)
	if start.Type != "start" || start.Version != 1 || goal == "" || !utf8.ValidString(goal) || len(goal) > shellAgentGoalLimit {
		return "", errors.New("invalid start frame")
	}
	return goal, nil
}

func rejectShellAgentStart(conn *websocket.Conn, closeCode int, code, message string) {
	_ = conn.WriteJSON(map[string]string{"type": "error", "code": code, "text": message})
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(closeCode, code), time.Now().Add(time.Second))
	_ = conn.Close()
}

func (s *Server) setupShellAgentGuard(w http.ResponseWriter, r *http.Request) (*agentGuard, string, bool) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, "", false
	}
	conn.SetReadLimit(agentControlFrameLimit)
	_ = conn.SetReadDeadline(time.Now().Add(shellAgentStartTimeout))
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		code := websocket.ClosePolicyViolation
		errorCode := "invalid_start_frame"
		if strings.Contains(err.Error(), "read limit") {
			code = websocket.CloseMessageTooBig
			errorCode = "start_frame_too_large"
		}
		rejectShellAgentStart(conn, code, errorCode, "a valid start frame is required")
		return nil, "", false
	}
	goal, err := parseShellAgentStart(messageType, payload)
	if err != nil {
		rejectShellAgentStart(conn, websocket.ClosePolicyViolation, "invalid_start_frame", err.Error())
		return nil, "", false
	}
	_ = conn.SetReadDeadline(time.Time{})
	stopKeepalive := startWebSocketKeepalive(conn)
	send := func(typ, text string) {
		if len(text) > agentControlFrameLimit {
			const suffix = "…(truncated)"
			text = text[:agentControlFrameLimit-len(suffix)] + suffix
		}
		_ = conn.WriteJSON(map[string]string{"type": typ, "text": text})
	}
	if s.cfg.AnthropicKey == "" {
		send("error", "the agent isn't configured on this server")
		stopKeepalive()
		_ = conn.Close()
		return nil, "", false
	}
	if n := agentRunsAdd(1); int(n) > s.cfg.AgentMaxConcurrent {
		agentRunsAdd(-1)
		send("error", "too many agents are running right now — try again in a moment")
		stopKeepalive()
		_ = conn.Close()
		return nil, "", false
	}
	if !s.agentBudget.allow() {
		agentRunsAdd(-1)
		send("error", "the daily AI limit has been reached — please try again tomorrow")
		stopKeepalive()
		_ = conn.Close()
		return nil, "", false
	}

	ctx, cancel := context.WithTimeout(context.Background(), shellAgentLifetime)
	stop := make(chan struct{})
	go func() {
		defer close(stop)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()
	go func() {
		<-ctx.Done()
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "shell_agent_lifetime_exceeded"), time.Now().Add(time.Second))
		_ = conn.Close()
	}()
	stopped := func() bool {
		select {
		case <-ctx.Done():
			return true
		default:
			return false
		}
	}
	return &agentGuard{conn: conn, send: send, stopped: stopped, stop: stop, keepaliveStop: stopKeepalive, ctx: ctx, cancel: cancel}, goal, true
}

func (s *Server) managedShellGuestAgent(r *http.Request) (*guestAgentClient, error) {
	id := r.PathValue("id")
	leaseID := r.Header.Get("X-Nehemiah-Lease-ID")
	s.mgr.mu.Lock()
	machine := s.mgr.machines[id]
	var driver *fcDriver
	if machine != nil && machine.LeaseID == leaseID {
		driver = machine.driver
	}
	s.mgr.mu.Unlock()
	if machine == nil || driver == nil || leaseID == "" {
		return nil, ErrGuestAgentUnavailable
	}
	return newManagedDriverGuestAgentClient(s.mgr, id, leaseID, driver), nil
}

func (s *Server) managedAgentVsock(ctx context.Context, r *http.Request, port int) (net.Conn, error) {
	id := r.PathValue("id")
	leaseID := r.Header.Get("X-Nehemiah-Lease-ID")
	s.mgr.mu.Lock()
	machine := s.mgr.machines[id]
	var driver *fcDriver
	if machine != nil && machine.LeaseID == leaseID {
		driver = machine.driver
	}
	s.mgr.mu.Unlock()
	if machine == nil || driver == nil || leaseID == "" {
		return nil, ErrInvalidLease
	}
	conn, err := driver.DialVsockContext(ctx, port)
	if err != nil {
		return nil, err
	}
	s.mgr.mu.Lock()
	valid := s.mgr.machines[id] == machine && machine.LeaseID == leaseID && machine.driver == driver
	s.mgr.mu.Unlock()
	if !valid {
		_ = conn.Close()
		return nil, ErrInvalidLease
	}
	return conn, nil
}

func runManagedShellCommand(ctx context.Context, client *guestAgentClient, id, command string) (string, bool) {
	result, err := client.Exec(ctx, id, guestExecRequest{
		Command:   command,
		Timeout:   30 * time.Second,
		MaxOutput: shellAgentOutputLimit,
		PTY:       true,
		Rows:      24,
		Cols:      120,
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return "[command canceled]", true
		}
		return "[guest command channel unavailable]", true
	}
	combined := result.PTY
	if len(combined) == 0 {
		combined = append(append([]byte(nil), result.Stdout...), result.Stderr...)
	}
	output := strings.Trim(stripANSI(string(combined)), "\r\n")
	if output == "" {
		output = "(no output)"
	}
	if len(output) > shellAgentContextOutput {
		output = output[:shellAgentContextOutput] + "\n…(truncated)"
	}
	if result.TimedOut {
		output += "\n[command timed out]"
	} else if result.ExitCode != 0 {
		output += fmt.Sprintf("\n[exit %d]", result.ExitCode)
	}
	if result.Truncated {
		output += "\n[guest output exceeded 64 KiB]"
	}
	return output, result.ExitCode != 0 || result.TimedOut
}

// writeConsoleChunked writes to the guest serial in small pieces with brief
// pauses so the guest tty input buffer keeps up (a large single write overflows
// it and garbles the command).
func writeConsoleChunked(console *Console, s string) error {
	const chunk = 128
	b := []byte(s)
	for i := 0; i < len(b); i += chunk {
		end := i + chunk
		if end > len(b) {
			end = len(b)
		}
		if _, err := console.Write(b[i:end]); err != nil {
			return err
		}
		if end < len(b) {
			time.Sleep(15 * time.Millisecond)
		}
	}
	return nil
}

// runGuestCommand types a command into the guest console and returns its output,
// captured by watching for the shell prompt to reappear.
func runGuestCommand(console *Console, sub *consoleSub, cmd string, timeout time.Duration) string {
	// Drain anything buffered so we only read this command's output.
	for {
		select {
		case <-sub.ch:
			continue
		default:
		}
		break
	}
	// Write in small chunks with brief pauses: the guest tty input buffer
	// overflows on a large single write (garbling big commands), which makes the
	// agent fall back to many tiny appends and burn its step budget. Chunking lets
	// it write a whole file in one command.
	if err := writeConsoleChunked(console, cmd+"\n"); err != nil {
		return "[the terminal is gone]"
	}
	var buf bytes.Buffer
	deadline := time.After(timeout)
	for {
		select {
		case chunk, ok := <-sub.ch:
			if !ok {
				return finalizeOutput(buf.String(), cmd)
			}
			buf.Write(chunk)
			// The prompt reappears once the command finishes.
			if promptRe.MatchString(stripANSI(buf.String())) {
				// Small grace period for any trailing bytes.
				time.Sleep(60 * time.Millisecond)
				for {
					select {
					case c2, ok2 := <-sub.ch:
						if ok2 {
							buf.Write(c2)
							continue
						}
					default:
					}
					break
				}
				return finalizeOutput(buf.String(), cmd)
			}
		case <-deadline:
			return finalizeOutput(buf.String(), cmd) + "\n[still running — moved on]"
		}
	}
}

// finalizeOutput strips the echoed command line and the trailing prompt, leaving
// just the command's output (capped so a huge dump doesn't blow the context).
func finalizeOutput(raw, cmd string) string {
	s := stripANSI(raw)
	// Drop the trailing prompt line.
	if loc := promptRe.FindStringIndex(s); loc != nil {
		s = s[:loc[0]]
	}
	// Drop the first line if it's the echoed command.
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		first := strings.TrimSpace(s[:i])
		if first == strings.TrimSpace(cmd) || strings.HasSuffix(first, cmd) {
			s = s[i+1:]
		}
	}
	s = strings.Trim(s, "\r\n")
	if len(s) > 6000 {
		s = s[:6000] + "\n…(truncated)"
	}
	if s == "" {
		return "(no output)"
	}
	return s
}

func userTextMessage(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"role": "user", "content": text})
	return b
}

func textToolResult(id, content string, isErr bool) json.RawMessage {
	m := map[string]any{"type": "tool_result", "tool_use_id": id, "content": content}
	if isErr {
		m["is_error"] = true
	}
	b, _ := json.Marshal(m)
	return b
}
