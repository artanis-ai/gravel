// gravel mount — install the dashboard pillar in isolation.
//
// Designed for agent-driven flows: --plan emits a JSON description of
// what would change so the agent can narrate to the human and ask
// consent; --apply does the work. The interactive `gravel init` calls
// the same wizard.PlanMount / ApplyMount under the hood so behaviour
// stays in lockstep.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/wizard"
	"github.com/spf13/cobra"
)

func newMountCmd() *cobra.Command {
	var (
		plan      bool
		apply     bool
		mountPath string
		apiKey    string
		projectID string
	)
	cmd := &cobra.Command{
		Use:   "mount",
		Short: "Install only the dashboard (mount route + config + admin password).",
		Long: `The Dashboard pillar: mounts the admin UI at /admin/ai (override with
--mount-path), writes gravel.config.{ts,py}, generates a 32-byte admin
password into .env.local, and patches host-framework wiring (Next.js,
Clerk, Vercel, FastAPI) as needed.

Agents: run with --plan first to get a JSON action list, narrate it to
the user, ask consent, then re-run with --apply. The two flags are
mutually exclusive; default (neither) is equivalent to --apply.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if plan && apply {
				return errors.New("--plan and --apply are mutually exclusive")
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			d := wizard.Detect(cwd)
			opts := wizard.MountPillarOptions{
				Detection: d,
				MountPath: mountPath,
				APIKey:    coalesceEnv(apiKey, "GRAVEL_API_KEY"),
				ProjectID: coalesceEnv(projectID, "GRAVEL_PROJECT_ID"),
			}
			if plan {
				return emitJSON(cmd, wizard.PlanMount(context.Background(), opts))
			}
			res, err := wizard.ApplyMount(context.Background(), opts)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Mounted at %s (config: %s)\n", coalesce(mountPath, "/admin/ai"), res.ConfigPath)
			return nil
		},
	}
	cmd.Flags().BoolVar(&plan, "plan", false, "Emit a JSON action plan without writing anything.")
	cmd.Flags().BoolVar(&apply, "apply", false, "Execute the mount (default; mutually exclusive with --plan).")
	cmd.Flags().StringVar(&mountPath, "mount-path", "/admin/ai", "URL path to mount the dashboard at.")
	cmd.Flags().StringVar(&apiKey, "api-key", "", "Pre-bake project key into .env.local. Reads $GRAVEL_API_KEY if unset.")
	cmd.Flags().StringVar(&projectID, "project", "", "Pre-bake project ID into .env.local. Reads $GRAVEL_PROJECT_ID if unset.")
	return cmd
}

// coalesceEnv returns explicit if non-empty, otherwise os.Getenv(envVar).
func coalesceEnv(explicit, envVar string) string {
	if explicit != "" {
		return explicit
	}
	return os.Getenv(envVar)
}

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func emitJSON(cmd *cobra.Command, v any) error {
	enc := json.NewEncoder(cmd.OutOrStdout())
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
