/**
 * Tests for the wizard's dev-port guesser. Verifies the
 * "open http://localhost:PORT/admin/ai" copy lands on a real port
 * for each detected stack instead of always saying :3000.
 *
 * The exported helper isn't surfaced from `wizard/index.ts` (it's a
 * private function). We test it indirectly by running the full
 * wizard against a tmpdir with various package.json shapes and
 * grepping the closing summary for the URL it printed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWizard } from '../src/wizard/index.js'

let workdir: string
let logs: string[]

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gravel-port-'))
  logs = []
  // Capture the wizard's user-facing output so tests can assert on
  // the URL it offers. process.stdout.write is what `say()` /
  // `bullet()` go through under the hood.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    logs.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    return true
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(workdir, { recursive: true, force: true })
})

async function setupPackage(pkg: object): Promise<void> {
  await fs.writeFile(join(workdir, 'package.json'), JSON.stringify(pkg, null, 2))
}

function combinedLog(): string {
  return logs.join('')
}

async function runAndGetUrl(): Promise<string> {
  await runWizard({
    cwd: workdir,
    prompts: true,
    traces: false,
    noHook: true,
    noDeepScan: true,
    noTestTrace: true,
  })
  return combinedLog()
}

describe('wizard dev-port guesser', () => {
  it('uses Next.js default :3000 when no port override is set', async () => {
    await setupPackage({
      name: 'x',
      type: 'module',
      dependencies: { next: '^15' },
    })
    await fs.mkdir(join(workdir, 'app'), { recursive: true })
    await fs.writeFile(join(workdir, 'app', 'page.tsx'), 'export default function P(){return null}')
    const out = await runAndGetUrl()
    expect(out).toContain('http://localhost:3000/admin/ai')
  })

  it('honours --port N in the dev script', async () => {
    await setupPackage({
      name: 'x',
      type: 'module',
      dependencies: { next: '^15' },
      scripts: { dev: 'next dev --port 4747' },
    })
    await fs.mkdir(join(workdir, 'app'), { recursive: true })
    await fs.writeFile(join(workdir, 'app', 'page.tsx'), 'export default function P(){return null}')
    const out = await runAndGetUrl()
    expect(out).toContain('http://localhost:4747/admin/ai')
    expect(out).not.toContain('localhost:3000')
  })

  it('honours -p N (short flag) in the dev script', async () => {
    await setupPackage({
      name: 'x',
      type: 'module',
      dependencies: { next: '^15' },
      scripts: { dev: 'next dev -p 8080' },
    })
    await fs.mkdir(join(workdir, 'app'), { recursive: true })
    await fs.writeFile(join(workdir, 'app', 'page.tsx'), 'export default function P(){return null}')
    const out = await runAndGetUrl()
    expect(out).toContain('http://localhost:8080/admin/ai')
  })

  it('honours PORT=N env-var prefix in the dev script', async () => {
    await setupPackage({
      name: 'x',
      type: 'module',
      dependencies: { next: '^15' },
      scripts: { dev: 'PORT=9090 next dev' },
    })
    await fs.mkdir(join(workdir, 'app'), { recursive: true })
    await fs.writeFile(join(workdir, 'app', 'page.tsx'), 'export default function P(){return null}')
    const out = await runAndGetUrl()
    expect(out).toContain('http://localhost:9090/admin/ai')
  })

  it('drops the host:port for generic-node (no documented default)', async () => {
    await setupPackage({ name: 'x', type: 'module' })
    const out = await runAndGetUrl()
    expect(out).not.toContain('http://localhost')
    expect(out).toContain('/admin/ai on whatever host:port your app uses')
  })
})
