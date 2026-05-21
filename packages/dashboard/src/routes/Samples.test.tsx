/**
 * Tests for Outputs (samples) list + detail.
 *
 * The api client is mocked at module level (per `_skill: thorough_tests`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', () => {
  return {
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  }
})

import { api } from '../lib/api'
import { SamplesPage } from './Samples'
import { renderRoute } from '../test/util'
import type { SampleDetailResponse, SamplesResponse } from '../lib/types'

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
})

function makeSamples(n: number): SamplesResponse {
  return {
    samples: Array.from({ length: n }, (_, i) => ({
      id: `sample_${i}`,
      name: 'chat.completions.create',
      model: 'gpt-4o',
      environment: 'prod',
      status: 'completed' as const,
      group_id: null,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 1234,
      tokens_in: 512,
      tokens_out: 128,
      feedback_count: i === 0 ? 1 : 0,
      feedback_score: i === 0 ? ('positive' as const) : null,
    })),
    total: n,
    page: 1,
    page_size: 20,
  }
}

// Default mock for the auth/me endpoint the page also fetches.
// Test-specific responses for the samples fetch are layered on top.
function withDefaults(samples: unknown): (path: string) => unknown {
  return (path: string) => {
    if (path === '/api/auth/me') {
      return { user: { id: 'localhost', firstName: 'Developer', role: 'admin' } }
    }
    return samples
  }
}

describe('Samples list', () => {
  it('renders the empty state + wire-tracing hint when no samples exist', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      const empty: SamplesResponse = { samples: [], total: 0, page: 1, page_size: 20 }
      return withDefaults(empty)(path)
    })
    renderRoute(<SamplesPage />)
    expect(await screen.findByText(/nothing to review yet/i)).toBeInTheDocument()
    // The Trace Evals upsell is hidden — the localhost dev hasn't even
    // wired tracing yet, so we surface the setup hint instead.
    expect(await screen.findByText(/no traces yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/Trace Evals/i)).not.toBeInTheDocument()
    expect(screen.getByText(/only you can see this box/i)).toBeInTheDocument()
  })

  it('renders rows when samples are returned', async () => {
    mockedGet.mockImplementation(async (path: string) => withDefaults(makeSamples(3))(path))
    renderRoute(<SamplesPage />)
    await waitFor(() => expect(screen.getAllByText('chat.completions.create')).toHaveLength(3))
    const paginationNav = screen.getByLabelText(/pagination/i)
    expect(paginationNav.textContent?.replace(/\s+/g, ' ')).toMatch(/Showing 1.{1,3}3 of 3/i)
  })

  it('refetches when the search filter changes (debounced)', async () => {
    mockedGet.mockImplementation(async (path: string) => withDefaults(makeSamples(1))(path))
    const user = userEvent.setup()
    renderRoute(<SamplesPage />)
    await screen.findAllByText('chat.completions.create')
    const samplesCallCount = () =>
      mockedGet.mock.calls.filter((c) => String(c[0]).startsWith('/api/samples')).length
    const initial = samplesCallCount()

    await user.type(screen.getByLabelText(/search samples/i), 'pomodoro')

    await waitFor(() => {
      const lastSamplesCall = mockedGet.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.startsWith('/api/samples'))
        .at(-1)
      expect(lastSamplesCall).toContain('q=pomodoro')
    })
    expect(samplesCallCount()).toBeGreaterThan(initial)
  })
})

describe('Sample deep-link', () => {
  function makeDetail(): SampleDetailResponse {
    return {
      sample: {
        id: 'sample_abc',
        name: 'chat.completions.create',
        model: 'gpt-4o',
        environment: 'prod',
        status: 'completed',
        group_id: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 800,
        tokens_in: 100,
        tokens_out: 50,
        feedback_count: 0,
        feedback_score: null,
        commit_sha: 'abc',
        input: { messages: [{ role: 'user', content: 'hi' }] },
        output: { content: 'hello!' },
        metadata: {},
      },
      feedback: [],
      related: [],
    }
  }

  it('opens the canonical SampleReviewDialog (Approve / Reject / Skip), not the legacy inline page', async () => {
    // v0.9.5 deletes the parallel "Thumbs up / Thumbs down / Save
    // feedback" inline body that used to render here. /samples/:id
    // now opens the same SampleReviewDialog as a list-row click.
    mockedGet.mockImplementation(async (path: string) => withDefaults(makeDetail())(path))

    renderRoute(<SamplesPage sampleId="sample_abc" />)

    // Modal renders the canonical feedback buttons.
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument()

    // The deleted inline UI must not render.
    expect(screen.queryByRole('button', { name: /thumbs up/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /thumbs down/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save feedback/i })).not.toBeInTheDocument()
  })
})
