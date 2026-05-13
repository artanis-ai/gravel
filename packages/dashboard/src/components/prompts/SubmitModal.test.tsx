/**
 * Tests for the SubmitModal in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api', async () => {
  // Re-export ApiError from the real module so `instanceof ApiError`
  // checks inside SubmitModal still hit the same constructor when the
  // test throws one.
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  }
})

import { api, ApiError } from '../../lib/api'
import { SubmitModal, type SubmitDraftEntry } from './SubmitModal'
import { renderRoute } from '../../test/util'

const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>
const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedPost.mockReset()
  mockedGet.mockReset()
  // Modal queries /api/auth/me to seed the name field. Default to a
  // localhost dev so tests don't need to wire it explicitly.
  mockedGet.mockResolvedValue({ user: { id: 'localhost', firstName: 'Developer', role: 'admin' } })
  // Each test gets a clean localStorage so the name field doesn't leak.
  try {
    localStorage.clear()
  } catch {
    /* jsdom env */
  }
})

function makeEntry(overrides: Partial<SubmitDraftEntry> = {}): SubmitDraftEntry {
  return {
    draft: {
      promptId: 'p_abc',
      newText: 'You are a careful assistant.',
      updatedAt: Date.now(),
    },
    prompt: {
      id: 'p_abc',
      type: 'file',
      path: 'prompts/triage.md',
      hash: 'abc',
      preview: 'You are a helpful assistant.',
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
    await user.click(screen.getByRole('button', { name: /send for review/i }))
    expect(await screen.findByText(/title is required/i)).toBeInTheDocument()
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('posts title + description + submitterName and fires onSubmitted', async () => {
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
    // Name field defaults to 'admin' for the localhost mock — confirm
    // it's there, then change it to assert the override path works.
    await waitFor(() =>
      expect((within(dialog).getByPlaceholderText(/^pat$/i) as HTMLInputElement).value).toBe('admin'),
    )
    await user.clear(within(dialog).getByPlaceholderText(/^pat$/i))
    await user.type(within(dialog).getByPlaceholderText(/^pat$/i), 'Alice')
    await user.type(within(dialog).getByPlaceholderText(/tighten triage prompt/i), 'Tighten triage')
    await user.click(within(dialog).getByRole('button', { name: /send for review/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]).toEqual([
      '/api/prompts/submit',
      {
        title: 'Tighten triage',
        description: undefined,
        submitterName: 'Alice',
        drafts: [{ promptId: 'p_abc', newText: 'You are a careful assistant.' }],
      },
    ])
    expect(onSubmitted).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    // Name is cached so the next submit prefills.
    expect(localStorage.getItem('gravel:submitter-name')).toBe('Alice')
  })

  it('prefills the name from localStorage on subsequent opens', async () => {
    localStorage.setItem('gravel:submitter-name', 'Pat')
    renderRoute(<SubmitModal open onClose={() => {}} drafts={[makeEntry()]} onSubmitted={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: /submit changes/i })
    await waitFor(() =>
      expect((within(dialog).getByPlaceholderText(/^pat$/i) as HTMLInputElement).value).toBe('Pat'),
    )
  })

  it('disables the submit button when there are no drafts', () => {
    renderRoute(
      <SubmitModal open onClose={() => {}} drafts={[]} onSubmitted={() => {}} />,
    )
    expect(screen.getByRole('button', { name: /send for review/i })).toBeDisabled()
  })

  // Regression: the old error-display path only rendered err.message — for
  // ApiError that was just the code ("github_failed") with no message or
  // details, which is useless to a non-engineer. Verify the Alert now
  // shows the humanised title, the server message, AND the details box.
  it('renders a styled Alert with server message + details when submit fails', async () => {
    mockedPost.mockRejectedValue(
      new ApiError({
        status: 400,
        code: 'github_failed',
        serverMessage: 'Could not read src/landlord_ai/persona.py from artanis-ai/landlord-ai',
        details: 'Not Found',
      }),
    )
    const user = userEvent.setup()
    renderRoute(
      <SubmitModal open onClose={() => {}} drafts={[makeEntry()]} onSubmitted={() => {}} />,
    )
    const dialog = await screen.findByRole('dialog', { name: /submit changes/i })
    await user.clear(within(dialog).getByPlaceholderText(/^pat$/i))
    await user.type(within(dialog).getByPlaceholderText(/^pat$/i), 'Alice')
    await user.type(within(dialog).getByPlaceholderText(/tighten triage prompt/i), 'Tighten')
    await user.click(within(dialog).getByRole('button', { name: /send for review/i }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/GitHub didn’?t accept the change|GitHub didn't accept the change/i)
    expect(alert).toHaveTextContent(/Could not read src\/landlord_ai\/persona\.py/i)
    expect(within(alert).getByText('Not Found')).toBeInTheDocument()
  })

  it('falls back to a generic title when the error code is unknown', async () => {
    mockedPost.mockRejectedValue(
      new ApiError({
        status: 500,
        code: 'something_we_dont_map',
        serverMessage: 'Backend exploded',
        details: null,
      }),
    )
    const user = userEvent.setup()
    renderRoute(
      <SubmitModal open onClose={() => {}} drafts={[makeEntry()]} onSubmitted={() => {}} />,
    )
    const dialog = await screen.findByRole('dialog', { name: /submit changes/i })
    await user.clear(within(dialog).getByPlaceholderText(/^pat$/i))
    await user.type(within(dialog).getByPlaceholderText(/^pat$/i), 'Alice')
    await user.type(within(dialog).getByPlaceholderText(/tighten triage prompt/i), 'X')
    await user.click(within(dialog).getByRole('button', { name: /send for review/i }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/Couldn[’']t send for review/i)
    expect(alert).toHaveTextContent('Backend exploded')
  })

  it('shows a spinner inside the submit button while the request is in flight', async () => {
    // Resolve later so we can observe the in-flight state.
    let resolveSubmit: (v: unknown) => void = () => {}
    mockedPost.mockReturnValue(new Promise((r) => { resolveSubmit = r }))
    const user = userEvent.setup()
    renderRoute(
      <SubmitModal open onClose={() => {}} drafts={[makeEntry()]} onSubmitted={() => {}} />,
    )
    const dialog = await screen.findByRole('dialog', { name: /submit changes/i })
    await user.clear(within(dialog).getByPlaceholderText(/^pat$/i))
    await user.type(within(dialog).getByPlaceholderText(/^pat$/i), 'Alice')
    await user.type(within(dialog).getByPlaceholderText(/tighten triage prompt/i), 'X')
    await user.click(within(dialog).getByRole('button', { name: /send for review/i }))

    // While in flight: the button shows "Sending…", contains a spinner
    // role=img, and is disabled.
    const sending = await within(dialog).findByRole('button', { name: /sending/i })
    expect(sending).toBeDisabled()
    expect(within(sending).getByRole('img', { hidden: true })).toBeInTheDocument()

    // Cleanup.
    resolveSubmit({
      ok: true,
      pr: { prUrl: 'https://x', prNumber: 1, branchName: 'b' },
    })
    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
  })
})
