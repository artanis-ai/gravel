// Package stack defines the host's language + package manager — the
// two pieces of context every CLI command needs to render
// stack-appropriate output (e.g. `pnpm update …` vs `uv pip install
// --upgrade …`).
//
// The detector itself lives in `internal/detect`. Putting the types in
// their own package keeps the dependency graph clean: any package that
// needs to *talk about* a stack imports `stack`, but only `detect`
// needs to walk the filesystem.
package stack

// Language is the host's primary language as inferred from manifest
// files in its repo root. We don't try to support polyglot repos in
// v0; the wizard targets one language at a time.
type Language string

const (
	LanguageTS     Language = "ts"
	LanguagePython Language = "python"
)

// PackageManager is the host's package manager as inferred from
// lockfiles. The full set covers both TS and Python ecosystems; the
// `Language` field disambiguates which family.
type PackageManager string

const (
	// TS family.
	PackageManagerPNPM PackageManager = "pnpm"
	PackageManagerNPM  PackageManager = "npm"
	PackageManagerYarn PackageManager = "yarn"
	PackageManagerBun  PackageManager = "bun"
	// Python family.
	PackageManagerUV     PackageManager = "uv"
	PackageManagerPoetry PackageManager = "poetry"
	PackageManagerPipenv PackageManager = "pipenv"
	PackageManagerPip    PackageManager = "pip"
)

// Stack is the pair we use everywhere downstream.
type Stack struct {
	Language       Language
	PackageManager PackageManager
}

// PackageName returns the registry-canonical package name for the
// detected language. Identical concept to "what string do we put
// after the @ in the upgrade command".
func (s Stack) PackageName() string {
	if s.Language == LanguagePython {
		return "artanis-gravel"
	}
	return "@artanis-ai/gravel"
}
