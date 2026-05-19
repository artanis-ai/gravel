/**
 * Visual fixture harness. Test-only entry point — NOT bundled into
 * the dashboard SPA that ships to customers. Lives outside `src/` so
 * neither the prod build nor the SDK's `_dashboard_dist/` ever
 * includes it.
 *
 * Bootstraps React, reads `?fixture=<name>` from the URL, looks up
 * the matching JSON in `../fixtures/sources/`, and renders the real
 * `<ReviewSurface>` inside a viewport that mirrors the
 * SampleReviewDialog visual chrome. Used exclusively by
 * `fixtures.spec.ts` (Playwright) to capture screenshot baselines.
 */
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { ReviewSurface } from '../../src/components/review/ReviewSurface'
import '../../src/styles.css'

interface Fixture {
  name: string
  source: string
  description?: string
  isFetch?: boolean
  input: unknown
  output: unknown
  metadata?: Record<string, unknown> | null
}

// Vite resolves the glob at build time relative to THIS file. The
// fixtures directory sits one level up, alongside this harness.
const FIXTURES = import.meta.glob<Fixture>(
  '../fixtures/sources/*.json',
  { eager: true, import: 'default' },
)

function fixtureByName(name: string): Fixture | null {
  for (const [path, fixture] of Object.entries(FIXTURES)) {
    if (path.endsWith(`/${name}.json`)) return fixture as Fixture
  }
  return null
}

function FixturePage({ name }: { name: string | null }): ReactNode {
  // Two-frame settle so the ReviewSurface's flex / overflow layout
  // pass completes before Playwright snapshots. The
  // `data-fixture-ready` sentinel is the waitForSelector target.
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))
  }, [name])

  if (name === null) {
    const all = Object.entries(FIXTURES)
      .map(([path, fixture]) => {
        const m = path.match(/\/([^/]+)\.json$/)
        return { name: m?.[1] ?? path, fixture: fixture as Fixture }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    return (
      <div className="min-h-screen bg-cream p-8 text-text-dark">
        <h1 className="font-display text-2xl font-semibold mb-4">
          Visual fixture harness ({all.length})
        </h1>
        <p className="text-sm text-text-muted mb-6">
          Pass <code className="font-mono">?fixture=&lt;name&gt;</code> in the
          URL to render a single fixture. Playwright iterates these
          automatically.
        </p>
        <ul className="space-y-1 text-sm">
          {all.map(({ name }) => (
            <li key={name}>
              <a
                href={`?fixture=${name}`}
                className="font-mono text-forest underline cursor-pointer"
              >
                {name}
              </a>
            </li>
          ))}
        </ul>
        <div data-fixture-ready="true" data-fixture-name="__index__" />
      </div>
    )
  }

  const fixture = fixtureByName(name)
  if (!fixture) {
    return (
      <div className="min-h-screen bg-cream p-8 text-text-dark">
        <p>
          Fixture not found: <code className="font-mono">{name}</code>
        </p>
        <div
          data-fixture-ready="true"
          data-fixture-name={name}
          data-fixture-missing="true"
        />
      </div>
    )
  }
  return (
    <div className="flex min-h-screen flex-col p-6">
      <div
        role="dialog"
        aria-label={`Fixture ${name}`}
        className="mx-auto flex h-[calc(100vh-3rem)] w-full max-w-7xl flex-col overflow-hidden rounded-xl bg-cream shadow-2xl ring-1 ring-warm"
      >
        <header className="flex shrink-0 items-baseline justify-between border-b border-warm bg-cream/95 px-4 py-2">
          <span className="font-mono text-sm font-semibold">{name}</span>
          <span className="font-mono text-[11px] text-text-muted">
            {fixture.source}
          </span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <ReviewSurface
            name={fixture.name}
            input={fixture.input}
            output={fixture.output}
            metadata={fixture.metadata ?? null}
          />
        </div>
      </div>
      {ready && (
        <div data-fixture-ready="true" data-fixture-name={name} />
      )}
    </div>
  )
}

const params = new URLSearchParams(window.location.search)
const fixtureName = params.get('fixture')

createRoot(document.getElementById('root')!).render(
  <FixturePage name={fixtureName} />,
)
