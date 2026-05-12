package manifest

// LineToCharOffset returns the byte offset into `text` of the start
// of the (0-indexed) line N. A 0 input returns 0 (start of file).
// `LineToCharOffset(text, lineCount)` returns len(text) — convenient
// for callers asking "end of line K" by passing K+1.
//
// Returns -1 when the requested line is past EOF.
//
// Mirrors packages/sdk-ts/src/manifest/offsets.ts so manifest
// entries written by either implementation point at identical byte
// ranges in the same source file. Test coverage in manifest_test.go.
func LineToCharOffset(text string, line int) int {
	if line < 0 {
		return -1
	}
	if line == 0 {
		return 0
	}
	count := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			count++
			if count == line {
				return i + 1
			}
		}
	}
	if count >= line || (count+1 == line && len(text) > 0 && text[len(text)-1] != '\n') {
		// Reached EOF on the requested line (last line, no trailing newline).
		return len(text)
	}
	if count == line-1 {
		return len(text)
	}
	return -1
}
