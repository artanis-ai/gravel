/**
 * Tests for Outputs (samples) list + detail.
 *
 * The api client is mocked at module level (per `_skill: thorough_tests`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
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
    expect(screen.getByText(/visible only on localhost/i)).toBeInTheDocument()
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

describe('Sample detail', () => {
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

  it('renders input + output and submits feedback', async () => {
    mockedGet.mockImplementation(async (path: string) => withDefaults(makeDetail())(path))
    mockedPost.mockResolvedValue({ ok: true })

    const user = userEvent.setup()
    renderRoute(<SamplesPage sampleId="sample_abc" />)

    // Input + Output payloads are rendered as JSON sections.
    expect(await screen.findByText('Input')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText(/hello!/)).toBeInTheDocument()

    // try submitting without thumbs first → inline error
    const form = screen.getByRole('form', { name: /add feedback/i })
    await user.click(within(form).getByRole('button', { name: /save feedback/i }))
    expect(within(form).getByText(/thumbs up or thumbs down/i)).toBeInTheDocument()
    expect(mockedPost).not.toHaveBeenCalled()

    await user.click(within(form).getByRole('button', { name: /thumbs down/i }))
    await user.type(within(form).getByLabelText(/comment/i), 'wrong tone')
    await user.type(within(form).getByLabelText(/correction/i), 'should be friendlier')
    await user.click(within(form).getByRole('button', { name: /save feedback/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    const [path, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/api/samples/sample_abc/feedback')
    expect(body).toEqual({ thumbs: 'down', comment: 'wrong tone', correction: 'should be friendlier' })
  })
})
