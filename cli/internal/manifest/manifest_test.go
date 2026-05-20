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

// --- doc-filename filter ----------------------------------------------------
// Heavy coverage for the "scan ignores docs" rule. Without this filter
// every project that keeps a `prompts/README.md` describing its prompt
// conventions ends up with the README itself listed as a prompt.

func TestIsDocFilename_MatchMatrix(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// Standard project metadata files (denylist hits).
		{"README.md", true},
		{"readme.md", true}, // case-insensitive
		{"Readme.md", true},
		{"README.txt", true},
		{"README.prompt", true}, // .prompt ext shouldn't save a README from the filter
		{"CHANGELOG.md", true},
		{"CHANGES.md", true},
		{"HISTORY.md", true},
		{"CONTRIBUTING.md", true},
		{"LICENSE.md", true},
		{"LICENCE.md", true}, // British spelling
		{"NOTICE.md", true},
		{"AUTHORS.md", true},
		{"MAINTAINERS.md", true},
		{"SECURITY.md", true},
		{"CODE_OF_CONDUCT.md", true},
		{"COPYING.md", true},
		{"INSTALL.md", true},
		{"TODO.md", true},
		{"ROADMAP.md", true},
		{"USAGE.md", true},

		// Genuine prompt-y names that just happen to share characters.
		{"readme-style-system-prompt.md", false},
		{"my-readme.md", false},     // contains readme but is not "readme"
		{"system.md", false},        // genuine prompt
		{"welcome.txt", false},
		{"summarise.prompt", false},
		{"chatbot.md", false},

		// Filenames that look like docs but have non-doc extensions
		// — these are filtered upstream by promptFileExts anyway, but
		// isDocFilename's job is just "does the stem match a doc name?"
		{"README.json", true},

		// Edge cases.
		{".md", false},                  // empty stem
		{"PROMPT.md", false},            // would be a prompt named PROMPT
		{"system-CHANGELOG.md", false},  // not exactly CHANGELOG
		{"CHANGELOG-old.md", false},     // CHANGELOG-old isn't in the list
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isDocFilename(tc.name)
			if got != tc.want {
				t.Errorf("isDocFilename(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

// v0.9.0 scanner walks the entire repo respecting .gitignore — the
// pre-v0.9.0 prompt_scan_roots config field is gone and unnecessary.
// Olly's de_platform case (prompts under api/py/prompts/) now resolves
// without any config.
func TestFastScan_FindsPromptsInNonConventionalDirs(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "api/py/prompts/judge.txt", "you are an evaluation judge")
	writeFile(t, dir, "api/py/prompts/rewrite.txt", "rewrite the user's draft")
	writeFile(t, dir, "src/components/agents/system.md", "system prompt")

	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 3 {
		t.Errorf("expected 3 prompts via full-repo walk, got %d (%+v)", res.Added, res.Manifest.Prompts)
	}
}

// New v0.9.0 extensions: .mdx, .mdc, .markdown all picked up by the
// scanner. .prompt and .yaml are intentionally NOT picked up.
func TestFastScan_RespectsExtensionAllowlist(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "prompts/sys.md", "x")
	writeFile(t, dir, "prompts/sys.markdown", "x")
	writeFile(t, dir, "prompts/sys.txt", "x")
	writeFile(t, dir, "prompts/sys.mdx", "x")
	writeFile(t, dir, "prompts/sys.mdc", "x")
	writeFile(t, dir, "prompts/sys.yaml", "x") // outside the allowlist
	writeFile(t, dir, "prompts/sys.json", "x") // outside the allowlist
	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 5 {
		t.Errorf("expected 5 prompts (.md/.markdown/.txt/.mdx/.mdc), got %d (%+v)", res.Added, res.Manifest.Prompts)
	}
}

// FS-walk fallback (non-git repo) must skip well-known dependency /
// build dirs so we don't crawl 50k files in node_modules.
func TestFastScan_FSFallbackSkipsNodeModulesAndDotDirs(t *testing.T) {
	dir := t.TempDir()
	// Real prompt
	writeFile(t, dir, "prompts/system.md", "real")
	// Decoys that the fallback walker must skip
	writeFile(t, dir, "node_modules/foo/README.md", "ignored")
	writeFile(t, dir, "node_modules/foo/prompt.md", "ignored")
	writeFile(t, dir, ".venv/lib/site-packages/x.md", "ignored")
	writeFile(t, dir, "dist/built.md", "ignored")
	writeFile(t, dir, ".next/cache/x.md", "ignored")

	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 {
		t.Errorf("expected 1 prompt (only prompts/system.md), got %d (%+v)", res.Added, res.Manifest.Prompts)
	}
	if len(res.Manifest.Prompts) != 1 || res.Manifest.Prompts[0].Path != "prompts/system.md" {
		t.Errorf("unexpected prompts: %+v", res.Manifest.Prompts)
	}
}

func TestFastScan_SkipsReadmeInPromptsDir(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "prompts/README.md", "# How we organise prompts\n")
	writeFile(t, dir, "prompts/system.md", "You are a helpful agent.\n")
	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 {
		t.Errorf("Added = %d, want 1 (README must be filtered)", res.Added)
	}
	if len(res.Manifest.Prompts) != 1 || res.Manifest.Prompts[0].Path != "prompts/system.md" {
		t.Errorf("manifest unexpected: %+v", res.Manifest.Prompts)
	}
}

func TestFastScan_SkipsAllDocFilenames(t *testing.T) {
	// One real prompt plus the entire doc-filename denylist sitting
	// next to it. The genuine prompt is the only thing that lands.
	dir := t.TempDir()
	writeFile(t, dir, "prompts/system.md", "the actual prompt")
	for _, name := range []string{
		"README.md", "CHANGELOG.md", "CONTRIBUTING.md",
		"LICENSE.md", "LICENCE.md", "NOTICE.md", "AUTHORS.md",
		"MAINTAINERS.md", "HISTORY.md", "CHANGES.md", "SECURITY.md",
		"CODE_OF_CONDUCT.md", "COPYING.md", "INSTALL.md", "TODO.md",
		"ROADMAP.md", "USAGE.md",
	} {
		writeFile(t, dir, "prompts/"+name, "doc content")
	}
	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 {
		t.Errorf("Added = %d, want 1 (every doc filename must be skipped)", res.Added)
	}
	if len(res.Manifest.Prompts) != 1 || res.Manifest.Prompts[0].Path != "prompts/system.md" {
		t.Errorf("manifest unexpected: %+v", res.Manifest.Prompts)
	}
}

func TestFastScan_SkipsDocsSubdirWholesale(t *testing.T) {
	// `prompts/docs/foo.md` is documentation about the prompts, not a
	// prompt. Same for `templates/examples/...`. SkipDir on the
	// subtree, not just the README inside it.
	dir := t.TempDir()
	writeFile(t, dir, "prompts/system.md", "real prompt")
	writeFile(t, dir, "prompts/docs/how-to-write-prompts.md", "docs")
	writeFile(t, dir, "prompts/docs/style-guide.md", "more docs")
	writeFile(t, dir, "templates/examples/example1.md", "example doc")
	writeFile(t, dir, "templates/onboarding.md", "real template")
	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 2 {
		t.Errorf("Added = %d, want 2 (docs/ + examples/ skipped wholesale)", res.Added)
	}
	paths := []string{}
	for _, p := range res.Manifest.Prompts {
		paths = append(paths, p.Path)
	}
	want := []string{"prompts/system.md", "templates/onboarding.md"}
	if !equalUnordered(paths, want) {
		t.Errorf("manifest paths = %v, want %v", paths, want)
	}
}

func TestFastScan_DocDirCaseInsensitive(t *testing.T) {
	// `prompts/Docs/` and `prompts/DOCUMENTATION/` should also skip.
	dir := t.TempDir()
	writeFile(t, dir, "prompts/system.md", "real prompt")
	writeFile(t, dir, "prompts/Docs/how-to.md", "docs")
	writeFile(t, dir, "prompts/DOCUMENTATION/style-guide.md", "more docs")
	res, _ := FastScan(dir, Empty())
	if res.Added != 1 {
		t.Errorf("Added = %d, want 1 (Docs/ and DOCUMENTATION/ are case-insensitive matches)", res.Added)
	}
}

// REGRESSION: don't skip the top-level `prompts/` dir itself even if
// the dir name shadows a docDirName entry hypothetically. (None of
// the current promptFileDirs collide with docDirNames, but if someone
// later adds "examples" to promptFileDirs we don't want them to nuke
// themselves.)
func TestFastScan_DocDirSkip_DoesNotEatTopLevelEntry(t *testing.T) {
	dir := t.TempDir()
	// `prompts/` is a top-level promptFileDir; it must not be
	// SkipDir'd even though "prompts" is similar to (but not in)
	// docDirNames.
	writeFile(t, dir, "prompts/system.md", "real prompt")
	res, err := FastScan(dir, Empty())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 {
		t.Errorf("top-level prompts/ got skipped; Added = %d, want 1", res.Added)
	}
}

// User who explicitly added a README as a prompt earlier (via the
// manual-entry path in the wizard) must KEEP it on re-scan — the
// doc-filename filter only applies to NEW-file discovery, not to
// already-tracked entries.
func TestFastScan_RespectsManualReadmeOnRescan(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "prompts/README.md", "actually a prompt the user added by hand")
	writeFile(t, dir, "prompts/system.md", "another real prompt")
	current := Empty()
	current.Prompts = []Prompt{{
		ID:   GeneratePromptID("prompts/README.md", -1),
		Type: PromptFile,
		Path: "prompts/README.md",
		Hash: HashPrompt("actually a prompt the user added by hand"),
	}}
	res, err := FastScan(dir, current)
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, p := range res.Manifest.Prompts {
		paths = append(paths, p.Path)
	}
	want := []string{"prompts/README.md", "prompts/system.md"}
	if !equalUnordered(paths, want) {
		t.Errorf("re-scan dropped the user's manually-added README. paths=%v want=%v", paths, want)
	}
}

func equalUnordered(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[string]int, len(a))
	for _, x := range a {
		seen[x]++
	}
	for _, x := range b {
		seen[x]--
	}
	for _, v := range seen {
		if v != 0 {
			return false
		}
	}
	return true
}

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
