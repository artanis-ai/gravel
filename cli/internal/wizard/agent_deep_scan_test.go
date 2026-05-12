package wizard

import (
	"strings"
	"testing"
)

// agent_deep_scan_test.go covers the agent integration's parser. The
// agent's JSONL output is one of the few places the wizard has to
// trust untrusted data (claude/codex stdout); any wobble here drops
// findings on the floor or breaks the review loop.
//
// We don't test spawnAgent end-to-end — that'd require Claude Code or
// Codex installed in CI. Each helper IS unit-testable.

func TestParseFindings_HappyPath(t *testing.T) {
	stdout := `Some preamble line.
{"path":"src/agents/triage.ts","lineStart":12,"lineEnd":28,"varName":"SYSTEM","snippet":"You are…"}
{"path":"lib/prompts.py","lineStart":1,"lineEnd":40}
###DONE###
ignored trailing output
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 2 {
		t.Fatalf("expected 2 findings, got %d: %+v", len(got), got)
	}
	if got[0].Path != "src/agents/triage.ts" || got[0].LineStart != 12 || got[0].LineEnd != 28 {
		t.Errorf("first finding wrong: %+v", got[0])
	}
	if got[0].VarName != "SYSTEM" {
		t.Errorf("VarName not parsed: %+v", got[0])
	}
	if got[1].Path != "lib/prompts.py" {
		t.Errorf("second finding wrong: %+v", got[1])
	}
	if len(errs) != 0 {
		t.Errorf("unexpected parser errors: %v", errs)
	}
}

func TestParseFindings_StopsAtDoneMarker(t *testing.T) {
	stdout := `{"path":"a.py","lineStart":1,"lineEnd":2}
###DONE###
{"path":"b.py","lineStart":1,"lineEnd":2}
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 || got[0].Path != "a.py" {
		t.Errorf("findings after ###DONE### should be dropped, got %+v", got)
	}
}

func TestParseFindings_StripsAnsiEscapes(t *testing.T) {
	// Claude Code wraps its output in ANSI cursor codes; parseFindings
	// must strip them before trying to JSON-decode.
	stdout := "\x1b[2K\x1b[1A{\"path\":\"a.py\",\"lineStart\":1,\"lineEnd\":5}\x1b[0m\n###DONE###\n"
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 || got[0].Path != "a.py" {
		t.Errorf("ANSI not stripped, got: %+v errs=%v", got, errs)
	}
}

func TestParseFindings_IgnoresNonJSONLines(t *testing.T) {
	stdout := `Welcome to Claude Code v1.0!
Using model: claude-opus-4-7
Scanning project...
{"path":"a.py","lineStart":1,"lineEnd":2}
Tool: Read(src/main.py)
{"path":"b.py","lineStart":1,"lineEnd":2}
###DONE###
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 2 {
		t.Errorf("non-JSON banner lines should be silently skipped, got %d: %+v", len(got), got)
	}
	if len(errs) != 0 {
		t.Errorf("plain text lines should NOT generate parser errors, got: %v", errs)
	}
}

func TestParseFindings_MalformedJSON_GoesToErrors(t *testing.T) {
	stdout := `{"path":"a.py","lineStart":1,"lineEnd":2}
{"path": broken
###DONE###
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 {
		t.Errorf("expected 1 valid finding survives, got %d", len(got))
	}
	if len(errs) != 1 {
		t.Errorf("expected 1 parse error, got %d: %v", len(errs), errs)
	}
	if !strings.Contains(errs[0], "bad JSON") {
		t.Errorf("error message should mention JSON, got: %s", errs[0])
	}
}

func TestParseFindings_RejectsInvalidLineRange(t *testing.T) {
	// LineEnd < LineStart or LineStart < 1: silently drop, neither
	// parse error nor included.
	stdout := `{"path":"a.py","lineStart":0,"lineEnd":5}
{"path":"b.py","lineStart":10,"lineEnd":5}
{"path":"c.py","lineStart":1,"lineEnd":2}
###DONE###
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 || got[0].Path != "c.py" {
		t.Errorf("invalid line ranges should be dropped, got %+v", got)
	}
}

func TestParseFindings_RejectsEmptyPath(t *testing.T) {
	stdout := `{"path":"","lineStart":1,"lineEnd":2}
{"path":"good.py","lineStart":1,"lineEnd":2}
###DONE###
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 || got[0].Path != "good.py" {
		t.Errorf("empty-path findings should be dropped, got %+v", got)
	}
}

func TestParseFindings_NormalisesBackslashToForwardSlash(t *testing.T) {
	// Agent on Windows may emit `src\agents\foo.ts`. We store paths
	// with forward slashes everywhere in the manifest.
	stdout := `{"path":"src\\agents\\foo.ts","lineStart":1,"lineEnd":2}
###DONE###
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 || got[0].Path != "src/agents/foo.ts" {
		t.Errorf("backslashes not normalised, got: %+v", got)
	}
}

func TestParseFindings_NoDoneMarker_StillReturnsParsedLines(t *testing.T) {
	// If the agent dies before printing ###DONE###, we still want the
	// findings it managed to emit.
	stdout := `{"path":"a.py","lineStart":1,"lineEnd":2}
{"path":"b.py","lineStart":3,"lineEnd":4}
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 2 {
		t.Errorf("expected 2 findings even without ###DONE###, got %d", len(got))
	}
}

func TestParseFindings_EmptyInput(t *testing.T) {
	var errs []string
	got := parseFindings("", &errs)
	if len(got) != 0 {
		t.Errorf("empty input should yield 0 findings, got %d", len(got))
	}
}

func TestParseFindings_WhitespaceTolerant(t *testing.T) {
	// Lines with leading/trailing whitespace + blank lines around
	// the JSON must still parse.
	stdout := `

    {"path":"a.py","lineStart":1,"lineEnd":2}

    ###DONE###
`
	var errs []string
	got := parseFindings(stdout, &errs)
	if len(got) != 1 {
		t.Errorf("whitespace tolerance failed, got: %+v errs=%v", got, errs)
	}
}

// --- agent menu / pickAgent --------------------------------------------------

func TestAgentMenuLabel_BothAvailable(t *testing.T) {
	menu, label := agentMenuLabel(AgentAvailability{Claude: true, Codex: true})
	if menu != "[a/m/d]" {
		t.Errorf("menu = %q, want [a/m/d]", menu)
	}
	if !strings.Contains(label, "Claude Code") || !strings.Contains(label, "Codex") {
		t.Errorf("label missing one of the agents: %q", label)
	}
}

func TestAgentMenuLabel_ClaudeOnly(t *testing.T) {
	menu, label := agentMenuLabel(AgentAvailability{Claude: true})
	if menu != "[a/m/d]" || !strings.Contains(label, "Claude Code") {
		t.Errorf("claude-only menu/label wrong: %q / %q", menu, label)
	}
	if strings.Contains(label, "Codex") {
		t.Errorf("label mentions Codex when only Claude detected")
	}
}

func TestAgentMenuLabel_CodexOnly(t *testing.T) {
	menu, label := agentMenuLabel(AgentAvailability{Codex: true})
	if menu != "[a/m/d]" || !strings.Contains(label, "Codex") {
		t.Errorf("codex-only menu/label wrong: %q / %q", menu, label)
	}
}

func TestAgentMenuLabel_NeitherInstalled(t *testing.T) {
	menu, label := agentMenuLabel(AgentAvailability{})
	if menu != "[m/d]" {
		t.Errorf("menu = %q, want [m/d] (no agent option)", menu)
	}
	if label != "" {
		t.Errorf("label should be empty when no agent installed, got %q", label)
	}
}
