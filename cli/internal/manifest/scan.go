// Fast scan over the working tree to keep .gravel/manifest.json in
// sync with the user's prompt files.
//
// As of v0.9.0 the scan walks the WHOLE repo (respecting .gitignore)
// instead of only the conventional `prompts/`, `templates/`, etc.
// directories. The previous behaviour missed real-world layouts
// (Olly's de_platform kept prompts under `api/py/prompts/`); the
// v0.8.1 `prompt_scan_roots` config field was a band-aid we've now
// removed. Any `promptScanRoots` in gravel_config emits a one-time
// deprecation warning at the CLI layer.
package manifest

import (
	"bufio"
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// promptFileExts is the allowlist of file extensions a fast scan
// picks up automatically. Kept in sync with
// packages/sdk-ts/src/manifest/scan.ts. Added `.mdx` / `.mdc` in
// v0.9.0 per Olly's dogfooding (Cursor rules + MDX docs).
var promptFileExts = map[string]struct{}{
	".md":       {},
	".markdown": {},
	".txt":      {},
	".mdx":      {},
	".mdc":      {},
}

// docDirNames is the case-insensitive set of directory names that the
// fast scan refuses to recurse into when looking for prompts. The
// canonical shape is `prompts/docs/how-to-write.md` — documentation
// about the prompts, not the prompts themselves. Same with
// `templates/examples/`. The walker drops any path whose segments
// include one of these names; the full-repo v0.9.0 walker means we
// have to filter by path component rather than the old SkipDir.
var docDirNames = map[string]struct{}{
	"docs":          {},
	"doc":           {},
	"documentation": {},
	"examples":      {},
	// v0.10.0 additions from Olly's dogfooding: .github holds PR /
	// issue templates that are markdown but not prompts; tests / spec
	// dirs hold .md fixtures that look prompt-shaped but are not.
	".github":    {},
	"tests":      {},
	"test":       {},
	"__tests__":  {},
	"spec":       {},
	"specs":      {},
	"__fixtures__": {},
	"fixtures":   {},
	// Knowledge-base / agent context. Files here are reference material
	// the host app reads at runtime, not prompts under review.
	"kb":          {},
	"knowledge":   {},
	"knowledgebase": {},
}

// docFilenames is the case-insensitive denylist of conventional
// documentation filenames (without extension) the fast scan refuses
// to ingest as prompts. Without this, a project that keeps a
// `README.md` next to its prompts ends up with the README itself as
// a fake prompt in the manifest.
//
// Source: the set of files GitHub treats as project metadata + a few
// extras seen in real customer repos.
var docFilenames = map[string]struct{}{
	"README":          {},
	"CHANGELOG":       {},
	"CONTRIBUTING":    {},
	"LICENSE":         {},
	"LICENCE":         {},
	"NOTICE":          {},
	"AUTHORS":         {},
	"MAINTAINERS":     {},
	"HISTORY":         {},
	"CHANGES":         {},
	"SECURITY":        {},
	"CODE_OF_CONDUCT": {},
	"COPYING":         {},
	"INSTALL":         {},
	"TODO":            {},
	"ROADMAP":         {},
	"USAGE":           {},
	// v0.10.0 additions from Olly's dogfooding 2026-05-21. CLAUDE /
	// GEMINI / AGENTS are agent-config files; AI tools like Cursor /
	// Aider use them to seed system prompts. Not user-edited prompts.
	"CLAUDE":          {},
	"GEMINI":          {},
	"AGENTS":          {},
	// GitHub templates — markdown that looks prompt-shaped but is repo
	// metadata for the PR / issue workflow.
	"ISSUE_TEMPLATE":         {},
	"PULL_REQUEST_TEMPLATE":  {},
	// Dependency manifests (`.txt` form). The `.txt` extension hits the
	// allowlist; without this filter requirements.txt lands as a prompt.
	"REQUIREMENTS":     {},
	"REQUIREMENTS-DEV": {},
	"PIPFILE":          {},
	"CONSTRAINTS":      {},
	// Other commonly-co-located metadata.
	"CONFIG":  {},
	"VERSION": {},
}

// defaultIgnoreDirs is the FS-walk fallback's safety net for projects
// that aren't a git repo (or git CLI is unavailable). When git is
// present we let .gitignore decide; this list only kicks in when we
// have to recurse manually.
var defaultIgnoreDirs = map[string]struct{}{
	"node_modules": {},
	".git":         {},
	".venv":        {},
	"venv":         {},
	".env":         {},
	"__pycache__":  {},
	"dist":         {},
	"build":        {},
	"out":          {},
	"target":       {},
	".next":        {},
	".nuxt":        {},
	".svelte-kit":  {},
	".turbo":       {},
	".cache":       {},
	".pytest_cache": {},
	".mypy_cache":  {},
	".tox":         {},
	".gradle":      {},
	".idea":        {},
	".vscode":      {},
	"coverage":     {},
	"vendor":       {},
}

// isDocFilename returns true when filename (e.g. "README.md")
// matches the docFilenames denylist. Case-insensitive stem match.
func isDocFilename(filename string) bool {
	stem := strings.ToUpper(strings.TrimSuffix(filename, filepath.Ext(filename)))
	_, ok := docFilenames[stem]
	return ok
}

// isInDocDir returns true when any segment of the repo-relative path
// matches docDirNames (case-insensitive). Skips `prompts/docs/...`
// and `templates/examples/...` style subtrees so docs about prompts
// don't pollute the manifest.
func isInDocDir(relPath string) bool {
	for _, seg := range strings.Split(relPath, "/") {
		if _, ok := docDirNames[strings.ToLower(seg)]; ok {
			return true
		}
	}
	return false
}

// hasPromptExt is the canonical extension check the scanner uses.
// Exported because callers (e.g. the deep-scan agent) want the same
// rule.
func hasPromptExt(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	_, ok := promptFileExts[ext]
	return ok
}

// FastScanResult bundles the updated manifest with counts that the
// CLI surfaces to the user.
type FastScanResult struct {
	Manifest  Manifest
	Added     int
	Removed   int
	Changed   int
	Unchanged int
}

// FastScan re-scans the working tree against the existing manifest.
// Pure function modulo file I/O. Returns the new manifest plus
// counts; the caller decides whether to persist via Write().
//
// As of v0.9.0 the scan walks the full repo respecting .gitignore
// (via `git ls-files`) rather than only a hardcoded set of dirs.
// Falls back to a filesystem walk + a conservative ignore list when
// git isn't available.
func FastScan(repoRoot string, current Manifest) (FastScanResult, error) {
	result := FastScanResult{
		Manifest: Manifest{
			Version:            current.Version,
			LastFullScanCommit: current.LastFullScanCommit,
			LastFullScanAt:     current.LastFullScanAt,
			Prompts:            []Prompt{},
		},
	}
	// Default missing-version manifests to the current schema (Read()
	// already guards against unknown versions). This lets callers pass
	// Empty() through unchanged.
	if result.Manifest.Version == 0 {
		result.Manifest.Version = Version
	}

	// 1. Update / preserve existing entries.
	for _, p := range current.Prompts {
		filePath := filepath.Join(repoRoot, p.Path)
		content, err := os.ReadFile(filePath)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				result.Removed++
				continue
			}
			return FastScanResult{}, err
		}
		switch p.Type {
		case PromptFile:
			newHash := HashPrompt(string(content))
			if newHash == p.Hash {
				result.Manifest.Prompts = append(result.Manifest.Prompts, p)
				result.Unchanged++
			} else {
				updated := p
				updated.Hash = newHash
				result.Manifest.Prompts = append(result.Manifest.Prompts, updated)
				result.Changed++
			}
		case PromptEmbedded:
			// Re-hash the code-point slice the manifest currently
			// points at. Position tracking when the body moves is the
			// deep-scan's job; fast scan only updates the hash when
			// the slice's content drifts. Offsets are CODE POINTS
			// (matches Python str slicing), never bytes — see
			// offsets.go for the cross-stack contract.
			cs, ce := 0, 0
			if p.CharStart != nil {
				cs = *p.CharStart
			}
			if p.CharEnd != nil {
				ce = *p.CharEnd
			}
			text := string(content)
			cpLen := CodePointLen(text)
			if cs < 0 {
				cs = 0
			}
			if ce > cpLen {
				ce = cpLen
			}
			if ce < cs {
				ce = cs
			}
			slice := SliceByCodePoints(text, cs, ce)
			newHash := HashPrompt(slice)
			if newHash == p.Hash {
				result.Manifest.Prompts = append(result.Manifest.Prompts, p)
				result.Unchanged++
			} else {
				updated := p
				updated.Hash = newHash
				result.Manifest.Prompts = append(result.Manifest.Prompts, updated)
				result.Changed++
			}
		}
	}

	// 2. Discover new file-type prompts anywhere in the repo
	// (respecting .gitignore). The walk yields repo-relative,
	// forward-slashed paths.
	known := make(map[string]struct{}, len(current.Prompts))
	for _, p := range current.Prompts {
		known[p.Path] = struct{}{}
	}

	candidates, err := walkRepoFiles(repoRoot)
	if err != nil {
		return FastScanResult{}, err
	}
	for _, rel := range candidates {
		if _, dup := known[rel]; dup {
			continue
		}
		if !hasPromptExt(rel) {
			continue
		}
		if isDocFilename(filepath.Base(rel)) {
			continue
		}
		if isInDocDir(rel) {
			// Any path with a `docs/`, `doc/`, `documentation/`, or
			// `examples/` segment is documentation about the prompts,
			// not a prompt — skip wholesale.
			continue
		}
		content, err := os.ReadFile(filepath.Join(repoRoot, rel))
		if err != nil {
			// Vanished between enumeration and read — skip rather
			// than abort the whole scan.
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return FastScanResult{}, err
		}
		result.Manifest.Prompts = append(result.Manifest.Prompts, Prompt{
			ID:   GeneratePromptID(rel, -1),
			Type: PromptFile,
			Path: rel,
			Hash: HashPrompt(string(content)),
		})
		result.Added++
	}

	// Sort for deterministic output. Same ordering rule as the TS
	// reference (lexicographic by path).
	sort.Slice(result.Manifest.Prompts, func(i, j int) bool {
		return result.Manifest.Prompts[i].Path < result.Manifest.Prompts[j].Path
	})
	return result, nil
}

// walkRepoFiles returns repo-relative, forward-slashed paths of every
// candidate file in the repo, respecting .gitignore when possible.
//
// Strategy:
//  1. Try `git ls-files --cached --others --exclude-standard` which
//     yields tracked + untracked-but-not-ignored files. This honours
//     .gitignore, global gitignore, and .git/info/exclude — exactly
//     what the user expects.
//  2. If git isn't available or `repoRoot` isn't a git repo, fall back
//     to filepath.WalkDir + defaultIgnoreDirs (so we don't dive into
//     node_modules / .venv / dist on a fresh clone with no .git/).
func walkRepoFiles(repoRoot string) ([]string, error) {
	if files, ok := gitListFiles(repoRoot); ok {
		return files, nil
	}
	return fsWalkFiles(repoRoot)
}

// gitListFiles runs `git ls-files` and parses the output. Returns
// (paths, true) on success; (nil, false) when git is unavailable or
// the directory isn't a working tree.
func gitListFiles(repoRoot string) ([]string, bool) {
	// `-z` makes git use NUL separators so paths containing newlines
	// don't corrupt the list.
	cmd := exec.Command("git",
		"-C", repoRoot,
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
	)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = nil // git's stderr noise (e.g. dubious-ownership) goes nowhere
	if err := cmd.Run(); err != nil {
		return nil, false
	}
	raw := stdout.Bytes()
	out := make([]string, 0, bytes.Count(raw, []byte{0})+1)
	for _, p := range bytes.Split(raw, []byte{0}) {
		if len(p) == 0 {
			continue
		}
		// git already emits forward-slashed paths.
		out = append(out, string(p))
	}
	return out, true
}

// fsWalkFiles is the fallback when git isn't available. Skips
// well-known dependency / build / cache directories so the wizard
// doesn't crawl 50k files in node_modules.
func fsWalkFiles(repoRoot string) ([]string, error) {
	out := make([]string, 0, 64)
	err := filepath.WalkDir(repoRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == repoRoot {
				return nil
			}
			name := d.Name()
			if _, skip := defaultIgnoreDirs[name]; skip {
				return filepath.SkipDir
			}
			// Skip any dot-directory by default (`.cache`, `.idea`,
			// etc.) unless the user explicitly tracks them under git.
			if strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(repoRoot, path)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Buffered scan supports very large outputs; cap a giant repo at a
	// reasonable size for the in-memory representation.
	_ = bufio.NewScanner
	return out, nil
}
