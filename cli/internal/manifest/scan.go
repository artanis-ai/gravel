package manifest

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FastScan covers the pre-commit-hook path: pure file I/O, no LLM, no
// AST walk.
//
// Catches:
//   - Edits to known prompts (re-hash, update positions)
//   - New `.md`/`.txt`/`.prompt` files in conventional prompt dirs
//   - Deletions (drop entries whose backing file is gone)
//
// Does NOT detect new embedded prompts in code; that's deep-scan's
// job (LLM-assisted, separate command).

// promptFileDirs are the conventional directories the wizard looks
// inside for new `.md` / `.txt` / `.prompt` files. Kept in sync with
// packages/sdk-ts/src/manifest/scan.ts.
var promptFileDirs = []string{"prompts", "prompt", "templates", "assistants", "agents"}

// promptFileExts is the allowlist of new-file extensions a fast scan
// will pick up automatically.
var promptFileExts = map[string]struct{}{
	".md":     {},
	".txt":    {},
	".prompt": {},
}

// docFilenames is the case-insensitive denylist of conventional
// documentation filenames (without extension) the fast scan refuses
// to ingest as prompts. Without this, a project that keeps a
// `prompts/README.md` describing its own prompt conventions ends up
// with the README itself as a fake prompt in the manifest. The user
// can still add a genuinely-named-README prompt via the wizard's
// manual-entry path.
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
}

// docDirNames is the set of subdirectory names INSIDE a conventional
// prompt dir that fast-scan skips wholesale. Common pattern:
// `prompts/docs/` for "how to write good prompts" docs. The whole
// subtree gets pruned via filepath.SkipDir.
var docDirNames = map[string]struct{}{
	"docs":          {},
	"doc":           {},
	"documentation": {},
	"examples":      {},
}

// isDocFilename returns true when filename (e.g. "README.md")
// matches the docFilenames denylist. Case-insensitive stem match.
func isDocFilename(filename string) bool {
	stem := strings.ToUpper(strings.TrimSuffix(filename, filepath.Ext(filename)))
	_, ok := docFilenames[stem]
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
// Reads the optional `promptScanRoots` field from the project's
// gravel_config.{ts,py} via FastScanWithRoots. The bare FastScan is
// the historical shape — convenience for callers that don't have a
// reason to override.
func FastScan(repoRoot string, current Manifest) (FastScanResult, error) {
	return FastScanWithRoots(repoRoot, current, nil)
}

// FastScanWithRoots is FastScan with an explicit override list of
// directories to scan in addition to the conventional defaults. Pass
// nil for `extraRoots` to get the default list (`prompts/`,
// `templates/`, etc. — see promptFileDirs). Olly's de_platform install
// kept prompts under `api/py/prompts/` which isn't in the default
// list; the wizard now lets users set `promptScanRoots` in their
// gravel_config and routes it through here.
func FastScanWithRoots(repoRoot string, current Manifest, extraRoots []string) (FastScanResult, error) {
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
			// the slice's content drifts. Matches the TS reference
			// behaviour + caveat. Offsets are CODE POINTS (matches
			// Python str slicing), never bytes — see offsets.go for
			// the cross-stack contract.
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

	// 2. Discover new file-type prompts in conventional dirs.
	known := make(map[string]struct{}, len(current.Prompts))
	for _, p := range current.Prompts {
		known[p.Path] = struct{}{}
	}
	// Union the conventional dirs with any user-configured extras. We
	// dedupe so a config that re-lists a default dir doesn't double-
	// scan it; preserve insertion order so output is deterministic.
	scanRoots := make([]string, 0, len(promptFileDirs)+len(extraRoots))
	seenRoots := make(map[string]struct{}, len(promptFileDirs)+len(extraRoots))
	for _, d := range append(append([]string{}, promptFileDirs...), extraRoots...) {
		if d = strings.TrimSpace(d); d == "" {
			continue
		}
		// Normalise to forward slash for the dedupe key so a user
		// passing "api\\py\\prompts" on Windows doesn't escape it.
		key := filepath.ToSlash(d)
		if _, dup := seenRoots[key]; dup {
			continue
		}
		seenRoots[key] = struct{}{}
		scanRoots = append(scanRoots, d)
	}
	for _, d := range scanRoots {
		dirAbs := filepath.Join(repoRoot, d)
		info, err := os.Stat(dirAbs)
		if err != nil || !info.IsDir() {
			continue
		}
		err = filepath.WalkDir(dirAbs, func(path string, dirent fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if dirent.IsDir() {
				// Skip subtrees that are clearly docs about the
				// prompts rather than prompts themselves (e.g.
				// prompts/docs/, templates/examples/). Don't apply
				// to the top-level promptFileDirs entry itself.
				if path != dirAbs {
					if _, skip := docDirNames[strings.ToLower(dirent.Name())]; skip {
						return filepath.SkipDir
					}
				}
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if _, ok := promptFileExts[ext]; !ok {
				return nil
			}
			// Skip conventional doc filenames (README.md, LICENSE.md,
			// CHANGELOG.md, ...). They sit alongside genuine prompts
			// to document them and would otherwise pollute the
			// manifest with non-prompt entries.
			if isDocFilename(dirent.Name()) {
				return nil
			}
			rel, err := filepath.Rel(repoRoot, path)
			if err != nil {
				return err
			}
			// Forward-slash for cross-platform manifest stability.
			rel = filepath.ToSlash(rel)
			if _, dup := known[rel]; dup {
				return nil
			}
			content, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			result.Manifest.Prompts = append(result.Manifest.Prompts, Prompt{
				ID:   GeneratePromptID(rel, -1),
				Type: PromptFile,
				Path: rel,
				Hash: HashPrompt(string(content)),
			})
			result.Added++
			return nil
		})
		if err != nil {
			return FastScanResult{}, err
		}
	}

	// Sort for deterministic output. Same ordering rule as the TS
	// reference (lexicographic by path).
	sort.Slice(result.Manifest.Prompts, func(i, j int) bool {
		return result.Manifest.Prompts[i].Path < result.Manifest.Prompts[j].Path
	})
	return result, nil
}
