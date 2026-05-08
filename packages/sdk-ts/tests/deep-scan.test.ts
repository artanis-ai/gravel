/**
 * Deep scan tests. The LLM round-trip is mocked at the fetch layer so
 * we can control responses + assert the manifest-merge invariants
 * without burning OpenAI quota.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepScan, buildScanMessages } from '../src/manifest/deep-scan.js'
import { emptyManifest } from '../src/manifest/types.js'

let workdir: string

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'gravel-deep-scan-'))
})

async function writeFile(rel: string, content: string): Promise<void> {
  const full = join(workdir, rel)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content)
}

function mockOpenAi(responses: Array<{ prompts: unknown[] } | string>): void {
  const queue = [...responses]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = queue.shift() ?? { prompts: [] }
      const content = typeof next === 'string' ? next : JSON.stringify(next)
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

describe('buildScanMessages', () => {
  it('includes the file path + content under a fenced block', () => {
    const msgs = buildScanMessages('src/agent.ts', 'const SYSTEM = "you are helpful"')
    expect(msgs[0]?.role).toBe('system')
    expect(msgs[1]?.role).toBe('user')
    expect(msgs[1]?.content).toContain('src/agent.ts')
    expect(msgs[1]?.content).toContain('const SYSTEM = "you are helpful"')
  })
})

describe('deepScan', () => {
  it('walks source files, calls the LLM, and adds findings as embedded prompts', async () => {
    await writeFile(
      'src/agent.ts',
      `const SYSTEM_PROMPT = "You are a helpful assistant. Always answer with care and provide examples."\nexport function chat() {}\n`,
    )
    mockOpenAi([
      {
        prompts: [
          { charStart: 22, charEnd: 105, lineStart: 1, lineEnd: 1, varName: 'SYSTEM_PROMPT', why: 'system prompt' },
        ],
      },
    ])

    const result = await deepScan(workdir, emptyManifest(), { apiKey: 'sk-test' })

    expect(result.filesScanned).toBe(1)
    expect(result.newFindings).toHaveLength(1)
    expect(result.manifest.prompts).toHaveLength(1)
    const p = result.manifest.prompts[0]!
    expect(p.type).toBe('embedded')
    expect(p.path).toBe('src/agent.ts')
    if (p.type === 'embedded') {
      expect(p.varName).toBe('SYSTEM_PROMPT')
      expect(p.charStart).toBe(22)
      expect(p.charEnd).toBe(105)
    }
  })

  it('skips files without potential prompts (no LLM call)', async () => {
    await writeFile('src/util.ts', 'export const PI = 3.14\nexport const TAU = 6.28\n')
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"prompts":[]}' } }] })),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const result = await deepScan(workdir, emptyManifest(), { apiKey: 'sk-test' })

    expect(result.filesScanned).toBe(0)
    expect(result.filesSkipped).toBeGreaterThanOrEqual(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('drops findings with bad offsets (negative, past EOF, inverted)', async () => {
    const content =
      'const SYSTEM = "You are a helpful assistant who provides clear and concise answers always."\n'
    await writeFile('src/agent.ts', content)
    mockOpenAi([
      {
        prompts: [
          { charStart: -5, charEnd: 30, lineStart: 1, lineEnd: 1 }, // bad: negative
          { charStart: 100, charEnd: 50, lineStart: 1, lineEnd: 1 }, // bad: inverted
          { charStart: 0, charEnd: 99999, lineStart: 1, lineEnd: 1 }, // bad: past EOF
          { charStart: 16, charEnd: 90, lineStart: 1, lineEnd: 1 }, // good
        ],
      },
    ])

    const result = await deepScan(workdir, emptyManifest(), { apiKey: 'sk-test' })

    expect(result.newFindings).toHaveLength(1)
    expect(result.newFindings[0]!.charStart).toBe(16)
  })

  it('does not duplicate a finding that already exists in the manifest', async () => {
    const content =
      'const SYSTEM = "You are a helpful assistant who answers clearly and gives examples."\n'
    await writeFile('src/agent.ts', content)
    const existing = emptyManifest()
    existing.prompts.push({
      id: 'p_existing',
      type: 'embedded',
      path: 'src/agent.ts',
      hash: 'whatever',
      lineStart: 1,
      lineEnd: 1,
      charStart: 16,
      charEnd: 80,
    })
    mockOpenAi([
      { prompts: [{ charStart: 16, charEnd: 80, lineStart: 1, lineEnd: 1 }] },
    ])

    const result = await deepScan(workdir, existing, { apiKey: 'sk-test' })

    expect(result.newFindings).toHaveLength(0)
    // The existing entry stays.
    expect(result.manifest.prompts).toHaveLength(1)
    expect(result.manifest.prompts[0]!.id).toBe('p_existing')
  })

  it('throws when OPENAI_API_KEY is unset and not provided', async () => {
    const prevKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      await expect(deepScan(workdir, emptyManifest())).rejects.toThrow(/OPENAI_API_KEY/)
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
    }
  })

  it('records LLM errors on a per-file basis without aborting the run', async () => {
    // Both files contain a long obvious prompt so hasPotentialPrompt picks them up.
    const longPrompt = `"You are a helpful assistant providing clear and detailed answers always, no matter the question, and always include relevant examples for the user."`
    await writeFile('src/a.ts', `const A = ${longPrompt}\n`)
    await writeFile('src/b.ts', `const B = ${longPrompt}\n`)
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        if (call === 1) {
          return new Response('rate limit', { status: 429 })
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"prompts":[]}' } }] }),
          { status: 200 },
        )
      }),
    )

    const result = await deepScan(workdir, emptyManifest(), { apiKey: 'sk-test' })
    expect(result.errors).toHaveLength(1)
    expect(result.filesScanned).toBe(2)
  })
})
