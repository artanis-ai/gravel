package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// env_test.go covers upsertEnvVar (used to bake GRAVEL_API_KEY +
// GRAVEL_PROJECT_ID into .env.local) plus the extractEnvValue regex
// it relies on. EnsureAdminPassword has its own coverage in
// wizard_test.go; this file fills the gaps around the cloud-creds
// path that v0.5.x silently dropped on the floor.

func TestUpsertEnvVar_CreatesFile(t *testing.T) {
	dir := t.TempDir()
	if err := upsertEnvVar(dir, "GRAVEL_API_KEY", "sk_abc"); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, ".env.local"))
	if err != nil {
		t.Fatalf("env file not created: %v", err)
	}
	if !strings.Contains(string(body), "GRAVEL_API_KEY=sk_abc") {
		t.Errorf("missing value in env file:\n%s", body)
	}
}

func TestUpsertEnvVar_AppendsToExisting(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte("DATABASE_URL=postgres://x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := upsertEnvVar(dir, "GRAVEL_API_KEY", "sk_abc"); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	got := string(body)
	mustContain(t, got, "DATABASE_URL=postgres://x")
	mustContain(t, got, "GRAVEL_API_KEY=sk_abc")
}

func TestUpsertEnvVar_AppendsNewlineIfMissing(t *testing.T) {
	dir := t.TempDir()
	// File without trailing newline.
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte("EXISTING=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := upsertEnvVar(dir, "NEW", "2"); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	got := string(body)
	if !strings.Contains(got, "EXISTING=1\nNEW=2\n") {
		t.Errorf("upsert didn't add a separator newline:\n%s", got)
	}
}

func TestUpsertEnvVar_Idempotent_PreservesValue(t *testing.T) {
	dir := t.TempDir()
	original := "GRAVEL_API_KEY=existing_key\n"
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	// Second upsert with a different value must NOT clobber the existing one.
	if err := upsertEnvVar(dir, "GRAVEL_API_KEY", "different_key"); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	if string(body) != original {
		t.Errorf("upsert clobbered existing key. got:\n%s\nwant:\n%s", body, original)
	}
}

func TestUpsertEnvVar_OverwritesEmptyValue(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte("GRAVEL_API_KEY=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := upsertEnvVar(dir, "GRAVEL_API_KEY", "fresh_key"); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	if !strings.Contains(string(body), "GRAVEL_API_KEY=fresh_key") {
		t.Errorf("upsert didn't fill empty value:\n%s", body)
	}
	// And shouldn't leave the empty stub behind.
	if strings.Count(string(body), "GRAVEL_API_KEY=") != 1 {
		t.Errorf("expected exactly one GRAVEL_API_KEY entry:\n%s", body)
	}
}

func TestExtractEnvValue_QuotedAndUnquoted(t *testing.T) {
	body := `# comment
PLAIN=value
DOUBLE_QUOTED="hello world"
SINGLE_QUOTED='hi'
EMPTY=
SPACES = padded
`
	cases := []struct {
		key  string
		want string
	}{
		{"PLAIN", "value"},
		{"DOUBLE_QUOTED", "hello world"},
		{"SINGLE_QUOTED", "hi"},
		{"EMPTY", ""},
		{"SPACES", "padded"},
		{"MISSING", ""},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			if got := extractEnvValue(body, tc.key); got != tc.want {
				t.Errorf("extractEnvValue(%q) = %q, want %q", tc.key, got, tc.want)
			}
		})
	}
}

// REGRESSION guard for the `\s*$` foot-gun: a naive whitespace match
// can span newlines and capture the next entry's value as the
// current entry's "value". extractEnvValue uses [\t ]* explicitly
// to prevent this — keep it that way.
func TestExtractEnvValue_DoesNotBridgeNewlines(t *testing.T) {
	body := "EMPTY_VAL=\nOTHER=should_not_leak_into_empty\n"
	if got := extractEnvValue(body, "EMPTY_VAL"); got != "" {
		t.Errorf("extractEnvValue bridged across newline: got %q for EMPTY_VAL", got)
	}
}
