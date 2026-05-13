package wizard

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
)

// editor_pick.go: interactive-selection helper for the wizard's
// manual-prompt-entry path. Replaces the "type the start line, end
// line, and char offsets" UX with: spawn the user's editor on a
// temp copy of the file, ask them to delete everything outside the
// prompt, then convert the remaining content back to char offsets
// against the original.
//
// Humans (TTY runs) get the editor flow. Agents (--yes, non-TTY,
// `gravel scan --deep` invocations) stay on the explicit line/char-
// number prompts because they're scripting against a known shape.
//
// The "delete around" UX is intentional: works in every editor
// (vim, emacs, nano, VSCode with -w, neovim, helix, ...) without
// requiring a TUI lib or custom keybindings. The user uses their
// editor's normal selection + delete primitives.

// EditorEnv is the env-var name the helper checks for an editor
// override; standard POSIX convention. Exposed so tests can swap it.
const EditorEnv = "EDITOR"

// defaultEditor is the fallback when $EDITOR is unset. `vi` is on
// every POSIX system; nano would be friendlier but isn't universally
// installed in container images. The user can override via $EDITOR.
const defaultEditor = "vi"

// EditorPickResult captures what the user selected, expressed as
// offsets into the original (un-edited) source. CharStart / CharEnd
// are Unicode code-point indices (NOT bytes), matching the manifest
// wire format. Empty when the user declined / didn't select anything
// actionable.
type EditorPickResult struct {
	CharStart int
	CharEnd   int
	LineStart int // 1-indexed
	LineEnd   int // 1-indexed, inclusive
}

// editorPickSelection runs the interactive editor-based selection
// against `original` content. Writes the content to a temp file,
// spawns $EDITOR, waits for the user to save+exit, then matches the
// remaining content against the original to compute offsets.
//
// Returns (result, true) on a clean selection; (zero, false) when:
//   - the user didn't change the file (treated as "skip")
//   - the user saved an empty file (treated as "cancel")
//   - the remaining content isn't a contiguous substring of the
//     original (the user edited rather than just deleted)
//   - the editor exited non-zero (e.g. they :q! out of vim)
//
// The caller decides how to surface each failure; on the false path
// they typically fall back to the line-number prompts.
func editorPickSelection(original string, filenameHint string) (EditorPickResult, bool, error) {
	tmp, err := writeEditorTempFile(filenameHint, original)
	if err != nil {
		return EditorPickResult{}, false, err
	}
	defer os.Remove(tmp)

	if err := spawnEditor(tmp); err != nil {
		// Editor exited non-zero. Treat as "user cancelled".
		return EditorPickResult{}, false, nil
	}

	body, err := os.ReadFile(tmp)
	if err != nil {
		return EditorPickResult{}, false, err
	}
	selection := string(body)

	res, ok := findSelectionOffsets(original, selection)
	if !ok {
		return EditorPickResult{}, false, nil
	}
	return res, true, nil
}

// writeEditorTempFile creates a temp copy of `original` with the
// extension borrowed from the source path (so editors with syntax
// highlighting honor the language). Returns the temp file path.
func writeEditorTempFile(filenameHint, original string) (string, error) {
	// Preserve the file extension so vim/VSCode/etc. pick the right
	// syntax highlighter. The hint is the user's source path; we
	// just need the suffix.
	suffix := ""
	if i := strings.LastIndex(filenameHint, "."); i >= 0 {
		suffix = filenameHint[i:]
	}
	if suffix == "" {
		suffix = ".txt"
	}
	f, err := os.CreateTemp("", "gravel-pick-*"+suffix)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.WriteString(original); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// spawnEditor runs $EDITOR (or `vi`) against path. Wires stdin /
// stdout / stderr to the parent's TTY so the editor can take user
// input. Blocks until the editor exits.
//
// $EDITOR can contain arguments (e.g. `code -w`, `subl -w`). The
// helper splits on whitespace for the common case — users with
// shell-quoted env values would already have problems with most
// tooling that consumes $EDITOR.
func spawnEditor(path string) error {
	editor := strings.TrimSpace(os.Getenv(EditorEnv))
	if editor == "" {
		editor = defaultEditor
	}
	// Split into argv. `code -w foo.ts` → ["code", "-w", "foo.ts"].
	fields := strings.Fields(editor)
	args := append(fields[1:], path)
	cmd := exec.Command(fields[0], args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// findSelectionOffsets converts the user's edited content into
// offsets against the original. The "delete around" UX means the
// edited content should be a CONTIGUOUS SUBSTRING of the original;
// if the user inserted or modified characters, the match fails.
//
// Lenience:
//   - The user's edit may have leading / trailing whitespace from
//     accidental partial-line keeps; we trim ASCII whitespace before
//     searching so the offsets land on the actual prompt content.
//   - The unchanged case (selection == original) is treated as "user
//     didn't select anything" (return false). The caller's outer
//     flow already asks "whole file?" first.
//
// Returns false when the trimmed selection is empty, the
// unchanged-file case, or when the selection isn't a substring.
func findSelectionOffsets(original, selection string) (EditorPickResult, bool) {
	trimmed := strings.TrimSpace(selection)
	if trimmed == "" {
		return EditorPickResult{}, false
	}
	if strings.TrimSpace(original) == trimmed {
		// User saved without removing anything — treat as no
		// selection, let the caller decide what to do (typically
		// fall back to the whole-file path).
		return EditorPickResult{}, false
	}
	byteIdx := strings.Index(original, trimmed)
	if byteIdx < 0 {
		// User edited the content (didn't just delete around it).
		return EditorPickResult{}, false
	}
	// Convert byte offsets (Go-native) to code-point offsets (manifest
	// wire format). Same characters either way for pure ASCII; differ
	// the moment the surrounding source contains an em-dash, smart
	// quote, accented letter, or emoji.
	charStart := manifest.ByteOffsetToCodePoint(original, byteIdx)
	charEnd := charStart + manifest.CodePointLen(trimmed)
	lineStart := 1 + strings.Count(original[:byteIdx], "\n")
	lineEnd := lineStart + strings.Count(trimmed, "\n")
	return EditorPickResult{
		CharStart: charStart,
		CharEnd:   charEnd,
		LineStart: lineStart,
		LineEnd:   lineEnd,
	}, true
}

// canSpawnEditor reports whether the editor-pick flow can run for this
// prompter + stdin combination. We require both:
//   - the prompter is the real *ttyPrompter (test fakes and the
//     DefaultsPrompter both fail this check)
//   - os.Stdin is a real character device (the editor needs a TTY to
//     accept input; piped stdin would have it spin against /dev/null)
//
// Returning false routes the caller into the line-number fallback,
// which is the agent / scripted-test path anyway.
func canSpawnEditor(p Prompter) bool {
	if _, ok := p.(*ttyPrompter); !ok {
		return false
	}
	return IsTerminal(os.Stdin)
}

// editorPickHint is the brief message shown to the user before the
// editor opens. Kept short: the editor will dominate the screen
// once it spawns.
func editorPickHint() string {
	editor := os.Getenv(EditorEnv)
	if editor == "" {
		editor = defaultEditor
	}
	return fmt.Sprintf(
		"Opening %s. Delete everything OUTSIDE the prompt you want to capture, then save + exit.",
		editor,
	)
}
