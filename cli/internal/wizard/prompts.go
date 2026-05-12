package wizard

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// prompts.go provides the minimal interactive question primitives the
// wizard needs when run on a real TTY without --yes.
//
// We deliberately keep this line-based (bufio.Scanner) rather than
// pulling in a TUI framework like bubbletea or survey. Line-based
// prompts work over `gh codespace ssh` sessions, in container
// terminals without proper termios, and in CI loggers that don't
// surface ANSI cursor moves. The trade is that arrow-key navigation
// for multi-select isn't supported; users type the option's number
// (or 'y' / 'n') instead. Same UX shape as `npm init` and `pnpm
// create`.

// Prompter exposes the four question shapes the wizard actually
// uses. An implementation wraps stdin/stdout (interactive runs) or
// returns canned answers (CI / tests). The orchestrator never
// touches stdin directly; this interface is the only seam.
type Prompter interface {
	YesNo(question string, def bool) (bool, error)
	Select(question string, options []string, def int) (int, error)
	Text(question, def string) (string, error)
	Info(line string)
}

// NewTTYPrompter returns a Prompter that reads from in and writes
// to out. Pass os.Stdin / os.Stderr for the normal "interactive
// wizard" usage. Errors are surfaced rather than swallowed so a
// hung-up TTY doesn't deadlock the wizard.
func NewTTYPrompter(in io.Reader, out io.Writer) Prompter {
	return &ttyPrompter{in: bufio.NewReader(in), out: out}
}

type ttyPrompter struct {
	in  *bufio.Reader
	out io.Writer
}

func (p *ttyPrompter) Info(line string) {
	fmt.Fprintln(p.out, line)
}

func (p *ttyPrompter) YesNo(question string, def bool) (bool, error) {
	suffix := " [y/N] "
	if def {
		suffix = " [Y/n] "
	}
	for {
		fmt.Fprintf(p.out, "%s%s", question, suffix)
		line, err := p.in.ReadString('\n')
		if err != nil && err != io.EOF {
			return false, err
		}
		line = strings.TrimSpace(strings.ToLower(line))
		switch line {
		case "":
			return def, nil
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		}
		fmt.Fprintln(p.out, "  please answer y or n")
	}
}

func (p *ttyPrompter) Select(question string, options []string, def int) (int, error) {
	if def < 0 || def >= len(options) {
		def = 0
	}
	for {
		fmt.Fprintln(p.out, question)
		for i, opt := range options {
			marker := " "
			if i == def {
				marker = ">"
			}
			fmt.Fprintf(p.out, "  %s %d) %s\n", marker, i+1, opt)
		}
		fmt.Fprintf(p.out, "Pick 1-%d (default %d): ", len(options), def+1)
		line, err := p.in.ReadString('\n')
		if err != nil && err != io.EOF {
			return 0, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			return def, nil
		}
		n, err := strconv.Atoi(line)
		if err != nil || n < 1 || n > len(options) {
			fmt.Fprintf(p.out, "  please enter a number 1-%d\n", len(options))
			continue
		}
		return n - 1, nil
	}
}

func (p *ttyPrompter) Text(question, def string) (string, error) {
	suffix := ": "
	if def != "" {
		suffix = fmt.Sprintf(" [%s]: ", def)
	}
	fmt.Fprintf(p.out, "%s%s", question, suffix)
	line, err := p.in.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return def, nil
	}
	return line, nil
}

// IsTerminal reports whether fd is attached to a real terminal. Used
// by the cobra layer to pick between a real prompter and the
// "accept defaults" prompter — when stdin is a pipe (CI, scripts) we
// must NOT block on ReadString or the install hangs forever.
//
// Implemented via the same stat trick os/exec uses: a terminal is a
// character device. Works on Linux, macOS, and Windows (the runtime
// reports the appropriate file mode for ConsoleHandle).
func IsTerminal(fd uintptr) bool {
	f := os.NewFile(fd, "")
	if f == nil {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return (info.Mode() & os.ModeCharDevice) != 0
}

// DefaultsPrompter returns canned values for every question. Used in
// --yes mode and in tests. Each question prints nothing; the wizard's
// summary handles user-visible output instead.
type DefaultsPrompter struct{}

func (DefaultsPrompter) YesNo(_ string, def bool) (bool, error)               { return def, nil }
func (DefaultsPrompter) Select(_ string, _ []string, def int) (int, error)    { return def, nil }
func (DefaultsPrompter) Text(_ string, def string) (string, error)            { return def, nil }
func (DefaultsPrompter) Info(_ string)                                        {}

// PrompterFromOptions returns the right Prompter for the wizard's
// runtime mode. --yes / non-TTY  →  DefaultsPrompter (no blocking on
// stdin). Otherwise a tty prompter reading from os.Stdin.
func PrompterFromOptions(yesToAll bool) Prompter {
	if yesToAll || !IsTerminal(os.Stdin.Fd()) {
		return DefaultsPrompter{}
	}
	return NewTTYPrompter(os.Stdin, os.Stderr)
}
