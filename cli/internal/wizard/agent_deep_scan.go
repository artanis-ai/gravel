package wizard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
)

// agent_deep_scan.go ports packages/sdk-ts/src/manifest/agent-deep-scan.ts:
// delegate the deep prompt scan to whichever coding agent the user
// has installed locally (Claude Code or Codex). The agent navigates
// the codebase with its own Read/Grep/Glob tools and emits findings
// as JSONL on stdout, terminated by the literal `###DONE###` sentinel.
//
// Why agent-delegation over a file-by-file OpenAI scan: the agent
// already prunes irrelevant files with Glob, costs no extra API key,
// and source code never leaves the user's machine.

// AgentName identifies the coding agent to delegate the scan to.
type AgentName string

const (
	AgentClaude AgentName = "claude"
	AgentCodex  AgentName = "codex"
)

// AgentAvailability reports which agents are installed on the user's
// PATH at the time of the check. Populated by DetectAgents.
type AgentAvailability struct {
	Claude bool
	Codex  bool
}

// AgentDeepScanResult bundles everything DeepScan turned up so the
// caller can run it through the per-entry review loop.
type AgentDeepScanResult struct {
	NewFindings []manifest.Prompt // already-enriched, ready to insert
	Orphans     []AgentFinding    // agent reported these but file was missing / line range invalid
	Errors      []string          // parser hiccups + agent stderr; never fatal
}

// AgentFinding is the raw shape the agent emits per finding (one
// JSON line on stdout).
type AgentFinding struct {
	Path      string `json:"path"`
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
	VarName   string `json:"varName,omitempty"`
	Snippet   string `json:"snippet,omitempty"`
}

// DetectAgents probes the user's PATH for `claude` and `codex`. On
// POSIX this is `command -v <cmd>` falling back to `which`; on
// Windows it's `where`.
func DetectAgents() AgentAvailability {
	return AgentAvailability{
		Claude: hasCommand("claude"),
		Codex:  hasCommand("codex"),
	}
}

func hasCommand(cmd string) bool {
	if runtime.GOOS == "windows" {
		// `where` walks PATH + PATHEXT (.cmd / .exe / .bat) — same
		// resolution npm shims like `claude.cmd` use.
		err := exec.Command("where", cmd).Run()
		return err == nil
	}
	// POSIX: `command -v` is built into sh and is the portable check.
	if err := exec.Command("sh", "-c", "command -v "+shellQuote(cmd)).Run(); err == nil {
		return true
	}
	return exec.Command("which", cmd).Run() == nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// AgentDeepScan delegates the scan to the named agent. It spawns the
// agent's CLI, pipes a long task message via stdin, reads JSONL
// findings off stdout until the `###DONE###` sentinel, then enriches
// each finding into a manifest.Prompt by reading the source file +
// computing char offsets from the agent-reported line range.
//
// Returns AgentDeepScanResult so the caller can show the user each
// finding via the same review loop the fast scan uses. Errors during
// parsing/enrichment land in Result.Errors (never fatal); the only
// hard failure is the agent process refusing to start.
func AgentDeepScan(ctx context.Context, repoRoot string, current manifest.Manifest, agent AgentName) (AgentDeepScanResult, error) {
	known := make(map[string]struct{}, len(current.Prompts))
	for _, p := range current.Prompts {
		known[p.Path] = struct{}{}
	}
	task := renderTaskMessage(known)

	stdout, stderr, exitCode, err := spawnAgent(ctx, agent, task, repoRoot)
	if err != nil {
		return AgentDeepScanResult{}, fmt.Errorf("spawn %s: %w", agent, err)
	}

	result := AgentDeepScanResult{}
	if exitCode != 0 {
		snippet := strings.TrimSpace(stderr)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		result.Errors = append(result.Errors, fmt.Sprintf("agent exited with code %d: %s", exitCode, snippet))
	}

	findings := parseFindings(stdout, &result.Errors)
	for _, f := range findings {
		if _, dup := known[f.Path]; dup {
			continue
		}
		entry, ok := enrichFinding(repoRoot, f)
		if !ok {
			result.Orphans = append(result.Orphans, f)
			continue
		}
		result.NewFindings = append(result.NewFindings, entry)
	}

	// Dedupe by (path, lineStart, lineEnd) — agents occasionally
	// repeat findings across passes.
	seen := make(map[string]struct{}, len(result.NewFindings))
	deduped := result.NewFindings[:0]
	for _, e := range result.NewFindings {
		key := fmt.Sprintf("%s:%d:%d", e.Path, *e.LineStart, *e.LineEnd)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, e)
	}
	result.NewFindings = deduped
	sort.Slice(result.NewFindings, func(i, j int) bool {
		return result.NewFindings[i].Path < result.NewFindings[j].Path
	})
	return result, nil
}

// spawnAgent runs the agent with its right flags + stdin-fed task,
// captures stdout/stderr/exit-code, and enforces a 5-minute timeout.
// Pipes the task in via stdin rather than argv so multi-KB prompts
// don't trip shell argv-length limits + so we don't have to escape
// quotes/backticks for argv handling.
func spawnAgent(ctx context.Context, agent AgentName, task, cwd string) (stdout, stderr string, exitCode int, err error) {
	args := agentArgs(agent)
	if args == nil {
		return "", "", 0, fmt.Errorf("unsupported agent: %s", agent)
	}

	timeout := 5 * time.Minute
	scanCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(scanCtx, string(agent), args...)
	cmd.Dir = cwd
	cmd.Stdin = strings.NewReader(task)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return outBuf.String(), errBuf.String(), exitErr.ExitCode(), nil
		}
		if errors.Is(scanCtx.Err(), context.DeadlineExceeded) {
			return outBuf.String(), errBuf.String() + fmt.Sprintf("\n[gravel] agent exceeded %s; killed.", timeout), 124, nil
		}
		return outBuf.String(), errBuf.String(), -1, err
	}
	return outBuf.String(), errBuf.String(), 0, nil
}

// agentArgs returns the right CLI flags for each agent. Both read the
// prompt from stdin when no positional argument is supplied.
func agentArgs(agent AgentName) []string {
	switch agent {
	case AgentClaude:
		// Restrict tools so the scan can't write/modify; keep normal
		// auth context (skipping --bare etc.) because users logged in
		// via `claude /login` need their keychain creds.
		return []string{
			"-p",
			"--output-format", "text",
			"--allowed-tools", "Read Grep Glob",
			"--permission-mode", "bypassPermissions",
		}
	case AgentCodex:
		// `codex exec` runs a single task non-interactively, sandboxed.
		return []string{"exec"}
	}
	return nil
}

// renderTaskMessage is the prompt we pipe to the agent. Identical
// in spirit to the TS reference — JSONL findings + ###DONE### sentinel,
// rigid format because we need parseable output, not chatter.
func renderTaskMessage(known map[string]struct{}) string {
	skip := "None."
	if len(known) > 0 {
		paths := make([]string, 0, len(known))
		for p := range known {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		var b strings.Builder
		for _, p := range paths {
			b.WriteString("- ")
			b.WriteString(p)
			b.WriteByte('\n')
		}
		skip = strings.TrimRight(b.String(), "\n")
	}
	return strings.Join([]string{
		"# Deep prompt scan",
		"",
		"Find every \"prompt\" embedded in this codebase. A prompt is a string",
		"literal or template that's used as a system / user / assistant message",
		"to an LLM call (OpenAI, Anthropic, LangChain, Vercel AI, raw fetch to",
		"an LLM endpoint). Examples:",
		"",
		"  const SYSTEM_PROMPT = \"You are a careful triage assistant...\"",
		"  messages: [{ role: \"system\", content: `Translate to Spanish: ...` }]",
		"  await openai.chat.completions.create({ messages: [{role: \"user\", content: prompt}] })",
		"",
		"## Steps",
		"",
		"1. Use Glob to find candidate files. Look in: src/, lib/, app/, server/,",
		"   packages/, api/, agents/. Skip: node_modules/, dist/, build/, .next/,",
		"   __pycache__/, .venv/, venv/, .git/, **/__tests__/**, **/*.test.*,",
		"   **/*.spec.*.",
		"",
		"2. Use Read/Grep on candidates to identify prompt-like string literals.",
		"   Skim, don't deep-dive; false positives are fine, false negatives are",
		"   the cost.",
		"",
		"3. For each prompt you find, output ONE line of JSON to stdout (no",
		"   prefix or explanation around it):",
		"",
		`   {"path":"src/agents/triage.ts","lineStart":12,"lineEnd":28,"varName":"SYSTEM_PROMPT","snippet":"You are a careful..."}`,
		"",
		"4. After ALL findings, output exactly this on its own line:",
		"   ###DONE###",
		"",
		"## Constraints",
		"",
		"- Paths must be relative to the repo root, forward slashes.",
		"- \"lineStart\" is 1-indexed, inclusive. \"lineEnd\" is the last line of the",
		"  prompt, inclusive.",
		"- \"varName\" is best-effort; null is fine if there's no obvious name.",
		"- \"snippet\" is the first ~80 characters of the prompt content (escape",
		"  control chars; one line).",
		"- Skip prompts shorter than ~30 characters (those are probably labels,",
		"  not prompts).",
		"- Do NOT emit anything other than JSONL findings + the final ###DONE###",
		"  line. No commentary, no headers.",
		"",
		"## Already-tracked prompts (skip these)",
		"",
		skip,
	}, "\n")
}

var ansiInAgentRE = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// parseFindings reads the agent's stdout line by line, decoding JSONL
// findings up to the `###DONE###` sentinel. Lines that don't parse get
// dropped (with a note in errors); anything before the first '{' is
// ignored so cleared-screen / prompt-banner output from the agent
// doesn't break parsing.
func parseFindings(stdout string, errs *[]string) []AgentFinding {
	cleaned := ansiInAgentRE.ReplaceAllString(stdout, "")
	out := []AgentFinding{}
	for _, line := range strings.Split(cleaned, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if trimmed == "###DONE###" {
			break
		}
		if !strings.HasPrefix(trimmed, "{") {
			continue
		}
		var f AgentFinding
		if err := json.Unmarshal([]byte(trimmed), &f); err != nil {
			snippet := trimmed
			if len(snippet) > 120 {
				snippet = snippet[:120]
			}
			*errs = append(*errs, fmt.Sprintf("bad JSON line: %s: %s", snippet, err))
			continue
		}
		if f.Path == "" || f.LineStart < 1 || f.LineEnd < f.LineStart {
			continue
		}
		// Force forward slashes so a Windows agent's output (`src\foo.ts`)
		// normalises cross-platform. filepath.ToSlash is a no-op on Linux
		// because backslash isn't the OS separator there; an explicit
		// replace works on every host.
		f.Path = strings.ReplaceAll(f.Path, "\\", "/")
		out = append(out, f)
	}
	return out
}

// enrichFinding turns an agent-reported line range into a fully-baked
// manifest.Prompt: reads the file, computes char offsets via
// LineToCharOffset, hashes the slice, mints a stable id. Returns
// (entry, false) when the file is missing or the line range falls
// past EOF — the caller surfaces those as orphans.
func enrichFinding(repoRoot string, f AgentFinding) (manifest.Prompt, bool) {
	abs := filepath.Join(repoRoot, filepath.FromSlash(f.Path))
	body, err := readFile(abs)
	if err != nil {
		return manifest.Prompt{}, false
	}
	text := body
	cs := manifest.LineToCharOffset(text, f.LineStart-1)
	if cs < 0 {
		return manifest.Prompt{}, false
	}
	ce := manifest.LineToCharOffset(text, f.LineEnd)
	if ce <= cs {
		return manifest.Prompt{}, false
	}
	slice := text[cs:ce]
	ls, le := f.LineStart, f.LineEnd
	charStart, charEnd := cs, ce
	entry := manifest.Prompt{
		ID:        manifest.GeneratePromptID(fmt.Sprintf("%s:%d:%d:%s", f.Path, f.LineStart, f.LineEnd, f.VarName), -1),
		Type:      manifest.PromptEmbedded,
		Path:      f.Path,
		Hash:      manifest.HashPrompt(slice),
		LineStart: &ls,
		LineEnd:   &le,
		CharStart: &charStart,
		CharEnd:   &charEnd,
	}
	if f.VarName != "" {
		v := f.VarName
		entry.VarName = &v
	}
	return entry, true
}

// runAgentSearchAndReview is the menu-driven entry-point: pick the
// agent, run the scan with a spinner, then run findings through the
// review loop. Returns (manifest, true) on success; (zero, false)
// when the user can't or won't pick an agent or the scan fails hard.
func runAgentSearchAndReview(ctx context.Context, cwd string, p Prompter, current manifest.Manifest, av AgentAvailability) (manifest.Manifest, bool) {
	chosen, ok := pickAgent(av, p)
	if !ok {
		if !av.Claude && !av.Codex {
			Note("(No coding agent detected. Install Claude Code (https://claude.com/code) or Codex (https://github.com/openai/codex) and re-run.)")
		}
		return current, false
	}
	label := "Claude Code"
	if chosen == AgentCodex {
		label = "Codex"
	}
	sp := NewSpinner(fmt.Sprintf("Scanning with %s (this can take a minute)…", label))
	res, err := AgentDeepScan(ctx, cwd, current, chosen)
	if err != nil {
		sp.Fail(fmt.Sprintf("Deep scan failed: %s", err))
		return current, false
	}
	sp.Stop(fmt.Sprintf("%s returned %d new finding(s)", label, len(res.NewFindings)))
	for i, e := range res.Errors {
		if i >= 3 {
			break
		}
		Note("  agent note: " + e)
	}
	if len(res.NewFindings) == 0 {
		return current, true
	}
	// Same per-entry review applies.
	accepted := append([]manifest.Prompt(nil), current.Prompts...)
	for i, f := range res.NewFindings {
		if reviewPrompt(cwd, f, i+1, len(res.NewFindings), p) {
			accepted = append(accepted, f)
		}
	}
	sort.Slice(accepted, func(i, j int) bool { return accepted[i].Path < accepted[j].Path })
	current.Prompts = accepted
	return current, true
}

// pickAgent: if both are available, ask which one. Otherwise, return
// whichever single agent is on PATH.
func pickAgent(av AgentAvailability, p Prompter) (AgentName, bool) {
	switch {
	case av.Claude && av.Codex:
		useClaude, err := p.YesNo("Use "+Bold("Claude Code")+"? "+Dim("(n = Codex)"), true)
		if err != nil {
			return "", false
		}
		if useClaude {
			return AgentClaude, true
		}
		return AgentCodex, true
	case av.Claude:
		return AgentClaude, true
	case av.Codex:
		return AgentCodex, true
	}
	return "", false
}

// readFile lives in fileio.go.
