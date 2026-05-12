// Package version exposes the CLI's own version. The value is set by
// the linker at build time (via -ldflags "-X .../version.Version=..."),
// so a single Go module produces binaries that report whatever version
// the release pipeline tagged.
//
// Defaulting to "0.0.0-dev" makes local `go build` produce a binary
// that doesn't lie about being a real release.
package version

// Version is the semver string baked into this build.
//
// Overridden at link time:
//
//	go build -ldflags "-X github.com/artanis-ai/gravel/cli/internal/version.Version=0.3.0"
var Version = "0.0.0-dev"
