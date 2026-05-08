/**
 * Unit tests for agent-deep-scan: parsing JSONL output, enriching with
 * char offsets, deduping. We don't actually spawn claude/codex here —
 * we test the contract by injecting `binary` to a tiny shell script
 * that emits a known JSONL transcript.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentDeepScan, detectAgents } from '../src/manifest/agent-deep-scan.js'
import { emptyManifest } from '../src/manifest/types.js'

let workdir: string

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gravel-deepscan-'))
})
afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

async function plantFakeAgent(jsonlOutput: string): Promise<string> {
  // A tiny shell script that ignores its arguments and prints the
  // canned transcript. Exactly what claude / codex would do, but
  // deterministic. We `chmod +x` so the test can spawn it directly.
  const script = join(workdir, 'fake-agent.sh')
  await fs.writeFile(
    script,
    `#!/usr/bin/env bash\ncat <<'EOF'\n${jsonlOutput}\nEOF\n`,
    { mode: 0o755 },
  )
  return script
}

describe('agentDeepScan', () => {
  it('parses JSONL findings and enriches with char offsets', async () => {
    const promptText = '`You are a triage assistant. Categorise the message into urgent/normal/low.`'
    const fileBody = [
      'import OpenAI from "openai"',
      'const client = new OpenAI()',
      `const SYSTEM_PROMPT = ${promptText}`,
      '// usage:',
      'await client.chat.completions.create({ messages: [{ role: "system", content: SYSTEM_PROMPT }] })',
    ].join('\n')
    await fs.mkdir(join(workdir, 'src'), { recursive: true })
    await fs.writeFile(join(workdir, 'src', 'agent.ts'), fileBody)

    const transcript = [
      '{"path":"src/agent.ts","lineStart":3,"lineEnd":3,"varName":"SYSTEM_PROMPT","snippet":"You are a triage assistant"}',
      'noise that should be ignored',
      '###DONE###',
      'trailing chatter',
    ].join('\n')
    const binary = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', { binary })

    expect(result.errors).toEqual([])
    expect(result.newFindings).toHaveLength(1)
    const f = result.newFindings[0]!
    expect(f.path).toBe('src/agent.ts')
    expect(f.lineStart).toBe(3)
    expect(f.lineEnd).toBe(3)
    expect(f.varName).toBe('SYSTEM_PROMPT')
    // The char range should slice out exactly line 3 of the file.
    const slice = fileBody.slice(f.charStart, f.charEnd)
    expect(slice).toContain('SYSTEM_PROMPT')
    expect(slice).toContain('triage assistant')
  })

  it('skips findings already in the manifest', async () => {
    await fs.mkdir(join(workdir, 'src'), { recursive: true })
    await fs.writeFile(
      join(workdir, 'src', 'a.ts'),
      'const X = "this is an existing prompt"\nconst Y = "another one"\n',
    )

    const manifest = emptyManifest()
    manifest.prompts.push({ id: 'p_aaa', type: 'file', path: 'src/a.ts', hash: 'h' })

    const transcript = [
      '{"path":"src/a.ts","lineStart":1,"lineEnd":1,"varName":"X"}',
      '###DONE###',
    ].join('\n')
    const binary = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, manifest, 'claude', { binary })

    expect(result.newFindings).toHaveLength(0)
  })

  it('drops findings whose file no longer exists', async () => {
    const transcript = [
      '{"path":"src/missing.ts","lineStart":1,"lineEnd":2}',
      '###DONE###',
    ].join('\n')
    const binary = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', { binary })

    expect(result.newFindings).toHaveLength(0)
    expect(result.orphans).toHaveLength(1)
  })

  it('records bad JSON lines as soft errors but keeps going', async () => {
    await fs.writeFile(join(workdir, 'a.ts'), 'const PROMPT = "Be helpful."\n')
    const transcript = [
      '{"path":"a.ts","lineStart":1,"lineEnd":1,"varName":"PROMPT"}',
      '{"path":"a.ts","badline":}',
      '###DONE###',
    ].join('\n')
    const binary = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', { binary })

    expect(result.newFindings).toHaveLength(1)
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    expect(result.errors[0]).toMatch(/bad JSON line/)
  })

  it('dedupes repeated (path,lineStart,lineEnd) findings', async () => {
    await fs.writeFile(join(workdir, 'a.ts'), 'const P = "Be precise."\n')
    const transcript = [
      '{"path":"a.ts","lineStart":1,"lineEnd":1,"varName":"P"}',
      '{"path":"a.ts","lineStart":1,"lineEnd":1,"varName":"P"}',
      '###DONE###',
    ].join('\n')
    const binary = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', { binary })

    expect(result.newFindings).toHaveLength(1)
  })
})

describe('detectAgents', () => {
  it('returns booleans for both supported agents (no spawn beyond `command -v`)', () => {
    const a = detectAgents()
    expect(typeof a.claude).toBe('boolean')
    expect(typeof a.codex).toBe('boolean')
  })
})
