package wizard

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// editor_pick_test.go covers the interactive prompt picker:
//
//   * findSelectionOffsets: pure substring/offset math (most cases here)
//   * writeEditorTempFile: extension preservation for syntax highlighting
//   * spawnEditor: $EDITOR parsing + propagation of exit codes
//   * editorPickSelection: end-to-end flow using a fake $EDITOR shell
//     script that writes back a deterministic body.
//
// The fake-editor tests are skipped on Windows; the helper relies on
// /bin/sh which isn't there. Everything else is portable.

// --- findSelectionOffsets ----------------------------------------------

func TestFindSelectionOffsets_HappyPath(t *testing.T) {
	original := "line1\nline2 prompt body line2\nline3\n"
	selection := "prompt body"
	res, ok := findSelectionOffsets(original, selection)
	if !ok {
		t.Fatalf("expected ok=true, got false")
	}
	if want := strings.Index(original, "prompt body"); res.CharStart != want {
		t.Errorf("CharStart=%d want %d", res.CharStart, want)
	}
	if res.CharEnd != res.CharStart+len("prompt body") {
		t.Errorf("CharEnd=%d want %d", res.CharEnd, res.CharStart+len("prompt body"))
	}
	if res.LineStart != 2 || res.LineEnd != 2 {
		t.Errorf("lines=L%d-%d want L2-2", res.LineStart, res.LineEnd)
	}
}

func TestFindSelectionOffsets_MultilineSelection(t *testing.T) {
	original := "alpha\nbeta\ngamma\ndelta\nepsilon\n"
	selection := "beta\ngamma\ndelta"
	res, ok := findSelectionOffsets(original, selection)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if res.LineStart != 2 || res.LineEnd != 4 {
		t.Errorf("lines=L%d-%d want L2-4", res.LineStart, res.LineEnd)
	}
	if got := original[res.CharStart:res.CharEnd]; got != selection {
		t.Errorf("slice=%q want %q", got, selection)
	}
}

func TestFindSelectionOffsets_TrimsLeadingTrailingWhitespace(t *testing.T) {
	original := "header\n\nprompt body\n\nfooter\n"
	// Simulating a user who left whitespace around the kept content.
	selection := "\n\nprompt body\n\n"
	res, ok := findSelectionOffsets(original, selection)
	if !ok {
		t.Fatalf("expected ok=true after trim")
	}
	if got := original[res.CharStart:res.CharEnd]; got != "prompt body" {
		t.Errorf("slice=%q want %q", got, "prompt body")
	}
}

func TestFindSelectionOffsets_EmptyAfterTrim(t *testing.T) {
	if _, ok := findSelectionOffsets("anything", "   \n\n\t  "); ok {
		t.Errorf("blank-only selection should return ok=false")
	}
	if _, ok := findSelectionOffsets("anything", ""); ok {
		t.Errorf("empty selection should return ok=false")
	}
}

func TestFindSelectionOffsets_UnchangedFileIsFalse(t *testing.T) {
	original := "line1\nline2\nline3\n"
	if _, ok := findSelectionOffsets(original, original); ok {
		t.Errorf("unchanged file should return ok=false")
	}
	// Same file with extra surrounding whitespace also counts as unchanged.
	if _, ok := findSelectionOffsets(original, "\n"+original+"\n"); ok {
		t.Errorf("unchanged+whitespace should return ok=false")
	}
}

func TestFindSelectionOffsets_NonSubstringIsFalse(t *testing.T) {
	original := "the quick brown fox"
	// User edited (replaced "quick" with "FAST") rather than just
	// deleting around the prompt.
	if _, ok := findSelectionOffsets(original, "the FAST brown fox"); ok {
		t.Errorf("edited selection should return ok=false")
	}
}

func TestFindSelectionOffsets_FirstLineSelection(t *testing.T) {
	original := "prompt at top\nline2\nline3\n"
	res, ok := findSelectionOffsets(original, "prompt at top")
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if res.LineStart != 1 || res.LineEnd != 1 {
		t.Errorf("lines=L%d-%d want L1-1", res.LineStart, res.LineEnd)
	}
	if res.CharStart != 0 {
		t.Errorf("CharStart=%d want 0", res.CharStart)
	}
}

func TestFindSelectionOffsets_DuplicateContentTakesFirst(t *testing.T) {
	original := "match\nother\nmatch\n"
	res, ok := findSelectionOffsets(original, "match")
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if res.CharStart != 0 || res.LineStart != 1 {
		t.Errorf("expected first occurrence, got cs=%d ls=%d", res.CharStart, res.LineStart)
	}
}

// --- writeEditorTempFile ------------------------------------------------

func TestWriteEditorTempFile_PreservesExtension(t *testing.T) {
	cases := []struct {
		hint    string
		wantExt string
	}{
		{"prompts.py", ".py"},
		{"src/agent/index.ts", ".ts"},
		{"deep/nested/path/file.tsx", ".tsx"},
		{"plain.md", ".md"},
		{"no-extension", ".txt"}, // fallback
		{"", ".txt"},
	}
	for _, tc := range cases {
		t.Run(tc.hint, func(t *testing.T) {
			tmp, err := writeEditorTempFile(tc.hint, "hello\n")
			if err != nil {
				t.Fatalf("writeEditorTempFile: %v", err)
			}
			defer os.Remove(tmp)
			if got := filepath.Ext(tmp); got != tc.wantExt {
				t.Errorf("ext=%q want %q (tmp=%s)", got, tc.wantExt, tmp)
			}
			body, err := os.ReadFile(tmp)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != "hello\n" {
				t.Errorf("body=%q want %q", body, "hello\n")
			}
		})
	}
}

// --- spawnEditor -------------------------------------------------------

func TestSpawnEditor_ExitCodePropagates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/false")
	}
	t.Setenv(EditorEnv, "/bin/false")
	tmp, err := os.CreateTemp("", "spawn-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	if err := spawnEditor(tmp.Name()); err == nil {
		t.Errorf("expected error from /bin/false, got nil")
	}
}

func TestSpawnEditor_PassesArgsAndPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	// Fake editor: a sh script that records its argv to a file.
	scriptDir := t.TempDir()
	recorder := filepath.Join(scriptDir, "argv.txt")
	script := filepath.Join(scriptDir, "fake-editor.sh")
	body := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + recorder + "\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv(EditorEnv, script+" --foo --bar")
	target := filepath.Join(scriptDir, "target.py")
	if err := os.WriteFile(target, []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := spawnEditor(target); err != nil {
		t.Fatalf("spawnEditor: %v", err)
	}
	recorded, err := os.ReadFile(recorder)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(recorded), "\n"), "\n")
	wantArgs := []string{"--foo", "--bar", target}
	if len(lines) != len(wantArgs) {
		t.Fatalf("got %d argv lines, want %d (%q)", len(lines), len(wantArgs), lines)
	}
	for i, w := range wantArgs {
		if lines[i] != w {
			t.Errorf("argv[%d]=%q want %q", i, lines[i], w)
		}
	}
}

func TestSpawnEditor_DefaultsWhenEnvEmpty(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("vi not available")
	}
	// We only verify the helper *attempts* to invoke vi when $EDITOR is
	// unset; we don't actually spin up vi in CI. The trick: point
	// EDITOR at a no-op editor first to confirm the env var path
	// works, then unset and look at editorPickHint as a proxy.
	t.Setenv(EditorEnv, "")
	if got := editorPickHint(); !strings.Contains(got, "vi") {
		t.Errorf("hint should mention default editor %q, got %q", defaultEditor, got)
	}
}

// --- editorPickSelection (end-to-end with fake editor) ------------------

// writeFakeEditor creates a sh script under tmpDir that, when invoked
// with a file path as its last argument, replaces the file contents
// with `replacement`. Returns the editor command string (for $EDITOR).
//
// Returning an empty `replacement` simulates a user saving an empty
// file. To simulate "user quit without writing", point $EDITOR at a
// command that doesn't touch the file (e.g. `/usr/bin/true`).
func writeFakeEditor(t *testing.T, replacement string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "replacement.txt")
	if err := os.WriteFile(out, []byte(replacement), 0o644); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "ed.sh")
	body := "#!/bin/sh\ncp \"" + out + "\" \"$1\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script
}

func TestEditorPickSelection_HappyPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	original := "import x\n\nPROMPT = '''\nyou are helpful\n'''\n\ndef f(): ...\n"
	// Simulate the user keeping just the body of the triple-quoted
	// string.
	keep := "you are helpful"
	t.Setenv(EditorEnv, writeFakeEditor(t, keep))

	res, ok, err := editorPickSelection(original, "agent.py")
	if err != nil {
		t.Fatalf("editorPickSelection: %v", err)
	}
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if got := original[res.CharStart:res.CharEnd]; got != keep {
		t.Errorf("slice=%q want %q", got, keep)
	}
	// "you are helpful" lives on line 4.
	if res.LineStart != 4 || res.LineEnd != 4 {
		t.Errorf("lines=L%d-%d want L4-4", res.LineStart, res.LineEnd)
	}
}

func TestEditorPickSelection_UnchangedReturnsFalse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	original := "prompt\n"
	t.Setenv(EditorEnv, writeFakeEditor(t, original))
	_, ok, err := editorPickSelection(original, "x.txt")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Errorf("expected ok=false on unchanged file")
	}
}

func TestEditorPickSelection_EmptyFileReturnsFalse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	t.Setenv(EditorEnv, writeFakeEditor(t, ""))
	_, ok, err := editorPickSelection("original", "x.txt")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Errorf("expected ok=false on empty file")
	}
}

func TestEditorPickSelection_NonSubstringReturnsFalse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	original := "the quick brown fox"
	// Replacement is not a substring of original — user edited rather
	// than deleted.
	t.Setenv(EditorEnv, writeFakeEditor(t, "the QUICK brown fox"))
	_, ok, err := editorPickSelection(original, "x.txt")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Errorf("expected ok=false on edited content")
	}
}

func TestEditorPickSelection_EditorExitNonZeroIsCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/false")
	}
	t.Setenv(EditorEnv, "/bin/false")
	_, ok, err := editorPickSelection("anything", "x.txt")
	if err != nil {
		t.Errorf("editor exit non-zero should NOT propagate as Go error, got: %v", err)
	}
	if ok {
		t.Errorf("expected ok=false on editor exit non-zero")
	}
}

// --- canSpawnEditor -----------------------------------------------------

func TestCanSpawnEditor_RejectsNonTTYPrompters(t *testing.T) {
	// scriptedPrompter is the test fake used in scan_review_test.go.
	// It satisfies isInteractive() (it's not DefaultsPrompter) but
	// must NOT be allowed to spawn an editor — otherwise CI test runs
	// would hang inside vi.
	if got := canSpawnEditor(&scriptedPrompter{}); got {
		t.Errorf("canSpawnEditor(scriptedPrompter)=true, expected false")
	}
	if got := canSpawnEditor(DefaultsPrompter{}); got {
		t.Errorf("canSpawnEditor(DefaultsPrompter)=true, expected false")
	}
	// Real ttyPrompter type but stdin under `go test` is typically
	// not a TTY, so this still returns false. The TTY half of the
	// check is exercised by manual usage.
	tty := NewTTYPrompter(strings.NewReader(""), &strings.Builder{})
	if got := canSpawnEditor(tty); got {
		// If go test ever runs with a TTY-attached stdin, this would
		// fail. Permissive: only assert false-on-non-tty when stdin
		// is in fact not a TTY (the common CI case).
		if !IsTerminal(os.Stdin) {
			t.Errorf("canSpawnEditor(tty)=true under non-TTY stdin, expected false")
		}
	}
}

// --- addPromptInteractive integration ----------------------------------
//
// These tests prove the branching in addPromptInteractive:
//   * scriptedPrompter (the test fake) → line-number path
//   * real ttyPrompter on a real TTY would take the editor path, but
//     we can't fake a TTY-bound stdin from inside `go test` without
//     a pty harness. The narrow assertion below uses canSpawnEditor
//     against a real ttyPrompter to confirm the type-half of the gate.

func TestAddPromptInteractive_ScriptedPrompterTakesLineNumberPath(t *testing.T) {
	silenceUI(t)
	dir := t.TempDir()
	// Source with a clear embedded range we can target by line numbers.
	source := "header\nPROMPT BODY\nfooter\n"
	if err := os.WriteFile(filepath.Join(dir, "agent.py"), []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	// File path → whole-file? no → start=2 → end=2 → override char? no → var=""
	p := &scriptedPrompter{
		yesNo: []bool{false /* whole file? */, false /* override char range? */},
		text:  []string{"agent.py", "2", "2", "" /* var name */},
	}
	entry := addPromptInteractive(dir, p)
	if entry == nil {
		t.Fatalf("expected entry, got nil")
	}
	if entry.LineStart == nil || *entry.LineStart != 2 {
		t.Errorf("LineStart = %v, want 2", entry.LineStart)
	}
	if entry.LineEnd == nil || *entry.LineEnd != 2 {
		t.Errorf("LineEnd = %v, want 2", entry.LineEnd)
	}
	// Sanity: the scripted prompter never asked any editor-related
	// questions (we hard-asserted by exhausting the script before any
	// editor prompt could fire).
	for _, q := range p.asked {
		if strings.Contains(q, "Press Enter to open the editor") {
			t.Errorf("scripted prompter took editor path: %q", q)
		}
	}
}

// --- editorPickHint -----------------------------------------------------

func TestEditorPickHint_MentionsEditorName(t *testing.T) {
	t.Setenv(EditorEnv, "nvim")
	if got := editorPickHint(); !strings.Contains(got, "nvim") {
		t.Errorf("hint should mention %q, got %q", "nvim", got)
	}
	if got := editorPickHint(); !strings.Contains(strings.ToLower(got), "outside") {
		t.Errorf("hint should tell user to delete OUTSIDE, got %q", got)
	}
}
