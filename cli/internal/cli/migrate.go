package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/dotenv"
	"github.com/artanis-ai/gravel/cli/internal/migrate"
	"github.com/spf13/cobra"
)

func newMigrateCmd() *cobra.Command {
	var (
		urlFlag string
	)
	cmd := &cobra.Command{
		Use:   "migrate",
		Short: "Apply pending Gravel DB migrations (or bootstrap on fresh DB).",
		Long: `migrate brings the gravel_* tables in your DATABASE_URL up to the version
this CLI was built for.

The DATABASE_URL is read from (in order): --url flag, the shell env, then
.env.<NODE_ENV>.local, .env.<NODE_ENV>, .env.local, .env in cwd.

On a fresh DB this runs the idempotent CREATE TABLE bootstrap. Once
Drizzle-format migration files ship in the SDK, this command will apply
them on top instead.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			url := urlFlag
			if url == "" {
				env := dotenv.LoadCwd(cwd)
				for _, k := range []string{"DATABASE_URL", "POSTGRES_URL", "NEON_DATABASE_URL"} {
					if v, ok := env[k]; ok && v != "" {
						url = v
						break
					}
				}
			}
			if url == "" {
				return fmt.Errorf(
					"no DATABASE_URL detected. Set it in .env.local, or pass --url. " +
						"Accepted prefixes: postgres://, postgresql://, file:, sqlite:.",
				)
			}
			ctx := context.Background()
			db, d, err := migrate.Open(ctx, url)
			if err != nil {
				return err
			}
			defer db.Close()
			if err := migrate.Bootstrap(ctx, db, d); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Schema bootstrap complete (%s).\n", d)
			return nil
		},
	}
	cmd.Flags().StringVar(&urlFlag, "url", "", "Override DATABASE_URL.")
	return cmd
}
