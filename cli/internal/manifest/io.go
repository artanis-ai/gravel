package manifest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Read loads .gravel/manifest.json relative to repoRoot.
//
// Returns Empty() if the file is missing (fresh repo). Returns an
// error if the file exists but its version disagrees with this
// binary's supported Version, because reading newer manifests blindly
// would silently drop unknown fields.
func Read(repoRoot string) (Manifest, error) {
	path := filepath.Join(repoRoot, Path)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Empty(), nil
		}
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, fmt.Errorf("parse %s: %w", Path, err)
	}
	if m.Version != Version {
		return Manifest{}, fmt.Errorf(
			"manifest version %d not supported by this CLI (expected %d). "+
				"Upgrade gravel via install.sh",
			m.Version, Version,
		)
	}
	return m, nil
}

// Write serializes manifest to .gravel/manifest.json under repoRoot,
// creating directories as needed. The output is pretty-printed
// (2-space indent, trailing newline) for human PR review; this matches
// the TS implementation byte-for-byte.
func Write(repoRoot string, m Manifest) error {
	// json.Marshal escapes HTML by default (`<`, `>`, `&` → \u00XX).
	// We don't want that for human-readable manifests; use an encoder
	// with SetEscapeHTML(false). 2-space indent for parity with TS's
	// JSON.stringify(_, null, 2).
	out, err := marshalManifest(m)
	if err != nil {
		return err
	}
	path := filepath.Join(repoRoot, Path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

// marshalManifest is split out so tests can assert on the exact bytes
// the manifest serializes to. Uses the streaming encoder with
// SetEscapeHTML(false) so the output matches TS's JSON.stringify
// (which doesn't HTML-escape) byte-for-byte.
func marshalManifest(m Manifest) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(m); err != nil {
		return nil, err
	}
	// json.Encoder.Encode appends a single trailing newline (matches
	// TS's `+ '\n'`).
	return buf.Bytes(), nil
}
