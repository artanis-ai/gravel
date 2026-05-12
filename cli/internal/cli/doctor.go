package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/detect"
	"github.com/artanis-ai/gravel/cli/internal/doctor"
	"github.com/artanis-ai/gravel/cli/internal/version"
	"github.com/spf13/cobra"
)

func newDoctorCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "Show CLI version + latest release + the install/upgrade command.",
		Long: `doctor prints the version of the running CLI binary, the latest tag from
the gravel GitHub Releases, and the exact ` + "`curl | sh`" + ` install command to
upgrade. Stack-agnostic: the binary is installed via install.sh and lives on
PATH, so the upgrade story doesn't depend on pnpm/uv/etc.

Exits non-zero if there's an update available, so CI can gate on
'gravel doctor' without parsing output. Pass --json for a stable
machine-readable shape.

Honors GRAVEL_VERSION_CHECK_DISABLED=1 for offline / privacy-conscious envs.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("getwd: %w", err)
			}
			s := detect.HostStack(cwd)
			info := doctor.GetVersionInfo(context.Background(), s, version.Version, doctor.FetchLatest)
			if asJSON {
				enc := json.NewEncoder(cmd.OutOrStdout())
				enc.SetIndent("", "  ")
				if err := enc.Encode(info); err != nil {
					return err
				}
			} else {
				fmt.Fprintln(cmd.OutOrStdout(), doctor.Render(info))
			}
			if info.HasUpdate {
				// Non-zero exit so CI scripts can rely on the
				// return code alone. cobra's RunE doesn't take
				// an exit code directly; setting it on the
				// process is the canonical pattern.
				os.Exit(1)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit machine-readable JSON.")
	return cmd
}
