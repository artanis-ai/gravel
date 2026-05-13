/**
 * Unit tests for agent-deep-scan: parsing JSONL output, resolving the
 * startsWith / endsWith anchors against the source file to get precise
 * code-point offsets, deduping. We don't actually spawn claude/codex
 * here — we test the contract by injecting `binary` to a tiny Node
 * stand-in that emits a known JSONL transcript.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentDeepScan, detectAgents } from '../src/manifest/agent-deep-scan.js'
import { sliceByCodePoints } from '../src/manifest/offsets.js'
import { emptyManifest } from '../src/manifest/types.js'

let workdir: string

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gravel-deepscan-'))
})
afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

async function plantFakeAgent(jsonlOutput: string): Promise<string> {
  // A Node-based stand-in for claude/codex. Reads stdin (matching the
  // real agents' behaviour under -p / exec with no positional), then
  // writes a canned JSONL transcript to stdout. Cross-platform — bash
  // shebangs don't run on Windows.
  const script = join(workdir, 'fake-agent.mjs')
  await fs.writeFile(
    script,
    [
      `process.stdin.resume()`,
      `process.stdin.on('data', () => {})`,
      `process.stdin.on('end', () => {`,
      `  process.stdout.write(${JSON.stringify(jsonlOutput)})`,
      `  process.exit(0)`,
      `})`,
    ].join('\n'),
    { mode: 0o755 },
  )
  return script
}

describe('agentDeepScan', () => {
  it('resolves startsWith / endsWith anchors to code-point offsets', async () => {
    const promptText = 'You are a triage assistant. Categorise the message into urgent/normal/low.'
    const fileBody = [
      'import OpenAI from "openai"',
      'const client = new OpenAI()',
      `const SYSTEM_PROMPT = \`${promptText}\``,
      '// usage:',
      'await client.chat.completions.create({ messages: [{ role: "system", content: SYSTEM_PROMPT }] })',
    ].join('\n')
    await fs.mkdir(join(workdir, 'src'), { recursive: true })
    await fs.writeFile(join(workdir, 'src', 'agent.ts'), fileBody)

    const transcript = [
      JSON.stringify({
        path: 'src/agent.ts',
        lineStart: 3,
        lineEnd: 3,
        varName: 'SYSTEM_PROMPT',
        startsWith: 'You are a triage assistant',
        endsWith: 'urgent/normal/low.',
      }),
      'noise that should be ignored',
      '###DONE###',
      'trailing chatter',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.errors).toEqual([])
    expect(result.newFindings).toHaveLength(1)
    const f = result.newFindings[0]!
    expect(f.path).toBe('src/agent.ts')
    expect(f.lineStart).toBe(3)
    expect(f.lineEnd).toBe(3)
    expect(f.varName).toBe('SYSTEM_PROMPT')
    // Slice exactly the prompt content — no surrounding quotes, no `const … = `.
    const slice = sliceByCodePoints(fileBody, f.charStart, f.charEnd)
    expect(slice).toBe(promptText)
  })

  it('keeps offsets correct across multi-byte characters', async () => {
    // The prompt body contains an em-dash (—, 3 bytes UTF-8), a smart
    // quote (’, 3 bytes), and a target emoji (🎯, surrogate pair in
    // UTF-16, 4 bytes UTF-8). All three force the byte / UTF-16-unit /
    // code-point counts to diverge — the only correct unit is code
    // points.
    const promptText = 'You’re a kind assistant — guide them to the 🎯 with care and precision.'
    const fileBody = [
      'const HEADER = "préfixe"',
      `const SYSTEM_PROMPT = \`${promptText}\``,
      '',
    ].join('\n')
    await fs.writeFile(join(workdir, 'agent.ts'), fileBody)

    const transcript = [
      JSON.stringify({
        path: 'agent.ts',
        lineStart: 2,
        lineEnd: 2,
        varName: 'SYSTEM_PROMPT',
        startsWith: 'You’re a kind assistant',
        endsWith: 'with care and precision.',
      }),
      '###DONE###',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.errors).toEqual([])
    expect(result.newFindings).toHaveLength(1)
    const f = result.newFindings[0]!
    const slice = sliceByCodePoints(fileBody, f.charStart, f.charEnd)
    expect(slice).toBe(promptText)
  })

  it('handles multi-line prompts (startsWith on lineStart, endsWith on lineEnd)', async () => {
    const fileBody = [
      'const SYSTEM_PROMPT = `You are a careful assistant.', // line 1
      'Help the user step by step.', // line 2
      'Always confirm before destructive actions.`', // line 3
    ].join('\n')
    await fs.writeFile(join(workdir, 'agent.ts'), fileBody)

    const transcript = [
      JSON.stringify({
        path: 'agent.ts',
        lineStart: 1,
        lineEnd: 3,
        varName: 'SYSTEM_PROMPT',
        startsWith: 'You are a careful assistant.',
        endsWith: 'before destructive actions.',
      }),
      '###DONE###',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.errors).toEqual([])
    expect(result.newFindings).toHaveLength(1)
    const f = result.newFindings[0]!
    const slice = sliceByCodePoints(fileBody, f.charStart, f.charEnd)
    expect(slice).toBe(
      'You are a careful assistant.\nHelp the user step by step.\nAlways confirm before destructive actions.',
    )
  })

  it('orphans findings whose anchors do not appear on the reported line', async () => {
    await fs.writeFile(join(workdir, 'a.ts'), 'const X = "hello world"\n')
    const transcript = [
      JSON.stringify({
        path: 'a.ts',
        lineStart: 1,
        lineEnd: 1,
        startsWith: 'something the agent hallucinated',
        endsWith: 'world',
      }),
      '###DONE###',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.newFindings).toHaveLength(0)
    expect(result.orphans).toHaveLength(1)
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
      JSON.stringify({
        path: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        varName: 'X',
        startsWith: 'this is an existing prompt',
        endsWith: 'this is an existing prompt',
      }),
      '###DONE###',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, manifest, 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.newFindings).toHaveLength(0)
  })

  it('drops findings whose file no longer exists', async () => {
    const transcript = [
      JSON.stringify({
        path: 'src/missing.ts',
        lineStart: 1,
        lineEnd: 2,
        startsWith: 'anything',
        endsWith: 'anything',
      }),
      '###DONE###',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.newFindings).toHaveLength(0)
    expect(result.orphans).toHaveLength(1)
  })

  it('records bad JSON lines as soft errors but keeps going', async () => {
    await fs.writeFile(join(workdir, 'a.ts'), 'const PROMPT = "Be helpful and precise."\n')
    const transcript = [
      JSON.stringify({
        path: 'a.ts',
        lineStart: 1,
        lineEnd: 1,
        varName: 'PROMPT',
        startsWith: 'Be helpful',
        endsWith: 'precise.',
      }),
      '{"path":"a.ts","badline":}',
      '###DONE###',
    ].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

    expect(result.newFindings).toHaveLength(1)
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    expect(result.errors[0]).toMatch(/bad JSON line/)
  })

  it('dedupes repeated (path,lineStart,lineEnd) findings', async () => {
    await fs.writeFile(join(workdir, 'a.ts'), 'const P = "Be precise and concise."\n')
    const finding = JSON.stringify({
      path: 'a.ts',
      lineStart: 1,
      lineEnd: 1,
      varName: 'P',
      startsWith: 'Be precise',
      endsWith: 'concise.',
    })
    const transcript = [finding, finding, '###DONE###'].join('\n')
    const scriptPath = await plantFakeAgent(transcript)
    const result = await agentDeepScan(workdir, emptyManifest(), 'claude', {
      binary: process.execPath,
      extraArgs: [scriptPath],
    })

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
