/**
 * Tests for Traces list + detail.
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
import { TracesPage } from './Traces'
import { renderRoute } from '../test/util'
import type { TraceDetailResponse, TracesResponse } from '../lib/types'

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
})

function makeTraces(n: number): TracesResponse {
  return {
    traces: Array.from({ length: n }, (_, i) => ({
      id: `trace_${i}`,
      name: 'chat.completions.create',
      model: 'gpt-4o',
      environment: 'prod',
      status: 'completed' as const,
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

describe('Traces list', () => {
  it('renders the empty state when no traces are returned', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path === '/api/auth/me') {
        return { user: { id: 'localhost', firstName: 'Developer', role: 'admin' } }
      }
      return { traces: [], total: 0, page: 1, page_size: 20 } satisfies TracesResponse
    })
    renderRoute(<TracesPage />)
    expect(await screen.findByText(/no traces yet/i)).toBeInTheDocument()
    // Developer-only hint visible because auth/me reports localhost.
    expect(await screen.findByText(/gravel doctor/i)).toBeInTheDocument()
    expect(screen.getByText(/developer only/i)).toBeInTheDocument()
  })

  it('renders rows when traces are returned', async () => {
    mockedGet.mockResolvedValue(makeTraces(3))
    renderRoute(<TracesPage />)
    await waitFor(() => expect(screen.getAllByText('chat.completions.create')).toHaveLength(3))
    expect(screen.getByText(/3 traces/i)).toBeInTheDocument()
  })

  it('refetches when a filter changes', async () => {
    mockedGet.mockResolvedValue(makeTraces(1))
    const user = userEvent.setup()
    renderRoute(<TracesPage />)
    await screen.findAllByText('chat.completions.create')
    const initial = mockedGet.mock.calls.length

    await user.type(screen.getByLabelText(/filter by environment/i), 'prod')

    await waitFor(() => {
      const lastCall = mockedGet.mock.calls.at(-1)?.[0] as string | undefined
      expect(lastCall).toContain('env=prod')
    })
    expect(mockedGet.mock.calls.length).toBeGreaterThan(initial)
  })
})

describe('Trace detail', () => {
  function makeDetail(): TraceDetailResponse {
    return {
      trace: {
        id: 'trace_abc',
        name: 'chat.completions.create',
        model: 'gpt-4o',
        environment: 'prod',
        status: 'completed',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 800,
        tokens_in: 100,
        tokens_out: 50,
        feedback_count: 0,
        feedback_score: null,
        commit_sha: 'abc',
        metadata: {},
      },
      observations: [
        {
          id: 'obs_1',
          trace_id: 'trace_abc',
          type: 'input',
          name: 'request',
          data: { messages: [{ role: 'user', content: 'hi' }] },
          timestamp: new Date().toISOString(),
        },
        {
          id: 'obs_2',
          trace_id: 'trace_abc',
          type: 'output',
          name: 'response',
          data: { content: 'hello!' },
          timestamp: new Date(Date.now() + 1000).toISOString(),
        },
      ],
      feedback: [],
    }
  }

  it('renders observations and submits feedback', async () => {
    mockedGet.mockResolvedValue(makeDetail())
    mockedPost.mockResolvedValue({ ok: true })

    const user = userEvent.setup()
    renderRoute(<TracesPage traceId="trace_abc" />)

    expect(await screen.findByText(/observations/i)).toBeInTheDocument()
    expect(screen.getByText('input')).toBeInTheDocument()
    expect(screen.getByText('output')).toBeInTheDocument()

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
    expect(path).toBe('/api/traces/trace_abc/feedback')
    expect(body).toEqual({ thumbs: 'down', comment: 'wrong tone', correction: 'should be friendlier' })
  })
})
