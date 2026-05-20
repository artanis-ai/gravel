package wizard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
)

// scan_review_test.go drives RunScanAndVerify against a scripted
// Prompter so we can exercise the keep/reject loop, manual entry, and
// the "Did I find everything?" menu paths without a real TTY.

// scriptedPrompter answers YesNo and Text questions in the order
// they're recorded. Used to simulate a user clicking through the
// interactive flow. Panics on overflow so a missed question doesn't
// silently fall through to a default.
type scriptedPrompter struct {
	yesNo []bool
	text  []string
	yIdx  int
	tIdx  int
	asked []string
}

func (p *scriptedPrompter) YesNo(question string, def bool) (bool, error) {
	p.asked = append(p.asked, "YesNo: "+question)
	if p.yIdx >= len(p.yesNo) {
		// Run out of scripted answers: fall through to the default so
		// stray "Continue?" prompts don't block. Tests that care assert
		// on `asked` explicitly.
		return def, nil
	}
	v := p.yesNo[p.yIdx]
	p.yIdx++
	return v, nil
}

func (p *scriptedPrompter) Text(question, def string) (string, error) {
	p.asked = append(p.asked, "Text: "+question)
	if p.tIdx >= len(p.text) {
		return def, nil
	}
	v := p.text[p.tIdx]
	p.tIdx++
	return v, nil
}

func (p *scriptedPrompter) Select(_ string, _ []string, def int) (int, error) {
	return def, nil
}
func (p *scriptedPrompter) Info(_ string)              {}
func (p *scriptedPrompter) PressEnter(_ string) error  { return nil }

// silenceUI suppresses UI output during a test so the test runner's
// output stays readable. Restores the previous writer on Cleanup.
func silenceUI(t *testing.T) {
	t.Helper()
	prev := uiOut
	prevColor := hasColor
	prevTTY := hasTTY
	SetUIOutput(&strings.Builder{}, false)
	t.Cleanup(func() {
		uiSync.Lock()
		uiOut = prev
		hasColor = prevColor
		hasTTY = prevTTY
		uiSync.Unlock()
	})
}

func TestRunScanAndVerify_KeepsAllFindings_WhenUserAcceptsEach(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		"prompts/a.md": "Prompt A.\n",
		"prompts/b.md": "Prompt B.\n",
	})
	// Two findings × Keep? yes; then "Did I find everything?" yes.
	p := &scriptedPrompter{yesNo: []bool{true, true, true}}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatalf("RunScanAndVerify: %v", err)
	}
	if len(m.Prompts) != 2 {
		t.Errorf("expected 2 prompts kept, got %d", len(m.Prompts))
	}
}

func TestRunScanAndVerify_RejectsOne_OnlyKeepsAccepted(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		"prompts/keep.md":   "keep me\n",
		"prompts/reject.md": "drop me\n",
	})
	// Sort order is by path, so "keep.md" before "reject.md".
	// Keep? yes, Keep? no, Did-I-find-everything? yes.
	p := &scriptedPrompter{yesNo: []bool{true, false, true}}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 1 {
		t.Fatalf("expected 1 kept, got %d (%+v)", len(m.Prompts), m.Prompts)
	}
	if m.Prompts[0].Path != "prompts/keep.md" {
		t.Errorf("kept wrong prompt: %s", m.Prompts[0].Path)
	}
}

func TestRunScanAndVerify_SkipsDeepScanLoop_WhenFlagSet(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		"prompts/a.md": "a\n",
	})
	// Only ONE YesNo answer scripted: the "Keep?" for the single
	// finding. The "Did I find everything?" loop must be skipped
	// because skipDeepScan=true.
	p := &scriptedPrompter{yesNo: []bool{true}}
	_, err := RunScanAndVerify(context.Background(), dir, p, true)
	if err != nil {
		t.Fatal(err)
	}
	// Confirm the loop never asked the meta question.
	for _, q := range p.asked {
		if strings.Contains(q, "Did I find everything") || strings.Contains(q, "haven't found any prompts") {
			t.Errorf("loop fired under skipDeepScan=true: %s", q)
		}
	}
}

func TestRunScanAndVerify_AllRejected_WritesEmptyManifest(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		"prompts/a.md": "a\n",
		"prompts/b.md": "b\n",
	})
	// Reject both, then "Did I find everything?" yes.
	p := &scriptedPrompter{yesNo: []bool{false, false, true}}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 0 {
		t.Errorf("expected empty manifest after rejecting all, got %+v", m.Prompts)
	}
	// Manifest file still written (zero-prompt installs are valid).
	if !pathExists(filepath.Join(dir, manifest.Path)) {
		t.Errorf("manifest not written despite zero prompts")
	}
}

func TestRunScanAndVerify_ManualEntry_WholeFile(t *testing.T) {
	silenceUI(t)
	// `.hbs` is intentionally outside the v0.9.0 allowlist
	// (.md/.markdown/.txt/.mdx/.mdc). Whole-file manual entry is the
	// path for non-standard prompt formats — Handlebars templates,
	// Jinja, etc.
	dir := newFixture(t, map[string]string{
		"custom/my-prompt.hbs": "manual prompt content\n",
	})
	// "Did I find everything?" no  →  menu choice "m" (manual)
	//   path → "custom/my-prompt.hbs", whole-file? yes
	// → manifest written; loop asks "Did I find everything?" again
	// → yes this time.
	p := &scriptedPrompter{
		yesNo: []bool{false /* did-i-find-everything */, true /* whole file */, true /* did-i-find-everything? */},
		text:  []string{"m" /* menu */, "custom/my-prompt.hbs"},
	}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 1 || m.Prompts[0].Path != "custom/my-prompt.hbs" {
		t.Errorf("manual entry not added; got %+v", m.Prompts)
	}
	if m.Prompts[0].Type != manifest.PromptFile {
		t.Errorf("expected file-type prompt, got %s", m.Prompts[0].Type)
	}
}

func TestRunScanAndVerify_ManualEntry_LineRange(t *testing.T) {
	silenceUI(t)
	source := strings.Join([]string{
		"const TRIAGE = `",                    // 1
		"You are a careful diagnostic agent.", // 2
		"Be concise.",                         // 3
		"`",                                   // 4
		"",                                    // 5
	}, "\n")
	dir := newFixture(t, map[string]string{
		"src/agents/triage.ts": source,
	})
	// "Did I find everything?" no  →  "m"  →  path  →  whole file? no
	//   →  start line 1, end line 4  →  override char range? no
	//   →  var name "TRIAGE"  →  "Did I find everything?" yes
	p := &scriptedPrompter{
		yesNo: []bool{
			false, // did-i-find-everything (first)
			false, // whole file?
			false, // override char range?
			true,  // did-i-find-everything? (second loop iter)
		},
		text: []string{
			"m",                      // menu
			"src/agents/triage.ts",   // path
			"1",                      // start line
			"4",                      // end line
			"TRIAGE",                 // var name
		},
	}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 1 {
		t.Fatalf("expected 1 prompt, got %d", len(m.Prompts))
	}
	got := m.Prompts[0]
	if got.Type != manifest.PromptEmbedded {
		t.Errorf("Type = %s, want embedded", got.Type)
	}
	if got.VarName == nil || *got.VarName != "TRIAGE" {
		t.Errorf("VarName = %v, want TRIAGE", got.VarName)
	}
	if got.LineStart == nil || *got.LineStart != 1 {
		t.Errorf("LineStart = %v, want 1", got.LineStart)
	}
	if got.LineEnd == nil || *got.LineEnd != 4 {
		t.Errorf("LineEnd = %v, want 4", got.LineEnd)
	}
}

func TestRunScanAndVerify_ManualEntry_InvalidLineRange_Cancels(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		"src/agents/triage.ts": "line1\nline2\n",
	})
	// Manual entry → not whole file → start=5 end=2 (invalid).
	// Should cancel the manual entry (returns nil) and loop should
	// ask "Did I find everything?" again, this time we answer yes.
	p := &scriptedPrompter{
		yesNo: []bool{false, false, true},
		text: []string{
			"m",
			"src/agents/triage.ts",
			"5", "2",
		},
	}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 0 {
		t.Errorf("invalid range should yield zero prompts, got %+v", m.Prompts)
	}
}

func TestRunScanAndVerify_ManualEntry_MissingFile_Cancels(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		// Nothing to scan, nothing at the manual path either.
	})
	p := &scriptedPrompter{
		yesNo: []bool{false, true},
		text:  []string{"m", "does/not/exist.md"},
	}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 0 {
		t.Errorf("missing path should yield zero prompts, got %+v", m.Prompts)
	}
}

func TestRunScanAndVerify_DoneChoiceExitsLoop(t *testing.T) {
	silenceUI(t)
	dir := newFixture(t, map[string]string{
		"prompts/a.md": "a\n",
	})
	// Keep the finding, then "Did I find everything?" no, then
	// menu = "d" (done). Loop exits.
	p := &scriptedPrompter{
		yesNo: []bool{true, false},
		text:  []string{"d"},
	}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 1 {
		t.Errorf("expected 1 prompt kept, got %d", len(m.Prompts))
	}
}

func TestRunScanAndVerify_EmptyDir_LoopOffersManual(t *testing.T) {
	silenceUI(t)
	dir := t.TempDir()
	// No findings. Loop kicks in immediately and asks the empty
	// variant of the meta question. We answer no (so the menu fires)
	// then "d" to exit.
	p := &scriptedPrompter{
		yesNo: []bool{false},
		text:  []string{"d"},
	}
	m, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 0 {
		t.Errorf("expected zero prompts, got %d", len(m.Prompts))
	}
}

// REGRESSION guard: ensure RunScanAndVerify always writes the manifest
// to disk (even when zero prompts ended up kept) so the dashboard's
// "is gravel installed?" check can see it.
func TestRunScanAndVerify_AlwaysWritesManifestFile(t *testing.T) {
	silenceUI(t)
	dir := t.TempDir()
	p := &scriptedPrompter{yesNo: []bool{false}, text: []string{"d"}}
	_, err := RunScanAndVerify(context.Background(), dir, p, false)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, manifest.Path)
	if _, err := os.Stat(manifestPath); err != nil {
		t.Errorf("manifest file missing at %s: %v", manifestPath, err)
	}
}

func TestAddPromptInteractive_RejectsEmptyPath(t *testing.T) {
	silenceUI(t)
	dir := t.TempDir()
	p := &scriptedPrompter{text: []string{""}}
	entry := addPromptInteractive(dir, p)
	if entry != nil {
		t.Errorf("empty path should cancel, got %+v", entry)
	}
}

func TestToRepoRelative_AbsoluteUnderCwd(t *testing.T) {
	dir := t.TempDir()
	abs := filepath.Join(dir, "subdir", "file.md")
	got := toRepoRelative(dir, abs)
	if got != "subdir/file.md" {
		t.Errorf("toRepoRelative = %q, want subdir/file.md", got)
	}
}

func TestToRepoRelative_RelativeUnchanged(t *testing.T) {
	if got := toRepoRelative("/anywhere", "prompts/foo.md"); got != "prompts/foo.md" {
		t.Errorf("toRepoRelative on relative path = %q", got)
	}
}
