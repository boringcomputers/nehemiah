package main

// exec.go — deterministic command execution. It prefers the byte-exact vsock
// guest agent. Managed mode returns a typed failure when that agent is unavailable;
// only local/self-hosted mode may fall back to serial for older images.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type execRequest struct {
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

type execResponse struct {
	Output     string `json:"output"` // compatibility: stdout followed by stderr
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   *int   `json:"exit_code"`
	TimedOut   bool   `json:"timed_out"`
	Truncated  bool   `json:"truncated,omitempty"`
	Transport  string `json:"transport,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

const (
	execDefaultTimeout = 30 * time.Second
	execMaxTimeout     = 120 * time.Second
	execOutputCap      = 64 * 1024 // bytes of output returned per exec
)

// The command is wrapped as `( cmd ); echo __EXIT_<nonce>=$?`. The tty echoes
// the literal `$?` back, so `__EXIT_<nonce>=<digits>` only ever matches the
// executed echo — and the per-exec nonce means a sentinel left over from an
// earlier abandoned (timed-out) command can never satisfy this one.

func (s *Server) handleExec(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON: " + err.Error()})
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "command is required"})
		return
	}
	timeout := execDefaultTimeout
	if req.TimeoutSeconds > 0 {
		timeout = min(time.Duration(req.TimeoutSeconds)*time.Second, execMaxTimeout)
	}
	release, ok := s.acquireGuestOperation(w, id)
	if !ok {
		return
	}
	defer release()

	start := time.Now()
	agentResult, agentErr := s.guestAgent().Exec(r.Context(), id, guestExecRequest{
		Command:   req.Command,
		Timeout:   timeout,
		MaxOutput: execOutputCap,
	})
	if agentErr == nil {
		code := agentResult.ExitCode
		stdout, stderr := string(agentResult.Stdout), string(agentResult.Stderr)
		writeJSON(w, http.StatusOK, execResponse{
			Output:     stdout + stderr,
			Stdout:     stdout,
			Stderr:     stderr,
			ExitCode:   &code,
			TimedOut:   agentResult.TimedOut,
			Truncated:  agentResult.Truncated,
			Transport:  "vsock",
			DurationMS: time.Since(start).Milliseconds(),
		})
		return
	}
	if s.cfg.NehemiahMode && !errors.Is(agentErr, ErrGuestAgentUnavailable) {
		writeManagedGuestAgentFailed(w)
		return
	}
	if !errors.Is(agentErr, ErrGuestAgentUnavailable) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "guest agent exec failed: " + agentErr.Error()})
		return
	}
	if s.cfg.NehemiahMode {
		writeManagedGuestAgentUnavailable(w)
		return
	}

	console, lock, ok := s.mgr.ConsoleLock(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}

	// The serial console is a single shared line: a second concurrent writer
	// (another exec, or the terminal agent) would garble both. One at a time.
	if !lock.TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "machine console is busy (another exec or agent is running)"})
		return
	}
	defer lock.Unlock()

	_, sub := console.Subscribe()
	defer console.Unsubscribe(sub)

	// Sentinel prompt so completion detection works on any shell (same trick as
	// the terminal agent).
	if _, err := console.Write([]byte("PS1='" + agentPrompt + "'\n")); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the machine's terminal is unavailable"})
		return
	}
	time.Sleep(300 * time.Millisecond)

	// Subshell so a user `exit` can't kill the console shell; the echo puts the
	// subshell's exit code where the capture can find it.
	var nb [4]byte
	_, _ = rand.Read(nb[:])
	marker := "__EXIT_" + hex.EncodeToString(nb[:])
	wrapped := "( " + req.Command + " ); echo " + marker + "=$?"

	resp := execCapture(console, sub, wrapped, marker, timeout)
	resp.DurationMS = time.Since(start).Milliseconds()
	resp.Transport = "serial"

	// A timed-out command is still running and would hog the console shell for
	// every later exec (their input just queues behind it). Ctrl-C it so the
	// console is usable again the moment we release the lock.
	if resp.TimedOut {
		_, _ = console.Write([]byte{0x03})
	}
	writeJSON(w, http.StatusOK, resp)
}

// execCapture types the wrapped command into the console and collects output
// until the `<marker>=<n>` sentinel (finished) or the deadline (timed out). It
// is runGuestCommand's shape, but parses the sentinel before capping the output
// so large dumps can't eat the exit code.
func execCapture(console *Console, sub *consoleSub, wrapped, marker string, timeout time.Duration) execResponse {
	// `<marker>=<digits>` matches only the executed echo — the tty echo-back of
	// the typed command carries the literal `$?` instead of digits.
	exitRe := regexp.MustCompile(regexp.QuoteMeta(marker) + `=(\d+)`)
	// Drain anything buffered so we only read this command's output.
	for {
		select {
		case <-sub.ch:
			continue
		default:
		}
		break
	}
	if err := writeConsoleChunked(console, wrapped+"\n"); err != nil {
		return execResponse{Output: "", TimedOut: true}
	}

	var buf bytes.Buffer
	deadline := time.After(timeout)
	for {
		select {
		case chunk, ok := <-sub.ch:
			if !ok {
				return execFinalize(buf.String(), marker, exitRe, false)
			}
			buf.Write(chunk)
			if exitRe.MatchString(stripANSI(buf.String())) {
				// Grace period for the trailing prompt bytes.
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
				return execFinalize(buf.String(), marker, exitRe, false)
			}
		case <-deadline:
			return execFinalize(buf.String(), marker, exitRe, true)
		}
	}
}

// execFinalize turns the raw console capture into {output, exit_code, timed_out}:
// strip ANSI, drop the echoed command (everything through the echoed
// `<marker>=$?`), extract the sentinel, trim the trailing prompt, cap the size.
func execFinalize(raw, marker string, exitRe *regexp.Regexp, deadlineHit bool) execResponse {
	s := stripANSI(raw)

	// Drop the echoed command: the typed text ends with the literal `<marker>=$?`,
	// so output starts on the line after it.
	if i := strings.Index(s, marker+"=$?"); i >= 0 {
		if j := strings.IndexByte(s[i:], '\n'); j >= 0 {
			s = s[i+j+1:]
		} else {
			s = ""
		}
	}

	resp := execResponse{TimedOut: deadlineHit}
	if deadlineHit {
		code := guestAgentTimeoutExitCode
		resp.ExitCode = &code
	}
	if m := exitRe.FindStringSubmatchIndex(s); m != nil {
		code, err := strconv.Atoi(s[m[2]:m[3]])
		if err == nil {
			resp.ExitCode = &code
			resp.TimedOut = false
		}
		s = s[:m[0]] // output is everything before the sentinel line
	}

	// Drop a trailing prompt, if the sentinel regex didn't already cut it off.
	if loc := promptRe.FindStringIndex(s); loc != nil {
		s = s[:loc[0]]
	}
	s = strings.Trim(s, "\r\n")
	if len(s) > execOutputCap {
		s = s[:execOutputCap] + "\n…(truncated)"
	}
	resp.Output = s
	resp.Stdout = s // serial cannot distinguish stderr; preserve it as stdout
	return resp
}
