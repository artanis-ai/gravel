package manifest

import "strings"

// Diff renders a human-readable summary of how manifest a evolves
// into manifest b. The output drives the polite-blocking pre-commit
// hook's stderr message, so each line is grep-able and the format is
// stable across releases.
//
// Format:
//   + <path>     (added)
//   - <path>     (removed)
//   ~ <path>     (content changed)
//
// Order is: removed, changed, added; matches the TS reference.
func Diff(a, b Manifest) string {
	beforeByID := make(map[string]Prompt, len(a.Prompts))
	for _, p := range a.Prompts {
		beforeByID[p.ID] = p
	}
	afterByID := make(map[string]Prompt, len(b.Prompts))
	for _, p := range b.Prompts {
		afterByID[p.ID] = p
	}

	var lines []string
	for _, p := range a.Prompts {
		after, ok := afterByID[p.ID]
		if !ok {
			lines = append(lines, "- "+p.Path+" (removed)")
			continue
		}
		if after.Hash != p.Hash {
			lines = append(lines, "~ "+p.Path+" (content changed)")
		}
	}
	for _, p := range b.Prompts {
		if _, ok := beforeByID[p.ID]; !ok {
			lines = append(lines, "+ "+p.Path+" (added)")
		}
	}
	return strings.Join(lines, "\n")
}
