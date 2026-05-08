/**
 * `gravel scan --deep` — LLM-assisted prompt detection. Walks the
 * source tree, identifies prompt strings inside code, and merges them
 * into `.artanis/manifest.json`.
 *
 * Two paths:
 *   - Preferred: delegate to a local coding agent (Claude Code or
 *     Codex). Free for the customer (uses their existing agent
 *     subscription / API key). Code never leaves the machine.
 *   - Fallback: when no agent is installed but `OPENAI_API_KEY` is
 *     set, hit the OpenAI API directly via `manifest/deep-scan.ts`.
 *     One API call per source file.
 *
 * Spec: gravel-cloud/docs/spec/manifest.md §3.
 */
import {
  agentDeepScan,
  detectAgents,
  type AgentName,
} from '../manifest/agent-deep-scan.js'
import { deepScan } from '../manifest/deep-scan.js'
import { readManifest, writeManifest } from '../manifest/io.js'
import { config as loadEnv } from '../wizard/load-env.js'

export async function runDeepScan(opts: { printOnly?: boolean; agent?: AgentName } = {}): Promise<void> {
  const cwd = process.cwd()
  const current = await readManifest(cwd)

  const agents = detectAgents()
  const explicit = opts.agent
  const picked: AgentName | null = explicit
    ? agents[explicit]
      ? explicit
      : null
    : agents.claude
      ? 'claude'
      : agents.codex
        ? 'codex'
        : null

  if (explicit && !picked) {
    console.error(
      `[gravel] --agent=${explicit} but '${explicit}' is not on PATH. Install it or omit --agent to auto-pick.`,
    )
    process.exit(1)
  }

  if (picked) {
    const label = picked === 'claude' ? 'Claude Code' : 'Codex'
    console.log(`[gravel] Deep scan via ${label} (this can take a minute)…`)
    const result = await agentDeepScan(cwd, current, picked, {
      verbose: !!process.env.GRAVEL_DEBUG,
    })
    summarize(result.newFindings.length, result.errors)
    if (result.newFindings.length > 0) {
      console.log('')
      console.log('Discovered:')
      for (const f of result.newFindings) {
        const tag = f.varName ? ` ${f.varName}` : ''
        console.log(`  ${f.path}:${f.lineStart}-${f.lineEnd}${tag}`)
      }
    }
    if (opts.printOnly) {
      console.log('')
      console.log('--print-only: manifest left unchanged')
      return
    }
    if (result.newFindings.length === 0) return
    await writeManifest(cwd, result.manifest)
    console.log('')
    console.log(`Manifest updated (+${result.newFindings.length} embedded prompts).`)
    return
  }

  // No agent on PATH — fall back to the OpenAI API path if a key's set.
  const env = await loadEnv(cwd)
  const apiKey = env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(
      [
        '[gravel] No coding agent on PATH and OPENAI_API_KEY not set.',
        '',
        'Install Claude Code (https://claude.com/code) or Codex',
        '(https://github.com/openai/codex) for the recommended path —',
        'code stays on this machine and there is no extra API key needed.',
        '',
        'Or set OPENAI_API_KEY in .env(.local) and re-run for the API-direct path.',
      ].join('\n'),
    )
    process.exit(1)
  }
  console.log('[gravel] No local agent — falling back to direct OpenAI API (one call per source file).')
  let scanned = 0
  const result = await deepScan(cwd, current, {
    apiKey,
    onFile: () => {
      scanned++
      if (scanned % 10 === 0) console.log(`  ...${scanned} files`)
    },
  })
  summarize(result.newFindings.length, result.errors.map((e) => `${e.path}: ${e.message}`))
  if (result.newFindings.length > 0) {
    console.log('')
    console.log('Discovered:')
    for (const f of result.newFindings) {
      const tag = f.varName ? `${f.varName} ` : ''
      const why = f.why ? ` — ${f.why}` : ''
      console.log(`  ${f.path}:${f.lineStart}-${f.lineEnd} ${tag}${why}`)
    }
  }
  if (opts.printOnly) {
    console.log('')
    console.log('--print-only: manifest left unchanged')
    return
  }
  if (result.newFindings.length === 0) {
    console.log('')
    console.log('Manifest already up to date — nothing to write.')
    return
  }
  await writeManifest(cwd, result.manifest)
  console.log('')
  console.log(`Manifest updated (+${result.newFindings.length} embedded prompts).`)
}

function summarize(newCount: number, errors: string[]): void {
  console.log('')
  console.log(`New prompts: ${newCount}`)
  if (errors.length > 0) {
    console.log(`Errors:      ${errors.length}`)
    for (const e of errors.slice(0, 10)) {
      console.log(`  ${e}`)
    }
    if (errors.length > 10) {
      console.log(`  …and ${errors.length - 10} more`)
    }
  }
}
