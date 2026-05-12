package dotenv

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParse_BasicShape(t *testing.T) {
	body := `
# comment
FOO=bar
QUOTED="hello world"
SINGLE='one two'
export EXPORTED=yes
QUOTED_HASH="keep#me as-is"
PLAIN_HASH=plain # gets stripped
`
	got := parse(body)
	want := map[string]string{
		"FOO":         "bar",
		"QUOTED":      "hello world",
		"SINGLE":      "one two",
		"EXPORTED":    "yes",
		"QUOTED_HASH": "keep#me as-is",
		"PLAIN_HASH":  "plain",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("parse[%q] = %q, want %q", k, got[k], v)
		}
	}
}

func TestLoadCwd_FilePrecedence(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("DATABASE_URL=postgres://base\nA=base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte("DATABASE_URL=postgres://local\nB=local\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := LoadCwd(dir)
	if env["DATABASE_URL"] != "postgres://local" {
		t.Errorf(".env.local should win: got %q", env["DATABASE_URL"])
	}
	if env["A"] != "base" || env["B"] != "local" {
		t.Errorf("merge dropped values: %+v", env)
	}
}

func TestLoadCwd_ShellOverrides(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("DATABASE_URL=from-file\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "from-shell")
	env := LoadCwd(dir)
	if env["DATABASE_URL"] != "from-shell" {
		t.Errorf("shell should win, got %q", env["DATABASE_URL"])
	}
}

func TestLoadCwd_MissingIsEmpty(t *testing.T) {
	dir := t.TempDir()
	env := LoadCwd(dir)
	if len(env) != 0 {
		t.Errorf("expected empty map, got %+v", env)
	}
}
