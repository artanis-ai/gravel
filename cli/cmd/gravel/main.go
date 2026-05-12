// gravel — single-binary CLI for the Gravel SDK.
//
// Entrypoint is intentionally tiny: build the cobra root, execute it,
// surface the error code. All real logic lives in internal/.
package main

import (
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/cli"
)

func main() {
	root := cli.NewRoot()
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "gravel:", err)
		os.Exit(1)
	}
}
