/**
 * Tests for the prompt editor (load + edit + save + discard + diff +
 * Mallet-404 fallback).
 *
 * Drafts persist in localStorage now; tests seed/inspect that directly.
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
import { PromptsPage } from './Prompts'
import { renderRoute } from '../test/util'
import { getDraft, upsertDraft } from '../lib/drafts'
import type { PromptDetailResponse } from '../lib/types'

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>
const mockedPut = api.put as unknown as ReturnType<typeof vi.fn>
const mockedDelete = api.delete as unknown as ReturnType<typeof vi.fn>

const USER_ID = 'localhost'

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
  mockedPut.mockReset()
  mockedDelete.mockReset()
  localStorage.clear()
})

interface Setup {
  detail?: PromptDetailResponse
  analysis?: unknown
  analysisFails?: 'not-found' | 'other'
}

function setup(opts: Setup = {}) {
  const detail: PromptDetailResponse = opts.detail ?? {
    id: 'p_abc',
    type: 'file',
    path: 'prompts/triage.md',
    content: 'You are a helpful assistant.',
  }
  mockedGet.mockImplementation(async (path: string) => {
    if (path === '/api/auth/me') {
      return { user: { id: USER_ID, firstName: 'Developer', role: 'admin' } }
    }
    if (path.startsWith('/api/prompts/')) return detail
    throw new Error(`unmocked GET ${path}`)
  })
  mockedPost.mockImplementation(async (path: string) => {
    if (path === '/api/analysis') {
      if (opts.analysisFails === 'not-found') throw new Error('404 Not Found')
      if (opts.analysisFails === 'other') throw new Error('500 boom')
      return opts.analysis ?? { issues: [] }
    }
    throw new Error(`unmocked POST ${path}`)
  })
}

describe('PromptDetail', () => {
  it('loads current text into both panes and renders the diff inline', async () => {
    setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    await screen.findByText('prompts/triage.md')
    const current = screen.getByTestId('current-pane')
    expect(current).toHaveTextContent('You are a helpful assistant.')
    const ta = screen.getByLabelText(/draft prompt text/i) as HTMLTextAreaElement
    expect(ta.value).toBe('You are a helpful assistant.')
    expect(screen.getByTestId('diff-view')).toBeInTheDocument()
  })

  it('renders insertions in the diff when the draft text changes', async () => {
    setup()
    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    const ta = (await screen.findByLabelText(/draft prompt text/i)) as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'You are an honest assistant.')
    const diff = screen.getByTestId('diff-view')
    await waitFor(() => {
      expect(diff.querySelector('ins[data-op="insert"]')).not.toBeNull()
    })
  })

  it('saves the draft to localStorage and shows a toast', async () => {
    setup()
    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    const ta = (await screen.findByLabelText(/draft prompt text/i)) as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'You are a careful assistant.')
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => {
      const draft = getDraft(USER_ID, 'p_abc')
      expect(draft?.newText).toBe('You are a careful assistant.')
    })
    expect(mockedPut).not.toHaveBeenCalled()
    expect(await screen.findByText(/draft saved on branch/i)).toBeInTheDocument()
  })

  it('discards an existing draft from localStorage', async () => {
    upsertDraft(USER_ID, { promptId: 'p_abc', newText: 'old draft' })
    setup()

    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    await screen.findByText('prompts/triage.md')
    const discardBtn = await screen.findByRole('button', { name: /discard draft/i })
    await user.click(discardBtn)

    await waitFor(() => {
      expect(getDraft(USER_ID, 'p_abc')).toBeNull()
    })
    expect(mockedDelete).not.toHaveBeenCalled()
  })

  it('shows the Mallet-not-available fallback on 404', async () => {
    setup({ analysisFails: 'not-found' })
    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    const ta = (await screen.findByLabelText(/draft prompt text/i)) as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'try analysis')
    const panel = screen.getByTestId('mallet-panel')
    await waitFor(() => expect(within(panel).getByText(/not available in this build/i)).toBeInTheDocument(), {
      timeout: 2500,
    })
  })
})
