// gravel detect — print what the wizard knows about the host project.
//
// Agent-driven installs (see home-page/gravel/llms.txt) call `gravel
// detect --json` first so they can narrate the project's shape to the
// human before asking consent for the mount / prompts / traces pillars.
// The JSON shape is the contract; keep it stable across releases.
package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/wizard"
	"github.com/spf13/cobra"
)

func newDetectCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "detect",
		Short: "Print what the wizard sees about this project (language, framework, DB, LLM libs, auth).",
		Long: `Reads the cwd and reports the host project's shape without writing anything.

With --json, output is a stable machine-readable document agents can parse
to narrate the install to the user before any pillar runs.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			d := wizard.Detect(cwd)
			if asJSON {
				doc := wizard.DetectionJSON(d)
				enc := json.NewEncoder(cmd.OutOrStdout())
				enc.SetIndent("", "  ")
				return enc.Encode(doc)
			}
			printDetectionPretty(cmd, d)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit a stable JSON document instead of human-readable prose.")
	return cmd
}

func printDetectionPretty(cmd *cobra.Command, d wizard.Detection) {
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "Language:        %s\n", d.Language)
	fmt.Fprintf(w, "Package manager: %s\n", d.PackageManager)
	fmt.Fprintf(w, "Framework:       %s\n", d.Framework)
	if d.NextAppDir != "" {
		fmt.Fprintf(w, "Next app dir:    %s\n", d.NextAppDir)
	}
	if d.NextHasBothRouters {
		fmt.Fprintf(w, "Next routers:    BOTH (app + pages — mount goes to app router)\n")
	}
	fmt.Fprintf(w, "Database:        %s", d.DBDriver)
	if d.DBEnvVar != "" {
		fmt.Fprintf(w, " (env: %s)", d.DBEnvVar)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "Auth:            %s\n", d.Auth)
	fmt.Fprintf(w, "Git repo:        %t\n", d.HasGit)
	if len(d.LLMLibs) > 0 {
		fmt.Fprintf(w, "LLM SDKs:        ")
		for i, l := range d.LLMLibs {
			if i > 0 {
				fmt.Fprint(w, ", ")
			}
			fmt.Fprint(w, l)
		}
		fmt.Fprintln(w)
	}
}
