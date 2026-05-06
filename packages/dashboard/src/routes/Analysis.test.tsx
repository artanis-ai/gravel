/**
 * Tests for the Mallet analysis route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
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
import { AnalysisPage } from './Analysis'
import { renderRoute } from '../test/util'
import type { AnalysisResponse } from '../lib/types'

const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedPost.mockReset()
})

describe('Analysis', () => {
  it('disables Analyze when input is empty', () => {
    renderRoute(<AnalysisPage />)
    expect(screen.getByRole('button', { name: /analyze/i })).toBeDisabled()
  })

  it('submits the prompt and renders issues', async () => {
    const response: AnalysisResponse = {
      issues: [
        { type: 'contradiction', severity: 'error', range: [0, 9], message: 'conflicts with goal' },
        { type: 'ambiguity', severity: 'warning', range: [10, 18], message: 'vague' },
      ],
    }
    mockedPost.mockResolvedValue(response)

    const user = userEvent.setup()
    renderRoute(<AnalysisPage />)

    await user.type(screen.getByLabelText(/^prompt$/i), 'Be brief. Be detailed.')
    await user.click(screen.getByRole('button', { name: /analyze/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]).toEqual(['/api/analysis', { prompt: 'Be brief. Be detailed.' }])

    expect(await screen.findByText(/2 issues/i)).toBeInTheDocument()
    expect(screen.getByText(/conflicts with goal/i)).toBeInTheDocument()
    expect(screen.getByText(/vague/i)).toBeInTheDocument()
  })

  it("renders the no-issues message when Mallet returns nothing", async () => {
    mockedPost.mockResolvedValue({ issues: [] } satisfies AnalysisResponse)
    const user = userEvent.setup()
    renderRoute(<AnalysisPage />)
    await user.type(screen.getByLabelText(/^prompt$/i), 'looks fine')
    await user.click(screen.getByRole('button', { name: /analyze/i }))
    expect(await screen.findByText(/no issues found/i)).toBeInTheDocument()
  })
})
