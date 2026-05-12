// Package cli wires the cobra command tree. Keeping the binding here
// (separate from each command's domain package in `internal/<cmd>/`)
// lets us unit-test the domain logic without dragging in cobra and
// vice versa.
package cli

import (
	"github.com/artanis-ai/gravel/cli/internal/version"
	"github.com/spf13/cobra"
)

// NewRoot returns a fresh root command. Constructor (not a global)
// because tests want to drive isolated invocations without state
// leaking between cases.
func NewRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "gravel",
		Short:         "Embedded prompt management, tracing, and evals.",
		Long:          rootLong,
		Version:       version.Version,
		SilenceUsage:  true, // don't dump usage on every error
		SilenceErrors: false,
	}
	root.SetVersionTemplate("gravel {{.Version}}\n")
	root.AddCommand(newDoctorCmd())
	root.AddCommand(newInitCmd())
	root.AddCommand(newManifestCmd())
	root.AddCommand(newMigrateCmd())
	return root
}

const rootLong = `gravel: embedded prompt management, tracing, and evals for AI engineering teams.

A single binary that drives ` + "`gravel init`" + `, ` + "`manifest`" + `, ` + "`migrate`" + `, and ` + "`doctor`" + ` for
both TypeScript and Python projects. Install with:

  curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh

For library/runtime APIs, see the per-language SDKs:
  https://gravel.artanis.ai/docs/sdk-ts
  https://gravel.artanis.ai/docs/sdk-python
`
