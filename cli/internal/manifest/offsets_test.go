package manifest

import "testing"

// Multi-byte test corpus: each of these characters has a different
// byte / UTF-16-unit / code-point count, so they catch the cross-stack
// divergence the rewrite is meant to fix.
//
//   é      : 2 bytes UTF-8, 1 UTF-16 unit, 1 code point
//   —      : 3 bytes UTF-8, 1 UTF-16 unit, 1 code point
//   ’      : 3 bytes UTF-8, 1 UTF-16 unit, 1 code point
//   🎯     : 4 bytes UTF-8, 2 UTF-16 units, 1 code point

func TestCodePointLen(t *testing.T) {
	cases := []struct {
		s    string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"é", 1},
		{"—", 1},
		{"’", 1},
		{"🎯", 1},
		{"café — 🎯", 8}, // c a f é space — space 🎯
	}
	for _, c := range cases {
		if got := CodePointLen(c.s); got != c.want {
			t.Errorf("CodePointLen(%q) = %d, want %d", c.s, got, c.want)
		}
	}
}

func TestSliceByCodePoints_ASCII(t *testing.T) {
	s := "Hello, world!"
	if got := SliceByCodePoints(s, 0, 5); got != "Hello" {
		t.Errorf("got %q want %q", got, "Hello")
	}
	if got := SliceByCodePoints(s, 7, 12); got != "world" {
		t.Errorf("got %q want %q", got, "world")
	}
}

func TestSliceByCodePoints_MultiByte(t *testing.T) {
	s := "café — 🎯 done"
	// Index map (code points):
	//   0=c 1=a 2=f 3=é 4=space 5=— 6=space 7=🎯 8=space 9=d 10=o 11=n 12=e
	cases := []struct {
		cpStart, cpEnd int
		want           string
	}{
		{0, 4, "café"},
		{3, 4, "é"},
		{5, 6, "—"},
		{7, 8, "🎯"},
		{0, 13, s},
		{9, 13, "done"},
	}
	for _, c := range cases {
		if got := SliceByCodePoints(s, c.cpStart, c.cpEnd); got != c.want {
			t.Errorf("SliceByCodePoints(%d,%d) = %q want %q", c.cpStart, c.cpEnd, got, c.want)
		}
	}
}

func TestSliceByCodePoints_ClampsOutOfRange(t *testing.T) {
	s := "abc"
	if got := SliceByCodePoints(s, -5, 2); got != "ab" {
		t.Errorf("negative start: got %q", got)
	}
	if got := SliceByCodePoints(s, 1, 999); got != "bc" {
		t.Errorf("end past EOF: got %q", got)
	}
	if got := SliceByCodePoints(s, 2, 1); got != "" {
		t.Errorf("inverted range: got %q", got)
	}
	if got := SliceByCodePoints("", 0, 5); got != "" {
		t.Errorf("empty input: got %q", got)
	}
}

func TestByteOffsetToCodePoint(t *testing.T) {
	s := "café"
	// bytes: c(1) a(1) f(1) é(2). Total 5 bytes.
	cases := []struct {
		byteOff, cpWant int
	}{
		{0, 0},
		{1, 1},
		{2, 2},
		{3, 3},
		{5, 4}, // past é
	}
	for _, c := range cases {
		if got := ByteOffsetToCodePoint(s, c.byteOff); got != c.cpWant {
			t.Errorf("ByteOffsetToCodePoint(%d) = %d want %d", c.byteOff, got, c.cpWant)
		}
	}
}

func TestCodePointToByteOffset(t *testing.T) {
	s := "café 🎯"
	cases := []struct {
		cp, byteWant int
	}{
		{0, 0},
		{1, 1},
		{3, 3},
		{4, 5},    // past é (2 bytes)
		{5, 6},    // past space
		{6, 10},   // past 🎯 (4 bytes)
		{100, 10}, // clamps to len
	}
	for _, c := range cases {
		if got := CodePointToByteOffset(s, c.cp); got != c.byteWant {
			t.Errorf("CodePointToByteOffset(%d) = %d want %d", c.cp, got, c.byteWant)
		}
	}
}

func TestLineToCodePointOffset_MultiByte(t *testing.T) {
	s := "café\né🎯\nend"
	// Lines (0-indexed): "café" (cp 0..4), "é🎯" (cp 5..7), "end" (cp 8..11)
	// \n eats one code point at the line end.
	cases := []struct {
		line, want int
	}{
		{0, 0},
		{1, 5},  // after "café\n"
		{2, 8},  // after "é🎯\n"
		{3, 11}, // EOF (trailing line w/o \n)
		{4, -1}, // past EOF
	}
	for _, c := range cases {
		if got := LineToCodePointOffset(s, c.line); got != c.want {
			t.Errorf("LineToCodePointOffset(%d) = %d want %d", c.line, got, c.want)
		}
	}
}

func TestLineContentCodePoints(t *testing.T) {
	s := "café\né🎯\nend"
	cases := []struct {
		line, startWant, endWant int
	}{
		{1, 0, 4},  // "café"
		{2, 5, 7},  // "é🎯"
		{3, 8, 11}, // "end"
		{4, -1, -1},
	}
	for _, c := range cases {
		s2, e2 := LineContentCodePoints(s, c.line)
		if s2 != c.startWant || e2 != c.endWant {
			t.Errorf("LineContentCodePoints(%d) = (%d,%d) want (%d,%d)", c.line, s2, e2, c.startWant, c.endWant)
		}
	}
}

// RoundTrip is the headline test: write offsets in code points, slice
// them back. Must match for content that mixes ASCII and multi-byte
// chars. This is exactly the flow the SDK handler executes when the
// dashboard fetches /api/prompts/:id.
func TestSliceByCodePoints_RoundTripFromAnchors(t *testing.T) {
	prompt := "You’re a kind assistant — guide them to the 🎯 with care."
	source := "// HEADER: préfixe\nconst SYSTEM_PROMPT = `" + prompt + "`\n"
	// Find the prompt body anchors as the agent contract does.
	startsWith := "You’re a kind"
	endsWith := "with care."

	// Resolve manually (the same arithmetic enrichFinding does).
	lineStart, lineEnd := LineContentCodePoints(source, 2)
	lineText := SliceByCodePoints(source, lineStart, lineEnd)
	// Find startsWith in the line (any indexing — byte/cp doesn't matter
	// for the search itself; convert the result back to code points).
	for byteIdx := 0; byteIdx < len(lineText); byteIdx++ {
		if byteIdx+len(startsWith) > len(lineText) {
			t.Fatal("startsWith not found in line")
		}
		if lineText[byteIdx:byteIdx+len(startsWith)] == startsWith {
			cpStart := lineStart + ByteOffsetToCodePoint(lineText, byteIdx)
			// EndsWith (last occurrence on same line).
			endByteIdx := -1
			for j := 0; j+len(endsWith) <= len(lineText); j++ {
				if lineText[j:j+len(endsWith)] == endsWith {
					endByteIdx = j
				}
			}
			if endByteIdx < 0 {
				t.Fatal("endsWith not found in line")
			}
			cpEnd := lineStart + ByteOffsetToCodePoint(lineText, endByteIdx) + CodePointLen(endsWith)
			got := SliceByCodePoints(source, cpStart, cpEnd)
			if got != prompt {
				t.Fatalf("round-trip slice mismatch:\n got: %q\nwant: %q", got, prompt)
			}
			return
		}
	}
	t.Fatal("startsWith not found in lineText")
}
