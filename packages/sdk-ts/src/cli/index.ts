#!/usr/bin/env node
/**
 * `gravel` CLI binary. Lightweight command dispatcher; each subcommand is its
 * own module so they can be unit-tested in isolation.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md §6
 */
import { runWizard } from '../wizard/index.js'
import { runManifestCheck, runManifestUpdate } from './manifest.js'
import { runDoctor } from './doctor.js'
import { runMigrate } from './migrate.js'

const HELP = `gravel — embedded prompt management, tracing, and evals.

Usage: gravel <command> [options]

Commands:
  init                       Run the install wizard (always local — no
                             cloud sign-in from the CLI).
  manifest --check           Verify .artanis/manifest.json is in sync (used by hook).
  manifest --update          Regenerate .artanis/manifest.json from working tree.
  manifest --list            Print human-readable summary of current manifest.
  scan --deep                Run deep LLM scan locally (NOT YET IMPLEMENTED).
  migrate                    Apply pending DB migrations (uses bootstrap.ts in v0).
  doctor                     Diagnostic: DB, manifest, hook, tracing.
  help                       Show this message.

Init flags:
  --api-key <key>            CI / scripted installs: pre-bake this project key
                             into .env. Requires --project as well.
  --project <id>             CI / scripted installs: pre-bake this project ID.
  --mount-path <path>        Override default '/admin/ai'.
  --no-migrate               Skip running migrations.
  --no-hook                  Skip pre-commit hook installation.
  --no-deep-scan             Skip deep scan (also skipped while not implemented).
  --no-test-trace            Skip test trace.

Cloud features (judge, analyze, evals) are gated behind a sign-in flow that
lives in the dashboard, not the CLI. Visit /admin/ai and click any cloud
feature to enable them on this project.

Docs: https://gravel.artanis.ai/docs
Issues: https://github.com/artanis-ai/gravel/issues
`

interface ParsedArgs {
  cmd: string
  flags: Record<string, string | boolean>
}

function parse(argv: string[]): ParsedArgs {
  const [cmd = 'help', ...rest] = argv
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    }
  }
  return { cmd, flags }
}

async function main(): Promise<void> {
  const { cmd, flags } = parse(process.argv.slice(2))

  switch (cmd) {
    case 'init':
      await runWizard({
        apiKey: typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined,
        project: typeof flags.project === 'string' ? flags.project : undefined,
        mountPath: typeof flags['mount-path'] === 'string' ? flags['mount-path'] : undefined,
        noMigrate: !!flags['no-migrate'],
        noHook: !!flags['no-hook'],
        noDeepScan: !!flags['no-deep-scan'],
        noTestTrace: !!flags['no-test-trace'],
      })
      break

    case 'manifest':
      if (flags.check) await runManifestCheck()
      else if (flags.update) await runManifestUpdate()
      else if (flags.list) await runManifestUpdate({ printOnly: true })
      else {
        console.error('manifest: pass --check, --update, or --list')
        process.exit(2)
      }
      break

    case 'scan':
      if (flags.deep) {
        console.error('[gravel] Deep scan not yet implemented. Tracking in gravel-cloud/docs/blockers.md.')
        process.exit(1)
      }
      console.error('scan: pass --deep')
      process.exit(2)
      break

    case 'migrate':
      await runMigrate()
      break

    case 'doctor':
      await runDoctor()
      break

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      break

    default:
      console.error(`Unknown command: ${cmd}\n`)
      console.log(HELP)
      process.exit(2)
  }
}

main().catch((err) => {
  console.error('[gravel] fatal:', err.message)
  if (process.env.GRAVEL_DEBUG) console.error(err.stack)
  process.exit(1)
})
