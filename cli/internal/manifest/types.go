// Package manifest mirrors packages/sdk-ts/src/manifest/. The JSON
// wire shape is contractual: both the dashboard reader and the
// pre-commit hook diff on the file, so the bytes have to be
// byte-compatible with what the previous TS implementation wrote.
//
// Wire shape §2.
package manifest

// MANIFEST_VERSION + MANIFEST_PATH track the TS constants. Keep in
// sync; a bump here implies a migration step in UPGRADING.md.
const (
	Version = 1
	Path    = ".gravel/manifest.json"
)

// PromptType discriminates the two prompt entry variants on the wire.
type PromptType string

const (
	PromptFile     PromptType = "file"
	PromptEmbedded PromptType = "embedded"
)

// Prompt is the unified wire shape for both variants. The pointer
// fields are only populated for embedded prompts; omitempty keeps the
// JSON for file-type entries minimal (matching the TS output).
//
// Using pointers (not zero-elision) because charStart=0 is a valid
// position for an embedded prompt at the start of a file; we can't
// confuse "absent" with "zero".
type Prompt struct {
	ID   string     `json:"id"`
	Type PromptType `json:"type"`
	Path string     `json:"path"`
	Hash string     `json:"hash"`

	// Embedded-only fields.
	LineStart *int    `json:"lineStart,omitempty"`
	LineEnd   *int    `json:"lineEnd,omitempty"`
	CharStart *int    `json:"charStart,omitempty"`
	CharEnd   *int    `json:"charEnd,omitempty"`
	VarName   *string `json:"varName,omitempty"`
}

// Manifest is the top-level document at .gravel/manifest.json.
type Manifest struct {
	Version            int      `json:"version"`
	LastFullScanCommit *string  `json:"lastFullScanCommit"`
	LastFullScanAt     *string  `json:"lastFullScanAt"`
	Prompts            []Prompt `json:"prompts"`
}

// Empty returns a new, blank manifest ready to be populated.
func Empty() Manifest {
	return Manifest{
		Version:            Version,
		LastFullScanCommit: nil,
		LastFullScanAt:     nil,
		Prompts:            []Prompt{},
	}
}
