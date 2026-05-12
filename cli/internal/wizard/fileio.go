package wizard

import "os"

// readFile is a thin wrapper that returns the file body as a string;
// kept package-local so the wizard's many tiny lookups don't repeat
// the same five-line boilerplate.
func readFile(p string) (string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
