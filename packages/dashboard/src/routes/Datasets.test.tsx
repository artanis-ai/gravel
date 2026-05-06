/**
 * Tests for Datasets list + detail.
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
import { DatasetsPage } from './Datasets'
import { renderRoute } from '../test/util'
import type { DatasetDetailResponse, DatasetsResponse } from '../lib/types'

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
})

describe('Datasets list', () => {
  it('shows the empty state and lets the user create a dataset', async () => {
    mockedGet.mockResolvedValue({ datasets: [], runPipelineConfigured: false } satisfies DatasetsResponse)
    mockedPost.mockResolvedValue({
      id: 'ds_1',
      name: 'golden_v2',
      description: 'baseline',
      trace_count: 0,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })

    const user = userEvent.setup()
    renderRoute(<DatasetsPage />)

    expect(await screen.findByText(/no datasets yet/i)).toBeInTheDocument()

    // Open modal via the empty-state action button
    const emptyAction = screen.getAllByRole('button', { name: /new dataset/i })
    await user.click(emptyAction[0])

    const dialog = await screen.findByRole('dialog', { name: /new dataset/i })
    await user.type(within(dialog).getByPlaceholderText(/golden_v2/), 'golden_v2')
    await user.type(within(dialog).getByPlaceholderText(/what this dataset covers/i), 'baseline')

    // Pre-prime the next list refresh — react-query will refetch after invalidation.
    mockedGet.mockResolvedValue({
      datasets: [
        {
          id: 'ds_1',
          name: 'golden_v2',
          description: 'baseline',
          trace_count: 0,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
      runPipelineConfigured: false,
    } satisfies DatasetsResponse)

    await user.click(within(dialog).getByRole('button', { name: /create/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    const [path, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/api/datasets')
    expect(body).toEqual({ name: 'golden_v2', description: 'baseline' })

    expect(await screen.findByText('golden_v2')).toBeInTheDocument()
  })
})

describe('Dataset detail', () => {
  function makeDetail(runPipelineConfigured: boolean): DatasetDetailResponse {
    return {
      dataset: {
        id: 'ds_1',
        name: 'golden_v2',
        description: null,
        trace_count: 1,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      traces: [
        {
          dataset_trace_id: 'dt_1',
          trace: {
            id: 'trace_a',
            name: 'chat.completions.create',
            model: 'gpt-4o',
            environment: 'prod',
            status: 'completed',
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            duration_ms: 200,
            tokens_in: 50,
            tokens_out: 20,
            feedback_count: 1,
            feedback_score: 'negative',
          },
        },
      ],
      runPipelineConfigured,
    }
  }

  it('disables the live-eval button when runPipeline is not configured', async () => {
    mockedGet.mockResolvedValue(makeDetail(false))
    renderRoute(<DatasetsPage datasetId="ds_1" />)

    const liveBtn = await screen.findByRole('button', { name: /run live eval/i })
    expect(liveBtn).toBeDisabled()
    expect(liveBtn).toHaveAttribute('title', expect.stringContaining('runPipeline'))
  })

  it('starts a trace eval and navigates to the run', async () => {
    mockedGet.mockResolvedValue(makeDetail(true))
    mockedPost.mockResolvedValue({
      id: 'run_1',
      dataset_id: 'ds_1',
      dataset_name: 'golden_v2',
      type: 'trace',
      status: 'pending',
      total_rows: 0,
      completed_rows: 0,
      summary: null,
      started_at: null,
      completed_at: null,
      created_at: new Date().toISOString(),
    })

    const user = userEvent.setup()
    renderRoute(<DatasetsPage datasetId="ds_1" />)

    const traceBtn = await screen.findByRole('button', { name: /run trace eval/i })
    await user.click(traceBtn)

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]).toEqual(['/api/evals/runs', { datasetId: 'ds_1', type: 'trace' }])
  })
})

