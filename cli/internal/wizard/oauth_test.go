package wizard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGenerateAuthToken_Format(t *testing.T) {
	tok, err := GenerateAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != 32 {
		t.Errorf("expected 32 chars, got %d: %q", len(tok), tok)
	}
	for _, c := range tok {
		ok := (c >= 'A' && c <= 'Z') ||
			(c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_'
		if !ok {
			t.Errorf("non-base64url char %q in %s", c, tok)
		}
	}
}

func TestResolveControlPlaneURL_Precedence(t *testing.T) {
	t.Setenv("GRAVEL_CONTROL_PLANE_URL", "https://staging.example.com")
	if got := ResolveControlPlaneURL(""); got != "https://staging.example.com" {
		t.Errorf("env var should win when no override: got %q", got)
	}
	if got := ResolveControlPlaneURL("https://explicit.example.com"); got != "https://explicit.example.com" {
		t.Errorf("explicit override should win: got %q", got)
	}
}

func TestPickFreePort_Succeeds(t *testing.T) {
	l, port, err := PickFreePort()
	if err != nil {
		t.Fatalf("PickFreePort: %v", err)
	}
	defer l.Close()
	if port == 0 {
		t.Errorf("port = 0 (ephemeral fallback should have a real port)")
	}
}

// driveOAuthHandshake spins up a synthetic control plane that:
//   - returns 200 on POST /api/cli/auth/init
//   - returns 202 (pending) for the first `pendingCalls` claim requests
//   - then returns 200 with the canned claim on subsequent requests
//
// Used to exercise the full handshake without touching the real
// gravel.artanis.ai service.
func driveOAuthHandshake(t *testing.T, pendingCalls int32, claim claimResponse) (OAuthClaim, error) {
	t.Helper()
	var initCount, claimCount atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/auth/init", func(w http.ResponseWriter, r *http.Request) {
		initCount.Add(1)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "expires_in_seconds": 600})
	})
	mux.HandleFunc("/api/cli/auth/claim", func(w http.ResponseWriter, r *http.Request) {
		n := claimCount.Add(1)
		if n <= pendingCalls {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(claim)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	return BrowserOAuthHandshake(context.Background(), OAuthOptions{
		BaseURL:      srv.URL,
		SkipBrowser:  true,
		PollInterval: 10 * time.Millisecond,
		Timeout:      5 * time.Second,
		HTTPClient:   srv.Client(),
	})
}

func TestBrowserOAuthHandshake_HappyPath(t *testing.T) {
	got, err := driveOAuthHandshake(t, 2, claimResponse{
		ProjectID:        "proj_abc",
		APIKey:           "key_xyz",
		ProjectName:      "Acme AI",
		OrganizationName: "Acme",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != "proj_abc" || got.APIKey != "key_xyz" {
		t.Errorf("got %+v", got)
	}
	if got.ProjectName != "Acme AI" || got.OrganizationName != "Acme" {
		t.Errorf("optional fields missing: %+v", got)
	}
}

func TestBrowserOAuthHandshake_ImmediateClaim(t *testing.T) {
	got, err := driveOAuthHandshake(t, 0, claimResponse{
		ProjectID: "proj_immediate",
		APIKey:    "key_immediate",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != "proj_immediate" {
		t.Errorf("got %+v", got)
	}
}

func TestBrowserOAuthHandshake_Expired(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/auth/init", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/cli/auth/claim", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(410)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	_, err := BrowserOAuthHandshake(context.Background(), OAuthOptions{
		BaseURL:     srv.URL,
		SkipBrowser: true,
		Timeout:     2 * time.Second,
		HTTPClient:  srv.Client(),
	})
	if err == nil {
		t.Fatal("expected error for 410, got nil")
	}
	if !strings.Contains(err.Error(), "expired") {
		t.Errorf("error should mention 'expired', got %v", err)
	}
}

func TestBrowserOAuthHandshake_NotFound(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/auth/init", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/cli/auth/claim", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	_, err := BrowserOAuthHandshake(context.Background(), OAuthOptions{
		BaseURL:     srv.URL,
		SkipBrowser: true,
		Timeout:     2 * time.Second,
		HTTPClient:  srv.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "not recognised") {
		t.Errorf("expected 'not recognised' error, got %v", err)
	}
}

func TestBrowserOAuthHandshake_InitFails(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/auth/init", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":"control plane offline"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	_, err := BrowserOAuthHandshake(context.Background(), OAuthOptions{
		BaseURL:     srv.URL,
		SkipBrowser: true,
		Timeout:     time.Second,
		HTTPClient:  srv.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "auth/init failed") {
		t.Errorf("expected auth/init error, got %v", err)
	}
}

func TestBrowserOAuthHandshake_Timeout(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/auth/init", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/cli/auth/claim", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(202) // always pending
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	start := time.Now()
	_, err := BrowserOAuthHandshake(context.Background(), OAuthOptions{
		BaseURL:      srv.URL,
		SkipBrowser:  true,
		PollInterval: 50 * time.Millisecond,
		Timeout:      300 * time.Millisecond,
		HTTPClient:   srv.Client(),
	})
	elapsed := time.Since(start)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Errorf("expected timeout error, got %v", err)
	}
	if elapsed > 2*time.Second {
		t.Errorf("timeout took way too long: %v", elapsed)
	}
}

func TestBrowserOAuthHandshake_OnAuthURLFires(t *testing.T) {
	var captured string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/auth/init", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/cli/auth/claim", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(claimResponse{ProjectID: "p", APIKey: "k"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	_, err := BrowserOAuthHandshake(context.Background(), OAuthOptions{
		BaseURL:     srv.URL,
		SkipBrowser: true,
		Timeout:     2 * time.Second,
		OnAuthURL:   func(u string) { captured = u },
		HTTPClient:  srv.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(captured, "/cli/auth?token=") {
		t.Errorf("OnAuthURL didn't fire correctly, got %q", captured)
	}
}

// --- WriteAPICredsToEnv -----------------------------------------------------

func TestWriteAPICredsToEnv_FreshFile(t *testing.T) {
	dir := t.TempDir()
	if err := WriteAPICredsToEnv(dir, OAuthClaim{APIKey: "k_test", ProjectID: "p_test"}); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, ".env.local"))
	mustContain(t, body, "GRAVEL_API_KEY=k_test")
	mustContain(t, body, "GRAVEL_PROJECT_ID=p_test")
}

func TestWriteAPICredsToEnv_PreservesExistingNonEmpty(t *testing.T) {
	dir := t.TempDir()
	pre := "GRAVEL_API_KEY=existing\nOTHER=keep\n"
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte(pre), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAPICredsToEnv(dir, OAuthClaim{APIKey: "new", ProjectID: "p"}); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, ".env.local"))
	mustContain(t, body, "GRAVEL_API_KEY=existing")
	mustNotContain(t, body, "GRAVEL_API_KEY=new")
	mustContain(t, body, "OTHER=keep")
	mustContain(t, body, "GRAVEL_PROJECT_ID=p")
}

func TestWriteAPICredsToEnv_OverwritesExistingEmpty(t *testing.T) {
	dir := t.TempDir()
	pre := "GRAVEL_API_KEY=\nGRAVEL_PROJECT_ID=\n"
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte(pre), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAPICredsToEnv(dir, OAuthClaim{APIKey: "real", ProjectID: "p_real"}); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, ".env.local"))
	mustContain(t, body, "GRAVEL_API_KEY=real")
	mustContain(t, body, "GRAVEL_PROJECT_ID=p_real")
	// The original empty entries should have been replaced, not
	// duplicated. Each var should appear exactly once with the value.
	if strings.Count(body, "GRAVEL_API_KEY=") != 1 {
		t.Errorf("GRAVEL_API_KEY appears more than once:\n%s", body)
	}
}
