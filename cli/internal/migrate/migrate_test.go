package migrate

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectDialect(t *testing.T) {
	cases := []struct {
		url  string
		want Dialect
		err  bool
	}{
		{"postgres://localhost/db", DialectPostgres, false},
		{"postgresql://user:pw@host:5432/db", DialectPostgres, false},
		{"file:./gravel.db", DialectSQLite, false},
		{"file:/tmp/gravel.db", DialectSQLite, false},
		{"sqlite:./gravel.db", DialectSQLite, false},
		{"./local.db", DialectSQLite, false},
		{"./local.sqlite", DialectSQLite, false},
		{"mysql://nope", "", true},
		{"", "", true},
	}
	for _, tc := range cases {
		got, err := DetectDialect(tc.url)
		if tc.err {
			if err == nil {
				t.Errorf("DetectDialect(%q) expected error, got %q", tc.url, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("DetectDialect(%q) unexpected error: %v", tc.url, err)
		}
		if got != tc.want {
			t.Errorf("DetectDialect(%q) = %q, want %q", tc.url, got, tc.want)
		}
	}
}

func TestBootstrap_SQLite_Idempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "gravel.db")
	db, d, err := Open(ctx, "file:"+path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if d != DialectSQLite {
		t.Fatalf("expected sqlite dialect, got %s", d)
	}

	// First run: creates tables.
	if err := Bootstrap(ctx, db, d); err != nil {
		t.Fatalf("Bootstrap (first run): %v", err)
	}
	// Second run: must not error.
	if err := Bootstrap(ctx, db, d); err != nil {
		t.Fatalf("Bootstrap (second run, idempotency): %v", err)
	}

	// Tables exist and respect the FK constraint.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO gravel_samples (id, name, timestamp, started_at) VALUES (?, 'test', 0, 0)`,
		"s_a"); err != nil {
		t.Errorf("insert into gravel_samples: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO gravel_feedback (id, sample_id, timestamp) VALUES (?, ?, 0)`,
		"f_a", "s_a"); err != nil {
		t.Errorf("insert into gravel_feedback: %v", err)
	}
	// Bad FK should reject.
	if _, err := db.ExecContext(ctx,
		`PRAGMA foreign_keys = ON`); err != nil {
		t.Errorf("enable foreign_keys: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO gravel_feedback (id, sample_id, timestamp) VALUES (?, ?, 0)`,
		"f_b", "s_missing"); err == nil {
		t.Errorf("expected FK violation when sample_id is missing")
	}
}

// TestTablesAlreadyExist drives the idempotency check the wizard
// uses in Step 3 (Traces). False positives skip a needed migration;
// false negatives spam the user with a redundant "Create tables?"
// prompt on every re-run.
func TestTablesAlreadyExist_SQLite_FreshDB_False(t *testing.T) {
	ctx := context.Background()
	url := "file:" + filepath.Join(t.TempDir(), "gravel.db")
	got, err := TablesAlreadyExist(ctx, url, DialectSQLite)
	if err != nil {
		t.Fatalf("TablesAlreadyExist: %v", err)
	}
	if got {
		t.Errorf("got true on a fresh database, want false")
	}
}

func TestTablesAlreadyExist_SQLite_AfterBootstrap_True(t *testing.T) {
	ctx := context.Background()
	url := "file:" + filepath.Join(t.TempDir(), "gravel.db")
	db, d, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if err := Bootstrap(ctx, db, d); err != nil {
		t.Fatal(err)
	}
	db.Close()
	got, err := TablesAlreadyExist(ctx, url, DialectSQLite)
	if err != nil {
		t.Fatalf("TablesAlreadyExist: %v", err)
	}
	if !got {
		t.Errorf("got false after Bootstrap, want true")
	}
}

func TestTablesAlreadyExist_SQLite_PartialSchema_False(t *testing.T) {
	// Only one of the two tables exists — TablesAlreadyExist must
	// return false so Bootstrap re-runs and creates the missing one.
	ctx := context.Background()
	url := "file:" + filepath.Join(t.TempDir(), "gravel.db")
	db, _, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx,
		`CREATE TABLE gravel_samples (id TEXT)`); err != nil {
		t.Fatal(err)
	}
	got, err := TablesAlreadyExist(ctx, url, DialectSQLite)
	if err != nil {
		t.Fatalf("TablesAlreadyExist: %v", err)
	}
	if got {
		t.Errorf("got true with only 1/2 tables, want false (Bootstrap needs to add the other)")
	}
}

func TestTablesAlreadyExist_BadURL_Errors(t *testing.T) {
	ctx := context.Background()
	_, err := TablesAlreadyExist(ctx, "mysql://no", DialectSQLite)
	if err == nil {
		t.Errorf("expected error for unsupported URL")
	}
}

func TestSplitStatements(t *testing.T) {
	in := "CREATE TABLE a (...);\nCREATE INDEX b ON a(...);\n\nCREATE TABLE c (...);\n"
	got := splitStatements(in)
	if len(got) != 3 {
		t.Errorf("expected 3 statements, got %d: %+v", len(got), got)
	}
	if !strings.HasPrefix(got[0], "CREATE TABLE a") {
		t.Errorf("statement[0] wrong: %q", got[0])
	}
}

// TestBootstrapSQL_MatchesTSReference asserts the embedded SQL matches
// the TS bootstrap byte-for-byte. This is the schema-drift safety net
// on the Go side; the TS side has its own check.
//
// The strings are intentionally small/stable, so equality is a strong
// signal. When updating the schema, you MUST update both files in
// lockstep (release.sh enforces it).
func TestBootstrapSQL_NonEmptyAndContainsKeyTables(t *testing.T) {
	for _, s := range []string{PostgresBootstrapSQL(), SQLiteBootstrapSQL()} {
		if !strings.Contains(s, "CREATE TABLE IF NOT EXISTS gravel_samples") {
			t.Errorf("expected gravel_samples table:\n%s", s)
		}
		if !strings.Contains(s, "CREATE TABLE IF NOT EXISTS gravel_feedback") {
			t.Errorf("expected gravel_feedback table:\n%s", s)
		}
	}
}
