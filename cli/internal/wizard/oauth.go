package wizard

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Browser-OAuth handshake against gravel.artanis.ai. Mirrors
// packages/sdk-ts/src/wizard/oauth.ts.
//
// Flow:
//   1. Generate a 32-char base64url token.
//   2. Pick a free localhost port (prefer 42424..42428, fall back to ephemeral).
//   3. Spin up a tiny HTTP server on that port (friendly "you can close this" page).
//   4. POST {token, redirect_port} to /api/cli/auth/init.
//   5. Open the user's browser to /cli/auth?token=<token>.
//   6. Poll /api/cli/auth/claim?token=<token> every 1.5s for up to 10 minutes.
//   7. On 200, return creds. On 404/410, error out clearly.
//
// All HTTP calls go through net/http with a real context so timeouts
// honour the caller. The localhost listener is closed on every exit
// path via a deferred Close().

const (
	defaultControlPlane    = "https://gravel.artanis.ai"
	pollIntervalDefault    = 1500 * time.Millisecond
	pollTimeoutDefault     = 10 * time.Minute
	tokenBytes             = 24 // 24 bytes → 32 base64url chars
)

var preferredPorts = []int{42424, 42425, 42426, 42427, 42428}

// OAuthClaim is what the control-plane returns once the user has
// completed the browser handoff.
type OAuthClaim struct {
	ProjectID        string
	APIKey           string
	OrganizationName string
	ProjectName      string
}

// OAuthOptions overrides the defaults; all fields are optional.
type OAuthOptions struct {
	BaseURL        string                  // override control-plane URL (also: GRAVEL_CONTROL_PLANE_URL env)
	SkipBrowser    bool                    // useful for tests / CI
	PollInterval   time.Duration           // default 1.5s
	Timeout        time.Duration           // default 10m
	OnAuthURL      func(string)            // callback invoked once the browser URL is known
	HTTPClient     *http.Client            // injected for tests; defaults to http.DefaultClient
}

// ResolveControlPlaneURL returns the base URL the OAuth flow should
// talk to. Order: explicit override, GRAVEL_CONTROL_PLANE_URL env,
// hard-coded default.
func ResolveControlPlaneURL(override string) string {
	if override != "" {
		return override
	}
	if v := os.Getenv("GRAVEL_CONTROL_PLANE_URL"); v != "" {
		return v
	}
	return defaultControlPlane
}

// GenerateAuthToken returns a 32-char base64url-safe token. 24 random
// bytes encode to 32 base64 chars with no padding.
func GenerateAuthToken() (string, error) {
	var buf [tokenBytes]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:])[:32], nil
}

// listenLocalhost binds the loopback interface on `port` and returns
// the listener + the port we actually got (0 means kernel-assigned).
func listenLocalhost(port int) (net.Listener, int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, 0, err
	}
	actual := l.Addr().(*net.TCPAddr).Port
	return l, actual, nil
}

// PickFreePort tries each preferred port, falling back to an
// ephemeral one if all are taken.
func PickFreePort() (net.Listener, int, error) {
	for _, p := range preferredPorts {
		l, actual, err := listenLocalhost(p)
		if err == nil {
			return l, actual, nil
		}
		if !isPortBusy(err) {
			return nil, 0, err
		}
	}
	return listenLocalhost(0)
}

func isPortBusy(err error) bool {
	// EADDRINUSE / EACCES surface differently across platforms
	// (sometimes wrapped through net.OpError, sometimes a plain
	// syscall error). String-match is the portable thing here.
	msg := err.Error()
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "permission denied")
}

// OpenBrowser launches the user's default browser pointed at url.
// Best-effort; failures are silent because the URL is also printed
// to stdout for manual handling.
func OpenBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if cmd == nil {
		return
	}
	_ = cmd.Start()
	// Don't wait; we just want the browser to come up.
}

// BrowserOAuthHandshake runs the full flow. Returns the resolved
// OAuthClaim on success; errors are user-readable strings the cobra
// layer can surface verbatim.
func BrowserOAuthHandshake(ctx context.Context, opts OAuthOptions) (OAuthClaim, error) {
	baseURL := ResolveControlPlaneURL(opts.BaseURL)
	pollInterval := opts.PollInterval
	if pollInterval == 0 {
		pollInterval = pollIntervalDefault
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = pollTimeoutDefault
	}
	client := opts.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}

	token, err := GenerateAuthToken()
	if err != nil {
		return OAuthClaim{}, fmt.Errorf("generate auth token: %w", err)
	}

	l, port, err := PickFreePort()
	if err != nil {
		return OAuthClaim{}, fmt.Errorf("bind localhost port: %w", err)
	}
	defer l.Close()

	// Serve the friendly close page on the loopback listener. The
	// browser ultimately lands on the hosted /cli/auth page, but if
	// the user pastes the redirect or curls the port, give them
	// something readable.
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, friendlyHTML)
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = srv.Serve(l) }()
	defer srv.Close()

	if err := postInit(ctx, client, baseURL, token, port); err != nil {
		return OAuthClaim{}, err
	}

	authURL := baseURL + "/cli/auth?token=" + url.QueryEscape(token)
	if opts.OnAuthURL != nil {
		opts.OnAuthURL(authURL)
	}
	if !opts.SkipBrowser {
		OpenBrowser(authURL)
	}

	start := time.Now()
	for time.Since(start) < timeout {
		select {
		case <-ctx.Done():
			return OAuthClaim{}, ctx.Err()
		default:
		}
		outcome, err := pollClaim(ctx, client, baseURL, token)
		if err != nil {
			return OAuthClaim{}, err
		}
		switch outcome.kind {
		case claimedKind:
			return OAuthClaim{
				ProjectID:        outcome.data.ProjectID,
				APIKey:           outcome.data.APIKey,
				OrganizationName: outcome.data.OrganizationName,
				ProjectName:      outcome.data.ProjectName,
			}, nil
		case expiredKind:
			return OAuthClaim{}, errors.New("auth token expired before the browser flow completed (10 min). Re-run `gravel init`")
		case notFoundKind:
			return OAuthClaim{}, errors.New("auth token was not recognised by the control plane. Re-run `gravel init`")
		}
		// pending: sleep then retry
		select {
		case <-ctx.Done():
			return OAuthClaim{}, ctx.Err()
		case <-time.After(pollInterval):
		}
	}
	return OAuthClaim{}, errors.New("timed out waiting for browser sign-in (10 min). Re-run `gravel init`")
}

const friendlyHTML = `<!doctype html><meta charset="utf-8"><title>Gravel CLI</title>` +
	`<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">` +
	`<h1>Gravel CLI</h1>` +
	`<p>You can close this tab and return to your terminal.</p>` +
	`</body>`

func postInit(ctx context.Context, client *http.Client, baseURL, token string, port int) error {
	body, _ := json.Marshal(map[string]any{
		"token":         token,
		"redirect_port": port,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/api/cli/auth/init", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("auth/init network: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("auth/init failed: %s %s", resp.Status, string(bodyBytes))
	}
	return nil
}

type pollOutcomeKind int

const (
	pendingKind pollOutcomeKind = iota
	claimedKind
	expiredKind
	notFoundKind
)

type claimResponse struct {
	ProjectID        string `json:"project_id"`
	APIKey           string `json:"api_key"`
	ProjectName      string `json:"project_name,omitempty"`
	OrganizationName string `json:"organization_name,omitempty"`
}

type pollOutcome struct {
	kind pollOutcomeKind
	data claimResponse
}

func pollClaim(ctx context.Context, client *http.Client, baseURL, token string) (pollOutcome, error) {
	u := baseURL + "/api/cli/auth/claim?token=" + url.QueryEscape(token)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return pollOutcome{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return pollOutcome{}, fmt.Errorf("auth/claim network: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		var c claimResponse
		if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
			return pollOutcome{}, fmt.Errorf("auth/claim decode: %w", err)
		}
		return pollOutcome{kind: claimedKind, data: c}, nil
	case 202:
		return pollOutcome{kind: pendingKind}, nil
	case 410:
		return pollOutcome{kind: expiredKind}, nil
	case 404:
		return pollOutcome{kind: notFoundKind}, nil
	}
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return pollOutcome{}, fmt.Errorf("auth/claim unexpected %d: %s", resp.StatusCode, string(bodyBytes))
}

// WriteAPICredsToEnv idempotently writes the resolved API key +
// project ID into the host's .env.local. Existing GRAVEL_* values
// are preserved if already non-empty (re-run safe).
func WriteAPICredsToEnv(cwd string, c OAuthClaim) error {
	if err := upsertEnvVar(cwd, "GRAVEL_API_KEY", c.APIKey); err != nil {
		return err
	}
	if err := upsertEnvVar(cwd, "GRAVEL_PROJECT_ID", c.ProjectID); err != nil {
		return err
	}
	return nil
}
