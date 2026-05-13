package manifest

import "unicode/utf8"

// Offset arithmetic for prompt manifests.
//
// Manifest `charStart` / `charEnd` are Unicode CODE-POINT indices into
// the source file content. Not bytes (Go's native string indexing) and
// not UTF-16 code units (JS / TS native). Code points are the only unit
// that matches across Go, TS, and Python without conversion math at
// every read/write boundary; Python's `str[a:b]` is already code points,
// so picking code points lets the SDK handler slice manifest entries
// directly.
//
// Use these helpers wherever a manifest offset is read or written. Never
// pass a manifest offset to a Go byte-slice or a TS `string.slice()`
// without going through SliceByCodePoints / sliceByCodePoints first —
// any non-ASCII character (em-dash, smart quote, emoji, accented letter)
// will desync the indices and chop the wrong characters.

// CodePointLen returns the number of Unicode code points in s.
func CodePointLen(s string) int {
	return utf8.RuneCountInString(s)
}

// SliceByCodePoints returns the substring of s from code-point index
// cpStart (inclusive) to cpEnd (exclusive). Out-of-range indices clamp
// to [0, CodePointLen(s)]. Returns "" when the clamped range is empty.
func SliceByCodePoints(s string, cpStart, cpEnd int) string {
	if cpStart < 0 {
		cpStart = 0
	}
	if cpEnd < cpStart {
		cpEnd = cpStart
	}
	cp := 0
	byteStart, byteEnd := -1, -1
	for i := range s { // range over a string iterates by rune; i is the byte offset
		if cp == cpStart && byteStart < 0 {
			byteStart = i
		}
		if cp == cpEnd {
			byteEnd = i
			break
		}
		cp++
	}
	if byteStart < 0 {
		// cpStart is at or past the end of the string.
		if cpStart == cp {
			return ""
		}
		return ""
	}
	if byteEnd < 0 {
		// cpEnd ran past the end; clamp to len(s).
		byteEnd = len(s)
	}
	return s[byteStart:byteEnd]
}

// CodePointToByteOffset converts a code-point index to its UTF-8 byte
// offset. Out-of-range inputs clamp to 0 / len(s).
func CodePointToByteOffset(s string, cp int) int {
	if cp <= 0 {
		return 0
	}
	n := 0
	for i := range s {
		if n == cp {
			return i
		}
		n++
	}
	return len(s)
}

// ByteOffsetToCodePoint converts a UTF-8 byte offset to the code-point
// index of the character starting at that byte. byteOff must be on a
// UTF-8 boundary; values that land mid-rune snap to the next rune.
func ByteOffsetToCodePoint(s string, byteOff int) int {
	if byteOff <= 0 {
		return 0
	}
	cp := 0
	for i := range s {
		if i >= byteOff {
			return cp
		}
		cp++
	}
	return cp
}

// LineToCodePointOffset returns the code-point offset (into s) of the
// start of the (0-indexed) line N. line == 0 returns 0 (start of file).
// line >= total-line-count returns CodePointLen(s) when s has no
// trailing newline on its last line; -1 only for negative input or a
// requested line strictly past EOF.
//
// Newline character (\n) counts as one code point on the line it ends.
// CRLF is not recognised; callers that need it should strip \r first.
func LineToCodePointOffset(s string, line int) int {
	if line < 0 {
		return -1
	}
	if line == 0 {
		return 0
	}
	cp := 0
	lineCount := 0
	for _, r := range s {
		if r == '\n' {
			cp++
			lineCount++
			if lineCount == line {
				return cp
			}
			continue
		}
		cp++
	}
	// Past the final newline: the requested line is the trailing
	// (no-newline) line. Its start is end-of-file.
	if lineCount == line-1 {
		return cp
	}
	if lineCount >= line {
		return cp
	}
	return -1
}

// LineContentCodePoints returns the code-point start and end offsets of
// (1-indexed) line N in s — `end` points one past the line's last
// non-newline character. Returns (-1, -1) if `line` is past EOF or
// non-positive. Use this to bound an anchored substring search to a
// single line.
func LineContentCodePoints(s string, line int) (start, end int) {
	if line < 1 {
		return -1, -1
	}
	start = LineToCodePointOffset(s, line-1)
	if start < 0 {
		return -1, -1
	}
	nextLineStart := LineToCodePointOffset(s, line)
	if nextLineStart < 0 {
		// Past EOF — line doesn't exist.
		return -1, -1
	}
	end = nextLineStart
	// Drop the trailing \n that ended this line, if any.
	if end > start && SliceByCodePoints(s, end-1, end) == "\n" {
		end--
	}
	return start, end
}
