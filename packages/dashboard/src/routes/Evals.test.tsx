/**
 * Tests for Evals list + detail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import { api } from '../lib/api'
import { EvalsPage } from './Evals'
import { renderRoute } from '../test/util'
import type { EvalRunDetailResponse, EvalRunsResponse } from '../lib/types'

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
  // EventSource isn't in jsdom — stub it.
  ;(globalThis as { EventSource?: unknown }).EventSource = class {
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: Event) => void) | null = null
    constructor() {
      // Simulate immediate failure → triggers polling fallback path.
      queueMicrotask(() => this.onerror?.(new Event('error')))
    }
    close() {}
  }
})

describe('Evals list', () => {
  it('renders empty state', async () => {
    mockedGet.mockResolvedValue({ runs: [] } satisfies EvalRunsResponse)
    renderRoute(<EvalsPage />)
    expect(await screen.findByText(/no eval runs yet/i)).toBeInTheDocument()
  })

  it('renders runs with status badges', async () => {
    mockedGet.mockResolvedValue({
      runs: [
        {
          id: 'run_a',
          dataset_id: 'ds_1',
          dataset_name: 'golden_v2',
          type: 'trace',
          status: 'completed',
          total_rows: 10,
          completed_rows: 10,
          summary: { passed: 9, failed: 1 },
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
    } satisfies EvalRunsResponse)

    renderRoute(<EvalsPage />)
    expect(await screen.findByText('golden_v2')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByText(/9 pass · 1 fail/i)).toBeInTheDocument()
  })
})

describe('Eval run detail', () => {
  function makeDetail(): EvalRunDetailResponse {
    return {
      run: {
        id: 'run_a',
        dataset_id: 'ds_1',
        dataset_name: 'golden_v2',
        type: 'trace',
        status: 'running',
        total_rows: 4,
        completed_rows: 2,
        summary: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        created_at: new Date().toISOString(),
      },
      results: [
        {
          id: 'er_1',
          trace_id: 't_1',
          input_snippet: 'why is the sky blue?',
          expected: 'rayleigh scattering',
          output: 'because of magic',
          live_output: null,
          verdict: {
            score: 0.4,
            passed: false,
            reasoning: 'Misses the science.',
            breakdown: { accuracy: 0.2, tone: 0.6, completeness: 0.4 },
          },
          created_at: new Date().toISOString(),
        },
      ],
    }
  }

  it('renders results, opens breakdown modal, and supports cancel', async () => {
    mockedGet.mockResolvedValue(makeDetail())
    mockedPost.mockResolvedValue({ ok: true })

    const user = userEvent.setup()
    renderRoute(<EvalsPage runId="run_a" />)

    expect(await screen.findByText('golden_v2')).toBeInTheDocument()
    expect(screen.getByText(/2\/4 rows/i)).toBeInTheDocument()
    expect(screen.getByText('fail')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show breakdown/i }))
    const dialog = await screen.findByRole('dialog', { name: /breakdown/i })
    expect(within(dialog).getByText(/misses the science/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/accuracy/i)).toBeInTheDocument()

    // Modal has both an icon × (aria-label "Close") and a footer "Close"
    // button — pick the footer one explicitly.
    const closeButtons = within(dialog).getAllByRole('button', { name: /close/i })
    await user.click(closeButtons[closeButtons.length - 1])

    await user.click(screen.getByRole('button', { name: /cancel run/i }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/evals/runs/run_a/cancel'))
  })
})
