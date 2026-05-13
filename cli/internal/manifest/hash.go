package manifest

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Hash normalization rules mirror packages/sdk-ts/src/manifest/hash.ts
// + python/gravel/src/artanis_gravel/manifest/hash.py.
//
// The contract is that cosmetic differences (line endings, trailing
// whitespace, leading/trailing blank lines) don't churn the hash, so
// reformatting prompt files doesn't generate spurious PRs.
var (
	crlfOrCr        = regexp.MustCompile(`\r\n?`)
	trailingWS      = regexp.MustCompile(`[ \t]+$`)
	leadingBlankRE  = regexp.MustCompile(`^(\s*\n)+`)
	trailingBlankRE = regexp.MustCompile(`(\n\s*)+$`)
)

// Normalize returns the canonical text representation used for hashing.
// Must match the TS + Python implementations byte-for-byte.
func Normalize(text string) string {
	// 1. CRLF / CR to LF.
	out := crlfOrCr.ReplaceAllString(text, "\n")
	// 2. Strip trailing whitespace on each line.
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		lines[i] = trailingWS.ReplaceAllString(line, "")
	}
	out = strings.Join(lines, "\n")
	// 3. Strip leading + trailing blank lines.
	out = leadingBlankRE.ReplaceAllString(out, "")
	out = trailingBlankRE.ReplaceAllString(out, "")
	return out
}

// HashPrompt returns the canonical prompt hash, prefixed with the
// algorithm tag (`sha256:`) so we can rotate digests in a future
// manifest version without breaking the parser.
func HashPrompt(text string) string {
	sum := sha256.Sum256([]byte(Normalize(text)))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// GeneratePromptID returns a stable, locally-unique id for a new
// prompt entry. Generated once at first detection and persisted; the
// id is what survives renames.
//
// Format: "p_" + 12 lowercase hex chars (48 bits of entropy from a
// sha1 over (path, position, time, random) seed). 48 bits is plenty
// for one repo's worth of prompts.
func GeneratePromptID(path string, charStart int) string {
	var rnd [8]byte
	_, _ = rand.Read(rnd[:])
	posTag := "file"
	if charStart >= 0 {
		posTag = fmt.Sprintf("%d", charStart)
	}
	seed := fmt.Sprintf("%s:%s:%d:%x", path, posTag, time.Now().UnixNano(), rnd)
	h := sha1.Sum([]byte(seed))
	return "p_" + hex.EncodeToString(h[:])[:12]
}
