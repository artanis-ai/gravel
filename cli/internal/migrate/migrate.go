// Package migrate applies pending DB migrations to the host's
// Postgres or SQLite. Mirrors packages/sdk-ts/src/db/migrate.ts +
// bootstrap.ts.
//
// Behaviour:
//   - Detect dialect from DATABASE_URL prefix.
//   - If `migrations/<dialect>/` exists alongside the SDK, apply
//     pending Drizzle-format SQL files in order, recording each in
//     `__drizzle_migrations`. (Not yet implemented; deferred until the
//     first drizzle-generated migration ships.)
//   - Otherwise run the idempotent CREATE TABLE IF NOT EXISTS
//     bootstrap that mirrors packages/sdk-ts/src/db/bootstrap.ts.
//
// The bootstrap SQL is embedded in the binary, NOT read from the
// host's filesystem; the SDK package and the CLI binary release in
// lockstep so their schemas can't drift. CI asserts the embedded SQL
// matches the TS reference.
package migrate

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// Dialect is the discriminator for which SQL flavour we're targeting.
type Dialect string

const (
	DialectPostgres Dialect = "postgres"
	DialectSQLite   Dialect = "sqlite"
)

// DetectDialect mirrors packages/sdk-ts/src/db/index.ts §detectDialect.
// Returns an error for URLs whose dialect can't be inferred so the
// caller can show a clear "fix your env" message.
func DetectDialect(url string) (Dialect, error) {
	switch {
	case strings.HasPrefix(url, "postgres://"),
		strings.HasPrefix(url, "postgresql://"):
		return DialectPostgres, nil
	case strings.HasPrefix(url, "file:"),
		strings.HasPrefix(url, "sqlite:"),
		strings.HasSuffix(url, ".db"),
		strings.HasSuffix(url, ".sqlite"):
		return DialectSQLite, nil
	}
	return "", fmt.Errorf(
		"unsupported DATABASE_URL %q (expected postgres:// or file:/sqlite: prefix)",
		url,
	)
}

//go:embed sql/postgres_bootstrap.sql
var postgresBootstrap string

//go:embed sql/sqlite_bootstrap.sql
var sqliteBootstrap string

// Bootstrap creates the gravel_* tables idempotently. Safe to run on
// a fresh DB or one that already has them; CREATE TABLE IF NOT EXISTS
// is the path of least surprise here.
func Bootstrap(ctx context.Context, db *sql.DB, d Dialect) error {
	body := postgresBootstrap
	if d == DialectSQLite {
		body = sqliteBootstrap
	}
	for _, stmt := range splitStatements(body) {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("bootstrap %s: %w\n  statement: %s", d, err, firstLine(stmt))
		}
	}
	return nil
}

// splitStatements naively splits on ";\n" so each CREATE statement is
// executed in its own round-trip. Mirrors the TS split rule. This
// works for the bootstrap (no embedded semicolons inside string
// literals) but would NOT survive arbitrary user SQL; use a proper
// parser when we wire generated migrations.
func splitStatements(body string) []string {
	parts := strings.Split(body, ";\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		s := strings.TrimSpace(p)
		if s == "" {
			continue
		}
		out = append(out, s)
	}
	return out
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// Open connects to the database using a driver chosen by dialect.
// SQLite URLs of the form `file:./path/to.db` are stripped to the raw
// path; the pure-Go modernc.org/sqlite driver wants a filename, not a
// URL.
func Open(ctx context.Context, url string) (*sql.DB, Dialect, error) {
	d, err := DetectDialect(url)
	if err != nil {
		return nil, "", err
	}
	switch d {
	case DialectPostgres:
		db, err := sql.Open("pgx", url)
		if err != nil {
			return nil, "", err
		}
		// Fail fast on bad URLs / unreachable host so the user sees a
		// clear error rather than a deadlock on first query.
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := db.PingContext(pingCtx); err != nil {
			_ = db.Close()
			return nil, "", fmt.Errorf("connect postgres: %w", err)
		}
		return db, d, nil
	case DialectSQLite:
		path := strings.TrimPrefix(url, "file:")
		path = strings.TrimPrefix(path, "sqlite:")
		db, err := sql.Open("sqlite", path)
		if err != nil {
			return nil, "", err
		}
		if err := db.PingContext(ctx); err != nil {
			_ = db.Close()
			return nil, "", fmt.Errorf("open sqlite: %w", err)
		}
		return db, d, nil
	}
	return nil, "", errors.New("unreachable")
}

// PostgresBootstrapSQL returns the embedded postgres CREATE TABLE
// script. Exposed so the schema-drift CI can diff it against the TS
// reference at packages/sdk-ts/src/db/bootstrap.ts.
func PostgresBootstrapSQL() string { return postgresBootstrap }

// SQLiteBootstrapSQL returns the embedded sqlite CREATE TABLE
// script; companion to PostgresBootstrapSQL.
func SQLiteBootstrapSQL() string { return sqliteBootstrap }
