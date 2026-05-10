#!/usr/bin/env node
/**
 * `gravel` CLI binary. Lightweight command dispatcher; each subcommand is its
 * own module so they can be unit-tested in isolation.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md §6
 */
import { runWizard } from '../wizard/index.js'
import { runManifestCheck, runManifestUpdate } from './manifest.js'
import { runMigrate } from './migrate.js'
import { runDeepScan } from './scan.js'

const HELP = `gravel — embedded prompt management, tracing, and evals.

Usage: gravel <command> [options]

Commands:
  init                       Run the install wizard (always local — no
                             cloud sign-in from the CLI).
  manifest --check           Verify .gravel/manifest.json is in sync (used by hook).
  manifest --update          Regenerate .gravel/manifest.json from working tree.
  manifest --list            Print human-readable summary of current manifest.
  scan --deep                Run LLM-assisted prompt detection (uses OPENAI_API_KEY).
                             --print-only inspects without writing the manifest.
  migrate                    Apply pending DB migrations (uses bootstrap.ts in v0).
  help                       Show this message.

Init flags:
  --prompts, --no-prompts    Toggle the Prompts pillar (manifest scan +
                             pre-commit hook). Default: ask on a TTY,
                             yes otherwise.
  --traces, --no-traces      Toggle the Traces pillar (DB tables +
                             auto-instrumentation). Default: ask on a
                             TTY, yes otherwise. Skipping this means
                             zero database writes.
  --yes, -y                  Assume Yes to every interactive prompt.
                             Pillars + their sub-questions all default
                             to yes. Use for agents and CI.
  --non-interactive          Force no prompts even on a TTY (default-yes
                             for everything). Equivalent to --yes today;
                             kept as an alias for clarity.
  --api-key <key>            CI / scripted installs: pre-bake this project key
                             into .env. Requires --project as well.
  --project <id>             CI / scripted installs: pre-bake this project ID.
  --mount-path <path>        Override default '/admin/ai'.
  --no-deep-scan             Skip the LLM-assisted deep scan (placeholder).
  --no-test-trace            Skip test trace (placeholder).

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
    case 'init': {
      // Pillar resolution: explicit --prompts / --no-prompts wins,
      // otherwise leave undefined so the wizard asks (or defaults yes
      // in non-interactive). Same for traces.
      const pillarFlag = (
        on: keyof typeof flags,
        off: keyof typeof flags,
      ): boolean | undefined => {
        if (flags[on] === true) return true
        if (flags[off] === true) return false
        return undefined
      }
      await runWizard({
        apiKey: typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined,
        project: typeof flags.project === 'string' ? flags.project : undefined,
        mountPath: typeof flags['mount-path'] === 'string' ? flags['mount-path'] : undefined,
        prompts: pillarFlag('prompts', 'no-prompts'),
        traces: pillarFlag('traces', 'no-traces'),
        yes: !!flags.yes || !!flags.y,
        nonInteractive: !!flags['non-interactive'],
        noDeepScan: !!flags['no-deep-scan'],
        noTestTrace: !!flags['no-test-trace'],
      })
      break
    }

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
        const agent =
          flags.agent === 'claude' || flags.agent === 'codex' ? flags.agent : undefined
        await runDeepScan({
          printOnly: !!flags['print-only'],
          agent,
        })
        break
      }
      console.error('scan: pass --deep')
      process.exit(2)
      break

    case 'migrate':
      await runMigrate()
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
