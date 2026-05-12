package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- hash + normalize -------------------------------------------------------

func TestNormalize(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"CRLF to LF", "a\r\nb\r\nc", "a\nb\nc"},
		{"CR to LF", "a\rb\rc", "a\nb\nc"},
		{"trailing whitespace stripped", "a   \nb\t\nc", "a\nb\nc"},
		{"leading + trailing blank lines stripped", "\n\n  \nfoo\n\n  \n", "foo"},
		{"plain string passes through", "hello", "hello"},
		{"empty string normalizes to empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.in); got != tc.want {
				t.Errorf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestHashPrompt_StableAcrossCosmeticChanges(t *testing.T) {
	a := HashPrompt("hello\nworld")
	b := HashPrompt("hello \nworld\n")
	c := HashPrompt("hello\r\nworld\r\n")
	if a != b || a != c {
		t.Errorf("cosmetic-change hashes diverged: %s %s %s", a, b, c)
	}
}

func TestHashPrompt_ChangesOnContentChange(t *testing.T) {
	if HashPrompt("hello") == HashPrompt("goodbye") {
		t.Fatal("different content produced the same hash")
	}
}

func TestHashPrompt_FormatTaggedSHA256(t *testing.T) {
	h := HashPrompt("anything")
	if !strings.HasPrefix(h, "sha256:") {
		t.Errorf("hash missing sha256 prefix: %s", h)
	}
	if len(h) != len("sha256:")+64 {
		t.Errorf("expected sha256 to be 64 hex chars, got %d", len(h))
	}
}

func TestGeneratePromptID_Format(t *testing.T) {
	id := GeneratePromptID("prompts/foo.md", -1)
	if !strings.HasPrefix(id, "p_") {
		t.Errorf("id missing p_ prefix: %s", id)
	}
	if len(id) != 2+12 {
		t.Errorf("expected 14-char id, got %q (len %d)", id, len(id))
	}
}

func TestGeneratePromptID_Unique(t *testing.T) {
	seen := make(map[string]struct{}, 1024)
	for i := 0; i < 1024; i++ {
		id := GeneratePromptID("prompts/foo.md", i)
		if _, dup := seen[id]; dup {
			t.Fatalf("collision after %d iterations: %s", i, id)
		}
		seen[id] = struct{}{}
	}
}

// --- IO round-trip ----------------------------------------------------------

func TestRead_MissingReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	m, err := Read(dir)
	if err != nil {
		t.Fatalf("Read on missing file should succeed, got %v", err)
	}
	if m.Version != Version || len(m.Prompts) != 0 {
		t.Errorf("expected empty manifest, got %+v", m)
	}
}

func TestRead_RejectsUnknownVersion(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".gravel"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"version": 999, "lastFullScanCommit": null, "lastFullScanAt": null, "prompts": []}`)
	if err := os.WriteFile(filepath.Join(dir, ".gravel", "manifest.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Read(dir)
	if err == nil {
		t.Fatal("expected error for unknown version, got nil")
	}
	if !strings.Contains(err.Error(), "999") {
		t.Errorf("error should mention unknown version, got %v", err)
	}
}

func TestWriteRead_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	ls, le := 5, 12
	cs, ce := 100, 200
	vn := "SYSTEM_PROMPT"
	original := Manifest{
		Version:            Version,
		LastFullScanCommit: strPtr("abc123"),
		LastFullScanAt:     strPtr("2026-01-01T00:00:00Z"),
		Prompts: []Prompt{
			{ID: "p_aaaa", Type: PromptFile, Path: "prompts/a.md", Hash: "sha256:aaaa"},
			{
				ID: "p_bbbb", Type: PromptEmbedded, Path: "src/agent.ts", Hash: "sha256:bbbb",
				LineStart: &ls, LineEnd: &le, CharStart: &cs, CharEnd: &ce, VarName: &vn,
			},
		},
	}
	if err := Write(dir, original); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := Read(dir)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	a, _ := json.Marshal(original)
	b, _ := json.Marshal(got)
	if string(a) != string(b) {
		t.Errorf("round-trip changed shape:\nwant: %s\ngot:  %s", a, b)
	}
}

func TestWrite_NoHTMLEscape(t *testing.T) {
	// TS's JSON.stringify doesn't HTML-escape; this asserts our
	// encoder configuration matches.
	dir := t.TempDir()
	m := Empty()
	m.Prompts = append(m.Prompts, Prompt{
		ID:   "p_xx",
		Type: PromptFile,
		Path: "prompts/<weird>&name.md",
		Hash: "sha256:xx",
	})
	if err := Write(dir, m); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".gravel", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "prompts/<weird>&name.md") {
		t.Errorf("HTML-escaped output:\n%s", raw)
	}
}

// --- fast scan --------------------------------------------------------------

func TestFastScan_DiscoversNewFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "prompts/welcome.md", "Hello, world.\n")
	writeFile(t, dir, "prompts/farewell.txt", "Goodbye!")
	writeFile(t, dir, "prompts/ignored.json", `{"not": "a prompt"}`)

	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 2 {
		t.Errorf("expected 2 new files, got %d", res.Added)
	}
	if len(res.Manifest.Prompts) != 2 {
		t.Errorf("expected manifest with 2 prompts, got %+v", res.Manifest.Prompts)
	}
	// Sort order asserts deterministic output.
	if res.Manifest.Prompts[0].Path != "prompts/farewell.txt" {
		t.Errorf("expected sorted ordering, got %s first", res.Manifest.Prompts[0].Path)
	}
}

func TestFastScan_DropsMissingFile(t *testing.T) {
	dir := t.TempDir()
	current := Empty()
	current.Prompts = []Prompt{
		{ID: "p_a", Type: PromptFile, Path: "prompts/gone.md", Hash: "sha256:gone"},
	}
	res, err := FastScan(dir, current)
	if err != nil {
		t.Fatal(err)
	}
	if res.Removed != 1 {
		t.Errorf("expected 1 removal, got %d", res.Removed)
	}
	if len(res.Manifest.Prompts) != 0 {
		t.Errorf("expected empty manifest, got %+v", res.Manifest.Prompts)
	}
}

func TestFastScan_DetectsContentChange(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "prompts/p.md", "old body")
	current := Empty()
	current.Prompts = []Prompt{
		{ID: "p_x", Type: PromptFile, Path: "prompts/p.md", Hash: HashPrompt("very different body")},
	}
	res, err := FastScan(dir, current)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed != 1 || res.Unchanged != 0 {
		t.Errorf("expected changed=1 unchanged=0, got %+v", res)
	}
	if res.Manifest.Prompts[0].Hash == "sha256:" {
		t.Errorf("hash not updated: %+v", res.Manifest.Prompts[0])
	}
}

func TestFastScan_UnchangedWhenContentMatches(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "prompts/p.md", "stable body")
	currentHash := HashPrompt("stable body")
	current := Empty()
	current.Prompts = []Prompt{
		{ID: "p_x", Type: PromptFile, Path: "prompts/p.md", Hash: currentHash},
	}
	res, err := FastScan(dir, current)
	if err != nil {
		t.Fatal(err)
	}
	if res.Unchanged != 1 || res.Changed != 0 || res.Added != 0 || res.Removed != 0 {
		t.Errorf("expected unchanged=1, got %+v", res)
	}
}

func TestFastScan_EmbeddedHashUpdates(t *testing.T) {
	dir := t.TempDir()
	src := "const SYSTEM_PROMPT = `you are helpful`\nconsole.log(SYSTEM_PROMPT)\n"
	writeFile(t, dir, "src/agent.ts", src)
	cs, ce := 23, 38 // " `you are helpful`"
	current := Empty()
	current.Prompts = []Prompt{
		{
			ID: "p_e", Type: PromptEmbedded, Path: "src/agent.ts",
			Hash:      "sha256:wrong",
			CharStart: &cs, CharEnd: &ce,
		},
	}
	res, err := FastScan(dir, current)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed != 1 {
		t.Errorf("expected embedded rehash, got %+v", res)
	}
	want := HashPrompt(src[cs:ce])
	if res.Manifest.Prompts[0].Hash != want {
		t.Errorf("embedded hash = %s, want %s", res.Manifest.Prompts[0].Hash, want)
	}
}

func TestFastScan_EmbeddedClampsBadOffsets(t *testing.T) {
	// charEnd past EOF must not panic; we clamp to file length.
	dir := t.TempDir()
	writeFile(t, dir, "src/agent.ts", "short")
	cs, ce := 0, 999
	current := Empty()
	current.Prompts = []Prompt{
		{
			ID: "p_e", Type: PromptEmbedded, Path: "src/agent.ts",
			Hash:      HashPrompt("wrong"),
			CharStart: &cs, CharEnd: &ce,
		},
	}
	res, err := FastScan(dir, current)
	if err != nil {
		t.Fatalf("FastScan panicked or errored on bad offsets: %v", err)
	}
	if res.Changed != 1 {
		t.Errorf("expected hash update, got %+v", res)
	}
}

// --- diff -------------------------------------------------------------------

func TestDiff(t *testing.T) {
	before := Manifest{Prompts: []Prompt{
		{ID: "p_a", Path: "prompts/a.md", Hash: "sha256:1"},
		{ID: "p_b", Path: "prompts/b.md", Hash: "sha256:2"},
		{ID: "p_c", Path: "prompts/c.md", Hash: "sha256:3"},
	}}
	after := Manifest{Prompts: []Prompt{
		{ID: "p_a", Path: "prompts/a.md", Hash: "sha256:1"},     // unchanged
		{ID: "p_b", Path: "prompts/b.md", Hash: "sha256:CHANGED"}, // changed
		// p_c removed
		{ID: "p_d", Path: "prompts/d.md", Hash: "sha256:4"}, // added
	}}
	got := Diff(before, after)
	wantLines := []string{
		"~ prompts/b.md (content changed)",
		"- prompts/c.md (removed)",
		"+ prompts/d.md (added)",
	}
	for _, l := range wantLines {
		if !strings.Contains(got, l) {
			t.Errorf("missing line %q in diff:\n%s", l, got)
		}
	}
	// Unchanged entries must NOT appear.
	if strings.Contains(got, "prompts/a.md") {
		t.Errorf("unchanged entry leaked into diff:\n%s", got)
	}
}

func TestDiff_Empty(t *testing.T) {
	got := Diff(Empty(), Empty())
	if got != "" {
		t.Errorf("expected empty diff for two empty manifests, got %q", got)
	}
}

// --- helpers ----------------------------------------------------------------

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

func strPtr(s string) *string { return &s }
