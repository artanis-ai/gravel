package wizard

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/term"
)

// path_completion.go: tab-completing path input for the manual-prompt-
// entry flow. Used in place of the plain p.Text path question when the
// user is on a real TTY with a real ttyPrompter — agents and scripted
// tests stay on the plain text input.
//
// Behavior (bash-style readline):
//   * Tab once  : extend to the longest common prefix of all matches.
//                 No extension possible? Ring the bell.
//   * Tab twice : list all candidates beneath the prompt line, then
//                 redraw the prompt with the user's current input.
//
// Completion globs `<input>*` against the project cwd, treats `~` and
// absolute paths as themselves, and appends `/` to directory matches
// so the user can keep tabbing through nested folders.

// pathCompletionResult is the output of CompletePath. Returned as a
// struct so tests can assert on each piece without unpacking five
// return values.
type pathCompletionResult struct {
	// Replacement is what the input should become after this Tab.
	// May equal the original input if there's no common prefix.
	Replacement string
	// Candidates is the list of matches that share the prefix, sorted
	// alphabetically. Empty when nothing matched.
	Candidates []string
	// AppendTrailingSep is true when the unique match is a directory;
	// the caller should append "/" (or os.PathSeparator) so the user
	// can continue tabbing into the dir.
	AppendTrailingSep bool
}

// CompletePath performs filesystem path completion for `input` rooted
// at `cwd`. Pure-ish — the only impurity is reading the filesystem to
// list candidates. Easy to test against a t.TempDir() tree.
//
// Returns a result whose Replacement is what the caller should set the
// input buffer to, and Candidates is what the caller should print when
// the user double-tapped Tab.
func CompletePath(cwd, input string) pathCompletionResult {
	// Split into "directory part already typed" vs "what the user is
	// currently typing". `src/age` splits to dir=`src/` and base=`age`.
	// `src/` itself splits to dir=`src/` and base=``.
	var dirPart, basePart string
	if i := strings.LastIndex(input, "/"); i >= 0 {
		dirPart = input[:i+1]
		basePart = input[i+1:]
	} else {
		basePart = input
	}

	listDir := filepath.Join(cwd, filepath.FromSlash(dirPart))
	entries, err := os.ReadDir(listDir)
	if err != nil {
		return pathCompletionResult{Replacement: input}
	}

	var matches []os.DirEntry
	for _, e := range entries {
		name := e.Name()
		// Hidden files: only offer them if the user explicitly typed a
		// leading dot. Standard readline-ish behavior.
		if strings.HasPrefix(name, ".") && !strings.HasPrefix(basePart, ".") {
			continue
		}
		if strings.HasPrefix(name, basePart) {
			matches = append(matches, e)
		}
	}
	if len(matches) == 0 {
		return pathCompletionResult{Replacement: input}
	}
	sort.Slice(matches, func(i, j int) bool {
		return matches[i].Name() < matches[j].Name()
	})

	// Build the visible candidate list (with trailing / for dirs so
	// the user knows what's a directory).
	candidates := make([]string, len(matches))
	for i, m := range matches {
		n := m.Name()
		if m.IsDir() {
			n += "/"
		}
		candidates[i] = n
	}

	// Unique match: complete fully. Append "/" for dirs.
	if len(matches) == 1 {
		full := dirPart + matches[0].Name()
		return pathCompletionResult{
			Replacement:       full,
			Candidates:        candidates,
			AppendTrailingSep: matches[0].IsDir(),
		}
	}

	// Multiple matches: extend to their longest common prefix.
	names := make([]string, len(matches))
	for i, m := range matches {
		names[i] = m.Name()
	}
	common := longestCommonPrefix(names)
	return pathCompletionResult{
		Replacement: dirPart + common,
		Candidates:  candidates,
	}
}

func longestCommonPrefix(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	pref := ss[0]
	for _, s := range ss[1:] {
		// Trim pref down until s starts with it.
		for !strings.HasPrefix(s, pref) {
			pref = pref[:len(pref)-1]
			if pref == "" {
				return ""
			}
		}
	}
	return pref
}

// readPathWithCompletion drives a raw-mode line editor on `in` (which
// must be a real TTY) for path entry, with Tab completion against
// `cwd`. Returns the entered string (without trailing newline) or an
// error when the terminal couldn't be put into raw mode or stdin
// closed early.
//
// Editing keys supported:
//   * Tab               — completion (common-prefix then list)
//   * Enter             — submit
//   * Backspace / Ctrl-H— delete previous char
//   * Ctrl-U            — clear line
//   * Ctrl-C            — cancel (returns ErrCancelled)
//   * Ctrl-W            — delete previous word (boundary = '/' or ' ')
//
// Arrow keys / history are intentionally not supported; this is a
// one-shot prompt, not a full shell.
func readPathWithCompletion(
	in *os.File,
	out io.Writer,
	cwd, question string,
) (string, error) {
	fd := int(in.Fd())
	st, err := term.MakeRaw(fd)
	if err != nil {
		return "", fmt.Errorf("could not enter raw mode: %w", err)
	}
	defer term.Restore(fd, st)

	fmt.Fprintf(out, "%s ", question)

	var buf []byte
	lastWasTab := false
	one := make([]byte, 1)

	for {
		n, err := in.Read(one)
		if err != nil || n == 0 {
			fmt.Fprint(out, "\r\n")
			if errors.Is(err, io.EOF) || err == nil {
				return string(buf), nil
			}
			return "", err
		}
		c := one[0]

		switch c {
		case '\r', '\n': // Enter
			fmt.Fprint(out, "\r\n")
			return string(buf), nil

		case 0x03: // Ctrl-C
			fmt.Fprint(out, "^C\r\n")
			return "", ErrCancelled

		case 0x15: // Ctrl-U  → clear line
			buf = buf[:0]
			redrawPathLine(out, question, buf)
			lastWasTab = false

		case 0x17: // Ctrl-W  → delete previous word
			buf = deletePrevWord(buf)
			redrawPathLine(out, question, buf)
			lastWasTab = false

		case 0x7f, 0x08: // Backspace / Ctrl-H
			if len(buf) > 0 {
				buf = buf[:len(buf)-1]
				redrawPathLine(out, question, buf)
			}
			lastWasTab = false

		case '\t': // Tab
			res := CompletePath(cwd, string(buf))
			if res.Replacement == string(buf) && len(res.Candidates) == 0 {
				// Nothing matched — ring the bell, no redraw.
				fmt.Fprint(out, "\a")
				lastWasTab = false
				continue
			}
			if res.Replacement != string(buf) {
				next := res.Replacement
				if res.AppendTrailingSep && len(res.Candidates) == 1 {
					next += "/"
				}
				buf = []byte(next)
				redrawPathLine(out, question, buf)
				lastWasTab = false
				continue
			}
			// Replacement == input, but there ARE candidates: this is
			// the "nothing to add" case. First Tab rings the bell;
			// second Tab in a row lists.
			if !lastWasTab {
				fmt.Fprint(out, "\a")
				lastWasTab = true
				continue
			}
			fmt.Fprint(out, "\r\n")
			printCandidates(out, res.Candidates)
			redrawPathLine(out, question, buf)
			lastWasTab = false

		default:
			// Ignore other control bytes; accept printable ASCII +
			// any UTF-8 byte sequences (we'll see each byte in turn
			// because we read one at a time, which is fine for echo
			// purposes — paths in this repo are ASCII).
			if c < 0x20 {
				continue
			}
			buf = append(buf, c)
			out.Write([]byte{c})
			lastWasTab = false
		}
	}
}

// ErrCancelled is returned by readPathWithCompletion when the user
// hits Ctrl-C at the prompt. Callers treat it as "drop this entry".
var ErrCancelled = errors.New("input cancelled by user")

// redrawPathLine rewrites the current input line. We don't track
// cursor column; we just go back to column 0 with \r, clear the line
// (\x1b[K), and reprint everything.
func redrawPathLine(out io.Writer, question string, buf []byte) {
	fmt.Fprintf(out, "\r\x1b[K%s %s", question, string(buf))
}

// printCandidates writes the candidate list to out, one per line.
// Used after a double-Tab. Keeps things simple — no column packing.
func printCandidates(out io.Writer, candidates []string) {
	for _, c := range candidates {
		fmt.Fprintln(out, c)
	}
}

// deletePrevWord deletes everything from the end of buf back to (but
// not including) the previous "/" or " ", plus the immediately-
// trailing delimiter so consecutive Ctrl-Ws step up directory levels.
//
// `src/agents/triage.py`  →  `src/agents/`  →  `src/`  →  ``
func deletePrevWord(buf []byte) []byte {
	if len(buf) == 0 {
		return buf
	}
	// Drop trailing delimiter so Ctrl-W on `src/agents/` jumps to `src/`
	// rather than just stripping the empty tail.
	i := len(buf)
	if buf[i-1] == '/' || buf[i-1] == ' ' {
		i--
	}
	for i > 0 && buf[i-1] != '/' && buf[i-1] != ' ' {
		i--
	}
	return buf[:i]
}
