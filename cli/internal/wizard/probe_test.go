package wizard

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLooksLikePlaceholder(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"postgres://user:password@localhost/db", true},
		{"postgresql://postgres:postgres@localhost/db", true},
		{"postgres://myuser:mypassword@localhost/db", true},
		{"postgres://<user>:<password>@host/db", true},
		{"postgres://api:YOUR_PASSWORD@host/db", true},
		{"postgres://api:realpw_4hT9@prod.db.example.com:5432/app", false},
		{"file:./gravel.db", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := LooksLikePlaceholder(tc.url); got != tc.want {
			t.Errorf("LooksLikePlaceholder(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestProbeDatabase_NoURL(t *testing.T) {
	dir := t.TempDir()
	got := ProbeDatabase(context.Background(), dir)
	if got.Kind != ProbeNoURL {
		t.Errorf("Kind = %s, want %s", got.Kind, ProbeNoURL)
	}
}

func TestProbeDatabase_Placeholder(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=postgres://user:password@localhost/db\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ProbeDatabase(context.Background(), dir)
	if got.Kind != ProbePlaceholder {
		t.Errorf("Kind = %s, want %s", got.Kind, ProbePlaceholder)
	}
}

func TestProbeDatabase_OKSqlite(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gravel.db")
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=file:"+dbPath+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ProbeDatabase(context.Background(), dir)
	if got.Kind != ProbeOK {
		t.Errorf("Kind = %s msg=%s, want ok", got.Kind, got.Message)
	}
	if got.Dialect != "sqlite" {
		t.Errorf("Dialect = %s", got.Dialect)
	}
}

func TestProbeDatabase_ConnectFailedHost(t *testing.T) {
	dir := t.TempDir()
	// Port :1 is the historical "definitely not running" port. Some
	// hosts route :1 to a daemon, so we use :2 as a backup convention.
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=postgres://u:p@127.0.0.1:2/db?sslmode=disable&connect_timeout=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ProbeDatabase(context.Background(), dir)
	if got.Kind != ProbeConnectFailed {
		t.Errorf("Kind = %s, want connect-failed", got.Kind)
	}
	if got.Reason != FailHost && got.Reason != FailOther {
		t.Errorf("Reason = %s, expected host or other", got.Reason)
	}
}

func TestClassifyConnectFailure(t *testing.T) {
	cases := []struct {
		name string
		msg  string
		want FailureReason
	}{
		{"pg auth", "password authentication failed for user \"alice\"", FailAuth},
		{"role missing", "FATAL: role \"app\" does not exist", FailAuth},
		{"refused", "dial tcp 127.0.0.1:5432: connect: connection refused", FailHost},
		{"dns", "lookup db.example.com: no such host", FailHost},
		{"unknown", "some weird internal driver bug", FailOther},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyConnectFailure(stringError(tc.msg))
			if got != tc.want {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
}

type stringError string

func (s stringError) Error() string { return string(s) }
