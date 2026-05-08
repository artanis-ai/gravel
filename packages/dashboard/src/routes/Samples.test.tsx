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

// Default mocks for the auxiliary endpoints the page also fetches
// (auth/me, onboarding/status). Test-specific responses for the main
// data fetches are layered on top.
function withDefaults(samples: unknown): (path: string) => unknown {
  return (path: string) => {
    if (path === '/api/auth/me') {
      return { user: { id: 'localhost', firstName: 'Developer', role: 'admin' } }
    }
    if (path === '/api/onboarding/status') {
      // Tests assume tracing is fully wired so the OnboardingCard
      // doesn't render any "click to set up" copy on top of the list.
      return {
        prompts: { manifestExists: true, promptCount: 5, hookInstalled: true },
        traces: { tablesExist: true, sampleCount: 100, hasFeedback: true },
        githubApp: { connected: true, repoOwner: 'acme', repoName: 'app' },
      }
    }
    return samples
  }
}

describe('Samples list', () => {
  it('renders the empty state when no samples are returned', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      const empty: SamplesResponse = { samples: [], total: 0, page: 1, page_size: 20 }
      // Override traces to reflect "tables exist but no samples yet"
      // so the OnboardingCard renders the "trigger an LLM call" step
      // instead of being absent.
      if (path === '/api/onboarding/status') {
        return {
          prompts: { manifestExists: true, promptCount: 0, hookInstalled: false },
          traces: { tablesExist: true, sampleCount: 0, hasFeedback: false },
          githubApp: { connected: false, repoOwner: null, repoName: null },
        }
      }
      return withDefaults(empty)(path)
    })
    renderRoute(<SamplesPage />)
    expect(await screen.findByText(/no outputs yet/i)).toBeInTheDocument()
    // Developer-only hint visible because auth/me reports localhost.
    // Both the DeveloperNote and the OnboardingCard mention gravel doctor —
    // we just need at least one.
    expect((await screen.findAllByText(/gravel doctor/i)).length).toBeGreaterThan(0)
    expect(screen.getByText(/visible only on localhost/i)).toBeInTheDocument()
  })

  it('renders rows when samples are returned', async () => {
    mockedGet.mockImplementation(async (path: string) => withDefaults(makeSamples(3))(path))
    renderRoute(<SamplesPage />)
    await waitFor(() => expect(screen.getAllByText('chat.completions.create')).toHaveLength(3))
    const paginationNav = screen.getByLabelText(/pagination/i)
    expect(paginationNav.textContent?.replace(/\s+/g, ' ')).toMatch(/Showing 1.{1,3}3 of 3/i)
  })

  it('refetches when a filter changes', async () => {
    mockedGet.mockImplementation(async (path: string) => withDefaults(makeSamples(1))(path))
    const user = userEvent.setup()
    renderRoute(<SamplesPage />)
    await screen.findAllByText('chat.completions.create')
    const samplesCallCount = () =>
      mockedGet.mock.calls.filter((c) => String(c[0]).startsWith('/api/samples')).length
    const initial = samplesCallCount()

    await user.type(screen.getByLabelText(/filter by environment/i), 'prod')

    await waitFor(() => {
      const lastSamplesCall = mockedGet.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.startsWith('/api/samples'))
        .at(-1)
      expect(lastSamplesCall).toContain('env=prod')
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
