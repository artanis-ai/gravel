package wizard

import (
	"context"
	"errors"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/migrate"
)

// probe.go ports packages/sdk-ts/src/wizard/db-test.ts's
// `probeDatabase` — the "test-trace" pre-flight before we touch the
// host's database. Confirms we can open, that the URL isn't a
// placeholder, and that a trivial query round-trips.
//
// Surfaces structured errors so the cobra layer can decide between
// "skip gracefully" (bad URL, unset env) and "block with a clear
// error" (auth failure mid-install).

// DBProbeKind discriminates the four outcomes the wizard cares about.
type DBProbeKind string

const (
	ProbeOK            DBProbeKind = "ok"
	ProbeNoURL         DBProbeKind = "no-url"
	ProbePlaceholder   DBProbeKind = "placeholder"
	ProbeConnectFailed DBProbeKind = "connect-failed"
)

// FailureReason refines ProbeConnectFailed so the wizard can give
// targeted advice ("did you start your DB?" vs "did you set the
// password right?").
type FailureReason string

const (
	FailAuth  FailureReason = "auth"
	FailHost  FailureReason = "host"
	FailOther FailureReason = "other"
)

// DBProbeResult is what ProbeDatabase returns. Kind is the
// discriminator; the other fields are populated as relevant per kind.
type DBProbeResult struct {
	Kind    DBProbeKind
	URL     string
	Dialect migrate.Dialect
	Reason  FailureReason
	Message string
}

// placeholderPatterns matches common "I didn't fill this in" URLs
// the wizard's own template emits, plus the most popular tutorial
// defaults. Mirrors the TS reference list.
var placeholderPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)//user:password@`),
	regexp.MustCompile(`(?i)//postgres:postgres@`),
	regexp.MustCompile(`(?i)//myuser:mypassword@`),
	regexp.MustCompile(`(?i)//USER:PASS@`),
	regexp.MustCompile(`(?i)//<.*?>:<.*?>@`),
	regexp.MustCompile(`(?i)YOUR_PASSWORD`),
	regexp.MustCompile(`(?i)<password>`),
}

// LooksLikePlaceholder is true if the URL looks like a default /
// tutorial value the user hasn't replaced yet. Conservative: we'd
// rather skip a real install once than wade into an authentication
// loop trying to reach a DB that doesn't exist.
func LooksLikePlaceholder(url string) bool {
	for _, re := range placeholderPatterns {
		if re.MatchString(url) {
			return true
		}
	}
	return false
}

// ProbeDatabase reads the host's .env files for DATABASE_URL (with
// POSTGRES_URL / NEON_DATABASE_URL as fallbacks), opens a connection,
// and round-trips a trivial query.
//
// Never panics; never propagates infra errors as "weird Go errors".
// The DBProbeResult always tells the caller exactly what happened in
// a form they can format for the user.
func ProbeDatabase(ctx context.Context, cwd string) DBProbeResult {
	url := readDBURL(cwd)
	if url == "" {
		return DBProbeResult{Kind: ProbeNoURL}
	}
	if LooksLikePlaceholder(url) {
		return DBProbeResult{Kind: ProbePlaceholder, URL: url}
	}

	db, dialect, err := migrate.Open(ctx, url)
	if err != nil {
		return DBProbeResult{
			Kind:    ProbeConnectFailed,
			URL:     url,
			Reason:  classifyConnectFailure(err),
			Message: err.Error(),
		}
	}
	defer db.Close()

	// Trivial round-trip: confirms the driver authenticates and the
	// query path responds. We don't care about the result shape.
	if _, err := db.ExecContext(ctx, "SELECT 1"); err != nil {
		return DBProbeResult{
			Kind:    ProbeConnectFailed,
			URL:     url,
			Dialect: dialect,
			Reason:  classifyConnectFailure(err),
			Message: err.Error(),
		}
	}
	return DBProbeResult{Kind: ProbeOK, URL: url, Dialect: dialect}
}

// readDBURL probes .env.local then .env for the first non-empty
// DATABASE_URL / POSTGRES_URL / NEON_DATABASE_URL value.
func readDBURL(cwd string) string {
	for _, key := range []string{"DATABASE_URL", "POSTGRES_URL", "NEON_DATABASE_URL"} {
		for _, file := range []string{".env.local", ".env"} {
			body, err := readFile(filepath.Join(cwd, file))
			if err != nil {
				continue
			}
			if v := extractEnvValue(body, key); v != "" {
				return v
			}
		}
	}
	return ""
}

// classifyConnectFailure picks the FailureReason that best describes
// the error string. The strings come from pq/pgx and modernc/sqlite,
// so this is a case-by-case map. Order matters: auth checks first
// (they often mention "host" too, e.g. "no pg_hba.conf entry for
// host ..., user ...").
func classifyConnectFailure(err error) FailureReason {
	if err == nil {
		return FailOther
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return FailHost
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "password authentication failed"),
		strings.Contains(msg, "authentication"),
		strings.Contains(msg, "role ") && strings.Contains(msg, "does not exist"),
		strings.Contains(msg, "no pg_hba.conf entry"):
		return FailAuth
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "no such host"),
		strings.Contains(msg, "i/o timeout"),
		strings.Contains(msg, "no route to host"),
		strings.Contains(msg, "host is unreachable"):
		return FailHost
	}
	return FailOther
}
