/**
 * Tests for the prompt editor (load + auto-save + reset + discard).
 *
 * The Tiptap-backed SuggestionEditor is mocked to a plain textarea so
 * the tests assert behaviour (drafts persisting to localStorage,
 * dirty-state buttons, navigation) without coupling to ProseMirror
 * internals that don't render predictably in jsdom.
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

// Replace Tiptap with a textarea that surfaces value/onChange the same
// way the parent already wires them up. The toolbar / WYSIWYG layer has
// its own coverage; this lets us focus on the auto-save flow.
vi.mock('../components/prompts/SuggestionEditor', () => ({
  SuggestionEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string
    onChange: (next: string) => void
    ariaLabel?: string
  }) => (
    <textarea
      aria-label={ariaLabel ?? 'Prompt draft'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
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

function setup(detail?: PromptDetailResponse) {
  const d: PromptDetailResponse = detail ?? {
    id: 'p_abc',
    type: 'file',
    path: 'prompts/triage.md',
    content: 'You are a helpful assistant.',
  }
  mockedGet.mockImplementation(async (path: string) => {
    if (path === '/api/auth/me') {
      return { user: { id: USER_ID, firstName: 'Developer', role: 'admin' } }
    }
    if (path.startsWith('/api/prompts/')) return d
    throw new Error(`unmocked GET ${path}`)
  })
}

describe('PromptDetail', () => {
  it('seeds the editor with the current text', async () => {
    setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    await screen.findByText('prompts/triage.md')
    const ta = screen.getByLabelText(/prompt draft/i) as HTMLTextAreaElement
    expect(ta.value).toBe('You are a helpful assistant.')
  })

  it('auto-saves the draft to localStorage after the debounce window', async () => {
    setup()
    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    const ta = (await screen.findByLabelText(/prompt draft/i)) as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'You are a careful assistant.')

    // Auto-save flushes ~500ms after the last keystroke. Poll the local
    // store rather than asserting on the toolbar status indicator —
    // the parent owns the persistence path, the indicator is cosmetic.
    await waitFor(
      () => {
        const draft = getDraft(USER_ID, 'p_abc')
        expect(draft?.newText).toBe('You are a careful assistant.')
      },
      { timeout: 3000 },
    )
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('reset reverts the draft to the original', async () => {
    setup()
    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    const ta = (await screen.findByLabelText(/prompt draft/i)) as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'changed')
    await user.click(screen.getByRole('button', { name: /reset/i }))
    expect(ta.value).toBe('You are a helpful assistant.')
    // Reset clears the dirty state, so the Reset button itself disappears.
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
  })

  it('reset clears the draft from localStorage and reverts the editor', async () => {
    upsertDraft(USER_ID, { promptId: 'p_abc', newText: 'old draft' })
    setup()

    const user = userEvent.setup()
    renderRoute(<PromptsPage promptId="p_abc" />)
    await screen.findByText('prompts/triage.md')
    // The single "Reset" action subsumes the old "Discard draft" button;
    // it both wipes the local draft AND reverts the editor text.
    const resetBtn = await screen.findByRole('button', { name: /^reset$/i })
    await user.click(resetBtn)

    await waitFor(() => {
      expect(getDraft(USER_ID, 'p_abc')).toBeNull()
    })
    const ta = screen.getByLabelText(/prompt draft/i) as HTMLTextAreaElement
    expect(ta.value).toBe('You are a helpful assistant.')
    expect(mockedDelete).not.toHaveBeenCalled()
  })
})
