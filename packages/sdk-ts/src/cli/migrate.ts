/**
 * `gravel migrate` — runs the schema bootstrap idempotently.
 */
import { runBootstrap } from '../wizard/migrate.js'

export async function runMigrate(): Promise<void> {
  await runBootstrap(process.cwd())
  console.log('Schema bootstrap complete.')
}
