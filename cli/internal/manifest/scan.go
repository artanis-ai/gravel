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
// AST walk. Spec: gravel-cloud/docs/spec/manifest.md §3.
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
			// Re-hash the byte slice the manifest currently points at.
			// Position tracking when the body moves is a deep-scan job;
			// fast scan only updates the hash when the slice's content
			// drifts. Matches the TS reference behaviour + caveat.
			cs, ce := 0, 0
			if p.CharStart != nil {
				cs = *p.CharStart
			}
			if p.CharEnd != nil {
				ce = *p.CharEnd
			}
			if cs < 0 {
				cs = 0
			}
			if ce > len(content) {
				ce = len(content)
			}
			if ce < cs {
				ce = cs
			}
			slice := string(content[cs:ce])
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
	for _, d := range promptFileDirs {
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
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if _, ok := promptFileExts[ext]; !ok {
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
