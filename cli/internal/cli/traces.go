// gravel traces — install only the traces pillar.
package cli

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/wizard"
	"github.com/spf13/cobra"
)

func newTracesCmd() *cobra.Command {
	var (
		plan      bool
		apply     bool
		mountPath string
	)
	cmd := &cobra.Command{
		Use:   "traces",
		Short: "Install only the traces pillar (DB tables + auto-tracing hooks).",
		Long: `The Traces pillar: probes DATABASE_URL, runs idempotent CREATE TABLE
on gravel_samples + gravel_feedback in the host project's existing
database, installs framework-specific tracing hooks (instrumentation.ts
for Next.js), and rewrites the config so the dashboard's Review tab
knows the DB is wired up.

Agents: --plan returns a JSON action list + warns about missing /
placeholder / unreachable DATABASE_URL before the user commits to
schema changes. --apply does the work.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if plan && apply {
				return errors.New("--plan and --apply are mutually exclusive")
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			d := wizard.Detect(cwd)
			opts := wizard.TracesPillarOptions{
				Detection: d,
				MountPath: mountPath,
			}
			if plan {
				return emitJSON(cmd, wizard.PlanTraces(context.Background(), opts))
			}
			res, err := wizard.ApplyTraces(context.Background(), opts)
			if err != nil {
				return err
			}
			if res.MigrateApplied {
				fmt.Fprintln(cmd.OutOrStdout(), "gravel_samples + gravel_feedback created.")
			} else {
				fmt.Fprintln(cmd.OutOrStdout(), "Traces wired (tables already existed).")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&plan, "plan", false, "Emit a JSON action plan without writing anything.")
	cmd.Flags().BoolVar(&apply, "apply", false, "Execute the migrate + wiring (default).")
	cmd.Flags().StringVar(&mountPath, "mount-path", "/admin/ai", "Mount path the config should point at (must match the value used by `gravel mount`).")
	return cmd
}
