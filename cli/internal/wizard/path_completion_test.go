package wizard

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// path_completion_test.go: pure-ish coverage for CompletePath. The
// raw-mode driver (readPathWithCompletion) would need a pty harness
// to exercise end-to-end; the interesting bugs are in the completion
// math, which this file pins down against a real fs tree under
// t.TempDir().

func makeTree(t *testing.T, paths []string) string {
	t.Helper()
	root := t.TempDir()
	for _, p := range paths {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if p[len(p)-1] == '/' {
			if err := os.MkdirAll(abs, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestCompletePath_UniqueFile_CompletesAndNoSep(t *testing.T) {
	root := makeTree(t, []string{"prompts/system.md"})
	res := CompletePath(root, "prompts/sys")
	if res.Replacement != "prompts/system.md" {
		t.Errorf("Replacement=%q want prompts/system.md", res.Replacement)
	}
	if res.AppendTrailingSep {
		t.Errorf("AppendTrailingSep=true for a file, expected false")
	}
	if len(res.Candidates) != 1 || res.Candidates[0] != "system.md" {
		t.Errorf("Candidates=%v", res.Candidates)
	}
}

func TestCompletePath_UniqueDir_FlagsTrailingSep(t *testing.T) {
	root := makeTree(t, []string{"src/agents/"})
	res := CompletePath(root, "src/age")
	if res.Replacement != "src/agents" {
		t.Errorf("Replacement=%q want src/agents", res.Replacement)
	}
	if !res.AppendTrailingSep {
		t.Errorf("AppendTrailingSep=false for a dir, expected true")
	}
}

func TestCompletePath_MultipleMatches_ExtendsCommonPrefix(t *testing.T) {
	root := makeTree(t, []string{
		"prompts/sys-a.md",
		"prompts/sys-b.md",
		"prompts/other.md",
	})
	res := CompletePath(root, "prompts/sy")
	if res.Replacement != "prompts/sys-" {
		t.Errorf("Replacement=%q want prompts/sys-", res.Replacement)
	}
	// Candidates should contain both sys-* but not "other.md".
	sort.Strings(res.Candidates)
	if len(res.Candidates) != 2 || res.Candidates[0] != "sys-a.md" || res.Candidates[1] != "sys-b.md" {
		t.Errorf("Candidates=%v", res.Candidates)
	}
}

func TestCompletePath_NoMatches_KeepsInput(t *testing.T) {
	root := makeTree(t, []string{"prompts/system.md"})
	res := CompletePath(root, "prompts/zzz")
	if res.Replacement != "prompts/zzz" {
		t.Errorf("Replacement=%q want prompts/zzz (unchanged)", res.Replacement)
	}
	if len(res.Candidates) != 0 {
		t.Errorf("Candidates=%v want empty", res.Candidates)
	}
}

func TestCompletePath_EmptyInput_ListsTopLevel(t *testing.T) {
	root := makeTree(t, []string{
		"alpha.md",
		"beta/",
		"gamma.md",
	})
	res := CompletePath(root, "")
	// Common prefix of "alpha.md", "beta/", "gamma.md" is "" → no
	// extension, but we DO surface candidates for the next Tab.
	if res.Replacement != "" {
		t.Errorf("Replacement=%q want empty (no common prefix)", res.Replacement)
	}
	sort.Strings(res.Candidates)
	want := []string{"alpha.md", "beta/", "gamma.md"}
	if len(res.Candidates) != len(want) {
		t.Fatalf("Candidates=%v want %v", res.Candidates, want)
	}
	for i, w := range want {
		if res.Candidates[i] != w {
			t.Errorf("Candidates[%d]=%q want %q", i, res.Candidates[i], w)
		}
	}
}

func TestCompletePath_DirOnlyInput_ListsContents(t *testing.T) {
	root := makeTree(t, []string{
		"src/a.py",
		"src/b.py",
		"other.md",
	})
	res := CompletePath(root, "src/")
	if res.Replacement != "src/" {
		t.Errorf("Replacement=%q want src/ (just lists contents)", res.Replacement)
	}
	sort.Strings(res.Candidates)
	if len(res.Candidates) != 2 || res.Candidates[0] != "a.py" || res.Candidates[1] != "b.py" {
		t.Errorf("Candidates=%v", res.Candidates)
	}
}

func TestCompletePath_HiddenFilesOnlyWhenLeadingDot(t *testing.T) {
	root := makeTree(t, []string{
		".env",
		".gravel/",
		"normal.md",
	})
	// No leading dot → hidden files filtered out, just "normal.md".
	res := CompletePath(root, "")
	for _, c := range res.Candidates {
		if c == ".env" || c == ".gravel/" {
			t.Errorf("hidden %q surfaced without leading-dot input", c)
		}
	}
	// Leading dot → hidden files included.
	res2 := CompletePath(root, ".")
	got := map[string]bool{}
	for _, c := range res2.Candidates {
		got[c] = true
	}
	if !got[".env"] || !got[".gravel/"] {
		t.Errorf("hidden files missing under leading-dot input: %v", res2.Candidates)
	}
}

func TestCompletePath_DirThatDoesntExist_NoMatches(t *testing.T) {
	root := makeTree(t, []string{"existing/file.md"})
	res := CompletePath(root, "missing/xy")
	if res.Replacement != "missing/xy" {
		t.Errorf("Replacement=%q want missing/xy (unchanged)", res.Replacement)
	}
	if len(res.Candidates) != 0 {
		t.Errorf("Candidates=%v want empty", res.Candidates)
	}
}

func TestCompletePath_NestedCompletion(t *testing.T) {
	root := makeTree(t, []string{"a/b/c/leaf.md"})
	res := CompletePath(root, "a/b/c/le")
	if res.Replacement != "a/b/c/leaf.md" {
		t.Errorf("Replacement=%q want a/b/c/leaf.md", res.Replacement)
	}
}

// --- printCandidates: raw-mode line endings ------------------------------

// Terminal is in raw mode when this runs, so each line MUST end with
// "\r\n" — a bare "\n" would only move the cursor down, leaving each
// candidate indented at the column where the prior one ended (visible
// as a staircase pattern). Pin the line-ending here.
func TestPrintCandidates_UsesCRLF(t *testing.T) {
	var buf bytes.Buffer
	printCandidates(&buf, []string{"alpha.py", "beta.py", "gamma.py"})
	want := "alpha.py\r\nbeta.py\r\ngamma.py\r\n"
	if got := buf.String(); got != want {
		t.Errorf("printCandidates output =\n%q\nwant\n%q", got, want)
	}
}

// --- longestCommonPrefix -------------------------------------------------

func TestLongestCommonPrefix_Cases(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{"foo"}, "foo"},
		{[]string{"foo", "foobar"}, "foo"},
		{[]string{"foo", "bar"}, ""},
		{[]string{"abc", "abd", "abef"}, "ab"},
		{[]string{"identical", "identical"}, "identical"},
	}
	for _, c := range cases {
		if got := longestCommonPrefix(c.in); got != c.want {
			t.Errorf("longestCommonPrefix(%v)=%q want %q", c.in, got, c.want)
		}
	}
}

// --- deletePrevWord ------------------------------------------------------

func TestDeletePrevWord_StepsBackThroughPath(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"foo", ""},
		{"src/agents/triage.py", "src/agents/"},
		{"src/agents/", "src/"},
		{"src/", ""},
		{"a b c", "a b "},
		{"a b ", "a "},
	}
	for _, c := range cases {
		got := string(deletePrevWord([]byte(c.in)))
		if got != c.want {
			t.Errorf("deletePrevWord(%q)=%q want %q", c.in, got, c.want)
		}
	}
}
