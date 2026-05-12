package wizard

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ui.go: ANSI-color helpers + step/bullet/spinner primitives for the
// wizard's terminal output. Ports packages/sdk-ts/src/wizard/ui.ts
// from the pre-port TS wizard so the Go binary's installer reads the
// same way users were used to.
//
// Design (carried over from the TS reference): the wizard speaks like
// a teacher walking through a notebook — short paragraphs (`Say`),
// step headings, bullet results, pause-for-enter checkpoints. No
// clack-style left rails, no boxed panels.
//
// Falls back to plain text whenever stdout isn't a TTY (or NO_COLOR is
// set). Tests in non-TTY contexts see every helper degrade to a clean
// plain-text line.

// --- color detection --------------------------------------------------------

// hasColor / hasTTY are evaluated once at process start; tests that
// need to flip them use the SetUIOutput helper below.
var (
	uiOut     io.Writer = os.Stderr
	hasColor            = IsTerminal(os.Stderr) && os.Getenv("NO_COLOR") == ""
	hasTTY              = IsTerminal(os.Stderr)
	uiSync    sync.Mutex
)

// SetUIOutput points the UI helpers at a new writer. Tests use this
// to capture output; production code leaves the default (stderr).
func SetUIOutput(w io.Writer, color bool) {
	uiSync.Lock()
	defer uiSync.Unlock()
	uiOut = w
	hasColor = color
	hasTTY = color
}

// --- color wrappers ---------------------------------------------------------

func wrap(openCode, closeCode int) func(string) string {
	open := fmt.Sprintf("\x1b[%dm", openCode)
	close := fmt.Sprintf("\x1b[%dm", closeCode)
	return func(s string) string {
		if !hasColor {
			return s
		}
		return open + s + close
	}
}

// Brand uses 256-color sandstone 215, matching the lander accent.
func brandWrap(s string) string {
	if !hasColor {
		return s
	}
	return "\x1b[38;5;215m" + s + "\x1b[39m"
}

// Bold etc. are simple wrappers; exposed so callers can compose
// inline ("Mounting %s" with %s being Bold("/admin/ai")).
var (
	Bold    = wrap(1, 22)
	Dim     = wrap(2, 22)
	Italic  = wrap(3, 23)
	Red     = wrap(31, 39)
	Green   = wrap(32, 39)
	Yellow  = wrap(33, 39)
	Cyan    = wrap(36, 39)
	Gray    = wrap(90, 39)
	Brand   = brandWrap
)

// --- structural primitives --------------------------------------------------

// Welcome prints the top-of-wizard greeting.
func Welcome(title, subtitle string) {
	uiSync.Lock()
	defer uiSync.Unlock()
	fmt.Fprintln(uiOut)
	fmt.Fprintln(uiOut, Brand(Bold(title)))
	if subtitle != "" {
		fmt.Fprintln(uiOut, Dim(subtitle))
	}
	fmt.Fprintln(uiOut)
}

// StepHeader prints a "Step N of M  Title" heading with a divider
// underneath sized to the heading's visible length.
func StepHeader(num, total int, title string) {
	uiSync.Lock()
	defer uiSync.Unlock()
	if !hasColor {
		fmt.Fprintf(uiOut, "\nStep %d of %d: %s\n%s\n\n", num, total, title, strings.Repeat("-", 40))
		return
	}
	head := fmt.Sprintf("%s  %s", Brand(fmt.Sprintf("Step %d of %d", num, total)), Bold(title))
	divLen := visibleLen(head)
	fmt.Fprintln(uiOut)
	fmt.Fprintln(uiOut, head)
	fmt.Fprintln(uiOut, Dim(strings.Repeat("─", divLen)))
	fmt.Fprintln(uiOut)
}

// Say prints a paragraph of conversational text followed by a blank line.
func Say(text string) {
	uiSync.Lock()
	defer uiSync.Unlock()
	fmt.Fprintln(uiOut, text)
	fmt.Fprintln(uiOut)
}

// Note prints a subtle (dimmed) aside.
func Note(text string) {
	uiSync.Lock()
	defer uiSync.Unlock()
	fmt.Fprintln(uiOut, Dim(text))
}

// BulletKind discriminates the marker symbol + color on a Bullet line.
type BulletKind int

const (
	BulletOK BulletKind = iota
	BulletFail
	BulletWarn
	BulletSkip
	BulletInfo
	BulletPlain
)

// Bullet prints an indented single-line result under a step heading.
//   ✓ ok (green)
//   ✗ fail (red)
//   ▲ warn (yellow)
//   · skip / plain (dim)
//   · info (brand)
func Bullet(text string, kind BulletKind) {
	uiSync.Lock()
	defer uiSync.Unlock()
	sym := "·"
	switch kind {
	case BulletOK:
		sym = "✓"
	case BulletFail:
		sym = "✗"
	case BulletWarn:
		sym = "▲"
	}
	if !hasColor {
		fmt.Fprintf(uiOut, "  %s %s\n", sym, text)
		return
	}
	var colored string
	switch kind {
	case BulletOK:
		colored = Green(sym)
	case BulletFail:
		colored = Red(sym)
	case BulletWarn:
		colored = Yellow(sym)
	case BulletInfo:
		colored = Brand(sym)
	default:
		colored = Dim(sym)
	}
	fmt.Fprintf(uiOut, "  %s %s\n", colored, text)
}

// Done prints the wizard's final bold closing line.
func Done(text string) {
	uiSync.Lock()
	defer uiSync.Unlock()
	fmt.Fprintln(uiOut)
	fmt.Fprintln(uiOut, Bold(text))
	fmt.Fprintln(uiOut)
}

// --- spinner ----------------------------------------------------------------

// Spinner is a single-line braille spinner that occupies one terminal
// row. Always replaces itself with a ✓ / ✗ on Stop / Fail. On non-TTY
// stdout it degrades to a static "  · label…" line on Start and a
// "  ✓ label" line on Stop.
type Spinner struct {
	label  string
	done   chan struct{}
	wg     sync.WaitGroup
	tty    bool
	stopped bool
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// NewSpinner kicks off the spinner. Callers MUST call Stop or Fail.
func NewSpinner(label string) *Spinner {
	s := &Spinner{label: label, done: make(chan struct{}), tty: hasTTY}
	if !s.tty {
		uiSync.Lock()
		fmt.Fprintf(uiOut, "  · %s…\n", strings.TrimSuffix(label, "…"))
		uiSync.Unlock()
		return s
	}
	uiSync.Lock()
	fmt.Fprintf(uiOut, "  %s %s\x1b[K", Brand(spinnerFrames[0]), label)
	uiSync.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		i := 0
		t := time.NewTicker(80 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-s.done:
				return
			case <-t.C:
				i = (i + 1) % len(spinnerFrames)
				uiSync.Lock()
				fmt.Fprintf(uiOut, "\r  %s %s\x1b[K", Brand(spinnerFrames[i]), s.label)
				uiSync.Unlock()
			}
		}
	}()
	return s
}

// Stop replaces the spinner with a green ✓ + message.
func (s *Spinner) Stop(msg string) {
	if s.stopped {
		return
	}
	s.stopped = true
	if msg == "" {
		msg = s.label
	}
	if s.tty {
		close(s.done)
		s.wg.Wait()
		uiSync.Lock()
		fmt.Fprintf(uiOut, "\r  %s %s\x1b[K\n", Green("✓"), msg)
		uiSync.Unlock()
		return
	}
	uiSync.Lock()
	fmt.Fprintf(uiOut, "  ✓ %s\n", msg)
	uiSync.Unlock()
}

// Fail replaces the spinner with a red ✗ + message (rendered red).
func (s *Spinner) Fail(msg string) {
	if s.stopped {
		return
	}
	s.stopped = true
	if msg == "" {
		msg = s.label
	}
	if s.tty {
		close(s.done)
		s.wg.Wait()
		uiSync.Lock()
		fmt.Fprintf(uiOut, "\r  %s %s\x1b[K\n", Red("✗"), Red(msg))
		uiSync.Unlock()
		return
	}
	uiSync.Lock()
	fmt.Fprintf(uiOut, "  ✗ %s\n", msg)
	uiSync.Unlock()
}

// --- helpers ---------------------------------------------------------------

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// visibleLen returns the column width of a string with ANSI escapes
// stripped — used to size dividers under colored headings.
func visibleLen(s string) int {
	return len([]rune(ansiRE.ReplaceAllString(s, "")))
}
