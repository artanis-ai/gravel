/**
 * Tests for the SubmitModal in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import { api } from '../../lib/api'
import { SubmitModal, type SubmitDraftEntry } from './SubmitModal'
import { renderRoute } from '../../test/util'

const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedPost.mockReset()
})

function makeEntry(overrides: Partial<SubmitDraftEntry> = {}): SubmitDraftEntry {
  return {
    draft: {
      id: 'd_1',
      promptId: 'p_abc',
      draftBranch: 'gravel/draft-2026-05-05-alice',
      newText: 'You are a careful assistant.',
      editorUserId: 'u_1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    prompt: {
      id: 'p_abc',
      type: 'file',
      path: 'prompts/triage.md',
      hash: 'abc',
    },
    before: 'You are a helpful assistant.',
    ...overrides,
  }
}

describe('SubmitModal', () => {
  it('requires a title before submitting', async () => {
    const user = userEvent.setup()
    renderRoute(
      <SubmitModal open onClose={() => {}} drafts={[makeEntry()]} onSubmitted={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: /open pr/i }))
    expect(await screen.findByText(/title is required/i)).toBeInTheDocument()
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('posts title (and optional description) and fires onSubmitted', async () => {
    mockedPost.mockResolvedValue({
      ok: true,
      pr: { prUrl: 'https://github.com/acme/app/pull/9', prNumber: 9, branchName: 'gravel/draft-x' },
    })

    const onSubmitted = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderRoute(
      <SubmitModal open onClose={onClose} drafts={[makeEntry()]} onSubmitted={onSubmitted} />,
    )

    const dialog = await screen.findByRole('dialog', { name: /submit changes/i })
    await user.type(within(dialog).getByPlaceholderText(/tighten triage prompt/i), 'My PR title')
    await user.click(within(dialog).getByRole('button', { name: /open pr/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]).toEqual([
      '/api/prompts/submit',
      { title: 'My PR title', description: undefined },
    ])
    expect(onSubmitted).toHaveBeenCalledWith({
      ok: true,
      pr: { prUrl: 'https://github.com/acme/app/pull/9', prNumber: 9, branchName: 'gravel/draft-x' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('disables Open PR when there are no drafts', () => {
    renderRoute(
      <SubmitModal open onClose={() => {}} drafts={[]} onSubmitted={() => {}} />,
    )
    expect(screen.getByRole('button', { name: /open pr/i })).toBeDisabled()
  })
})
