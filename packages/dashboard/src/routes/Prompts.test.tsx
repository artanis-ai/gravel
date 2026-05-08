/**
 * Tests for the Prompts list view.
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
import { PromptsPage } from './Prompts'
import { renderRoute } from '../test/util'
import type {
  DraftsResponse,
  GithubStatusResponse,
  ManifestPromptListItem,
  PromptsListResponse,
} from '../lib/types'

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
})

function makePrompt(overrides: Partial<ManifestPromptListItem> = {}): ManifestPromptListItem {
  return {
    id: 'p_aaa',
    type: 'file',
    path: 'prompts/triage.md',
    hash: 'h1',
    ...overrides,
  }
}

function routeFor(path: string): unknown {
  if (path === '/api/auth/me') {
    return { user: { id: 'localhost', firstName: 'Developer', role: 'admin' } }
  }
  if (path === '/api/prompts') {
    return { prompts: [], last_scan_at: null } satisfies PromptsListResponse
  }
  if (path === '/api/prompts/drafts') {
    return { draftBranch: 'gravel/draft-2026-05-05-u1', drafts: [] } satisfies DraftsResponse
  }
  if (path === '/api/github/status') {
    return {
      connected: true,
      repoOwner: 'acme',
      repoName: 'app',
      connectedAt: new Date().toISOString(),
    } satisfies GithubStatusResponse
  }
  throw new Error(`unmocked GET ${path}`)
}

function setupGet(promptOverrides: ManifestPromptListItem[] | null, draftPromptIds: string[] = [], gh?: Partial<GithubStatusResponse>) {
  mockedGet.mockImplementation(async (path: string) => {
    if (path === '/api/prompts') {
      return {
        prompts: promptOverrides ?? [],
        last_scan_at: null,
      } satisfies PromptsListResponse
    }
    if (path === '/api/prompts/drafts') {
      return {
        draftBranch: 'gravel/draft-2026-05-05-u1',
        drafts: draftPromptIds.map((pid, i) => ({
          id: `d_${i}`,
          promptId: pid,
          draftBranch: 'gravel/draft-2026-05-05-u1',
          newText: 'changed',
          editorUserId: 'u1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      } satisfies DraftsResponse
    }
    if (path === '/api/github/status') {
      return {
        connected: true,
        repoOwner: 'acme',
        repoName: 'app',
        connectedAt: new Date().toISOString(),
        ...(gh ?? {}),
      } satisfies GithubStatusResponse
    }
    if (path.startsWith('/api/prompts/')) {
      return { id: path.split('/').pop(), type: 'file', path: 'prompts/triage.md', content: 'before' }
    }
    return routeFor(path)
  })
}

describe('Prompts list', () => {
  it('renders the empty state when the manifest is empty', async () => {
    setupGet([])
    renderRoute(<PromptsPage />)
    expect(await screen.findByText(/no prompts yet/i)).toBeInTheDocument()
    // Developer-only hint visible because auth/me reports localhost. The
    // page-level DeveloperNote sits at the top under the tabs.
    expect(await screen.findByText(/manifest --update/i)).toBeInTheDocument()
    expect(screen.getAllByText(/visible only on localhost/i).length).toBeGreaterThan(0)
  })

  it('hides the CLI hint from domain experts (non-localhost user)', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path === '/api/auth/me') {
        return { user: { id: 'u_real', firstName: 'Pat', role: 'user' } }
      }
      return routeFor(path)
    })
    renderRoute(<PromptsPage />)
    expect(await screen.findByText(/no prompts yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/manifest --update/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/visible only on localhost/i)).not.toBeInTheDocument()
  })

  it('renders prompts grouped by directory and a draft dot', async () => {
    setupGet(
      [
        makePrompt({ id: 'p_a', path: 'prompts/triage.md' }),
        makePrompt({ id: 'p_b', path: 'prompts/extract.md' }),
        makePrompt({ id: 'p_c', type: 'embedded', path: 'src/agent.ts', varName: 'SYSTEM' }),
      ],
      ['p_a'],
    )
    renderRoute(<PromptsPage />)
    await screen.findByText('triage.md')
    expect(screen.getByText('extract.md')).toBeInTheDocument()
    expect(screen.getByText('agent.ts')).toBeInTheDocument()
    expect(screen.getByText('SYSTEM')).toBeInTheDocument()

    // The draft on p_a should produce the labelled dot.
    await waitFor(() => expect(screen.getByLabelText(/has draft/i)).toBeInTheDocument())
  })

  it('filters the list with the search box', async () => {
    setupGet([
      makePrompt({ id: 'p_a', path: 'prompts/triage.md' }),
      makePrompt({ id: 'p_b', path: 'prompts/extract.md' }),
    ])
    const user = userEvent.setup()
    renderRoute(<PromptsPage />)
    await screen.findByText('triage.md')
    await user.type(screen.getByLabelText(/search prompts/i), 'extract')
    expect(screen.queryByText('triage.md')).not.toBeInTheDocument()
    expect(screen.getByText('extract.md')).toBeInTheDocument()
  })

  it('hides Submit changes when there are no drafts and shows it otherwise', async () => {
    setupGet([makePrompt({ id: 'p_a', path: 'prompts/triage.md' })], [])
    const { unmount } = renderRoute(<PromptsPage />)
    await screen.findByText('triage.md')
    expect(screen.queryByRole('button', { name: /submit changes/i })).not.toBeInTheDocument()
    unmount()

    setupGet([makePrompt({ id: 'p_a', path: 'prompts/triage.md' })], ['p_a'])
    renderRoute(<PromptsPage />)
    await screen.findByText('triage.md')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit changes/i })).toBeInTheDocument(),
    )
  })

  it('opens the submit modal and posts the form', async () => {
    setupGet([makePrompt({ id: 'p_a', path: 'prompts/triage.md' })], ['p_a'])
    mockedPost.mockResolvedValue({
      ok: true,
      pr: { prUrl: 'https://github.com/acme/app/pull/1', prNumber: 1, branchName: 'gravel/draft-x' },
    })
    const user = userEvent.setup()
    renderRoute(<PromptsPage />)
    await screen.findByText('triage.md')

    const submitBtn = await waitFor(() => {
      const b = screen.getByRole('button', { name: /submit changes/i })
      if (!(b as HTMLButtonElement).disabled) return b
      throw new Error('still disabled')
    })
    await user.click(submitBtn)

    const dialog = await screen.findByRole('dialog', { name: /submit changes/i })
    expect(dialog).toBeInTheDocument()

    const titleInput = await screen.findByPlaceholderText(/tighten triage prompt/i)
    await user.type(titleInput, 'PR title')
    await user.click(screen.getByRole('button', { name: /open pr/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/prompts/submit', expect.objectContaining({ title: 'PR title' })))
  })

  it('shows the install-GitHub-App banner to the dev when not connected', async () => {
    setupGet([makePrompt()], [], { connected: false, repoOwner: null, repoName: null })
    renderRoute(<PromptsPage />)
    await screen.findByText(/install the gravel github app/i)
    expect(screen.getByRole('button', { name: /install github app/i })).toBeInTheDocument()
    // The whole banner is wrapped in DeveloperNote — visible only on
    // localhost. There are two such notes on this page (top + banner),
    // so just confirm at least one renders.
    expect(screen.getAllByText(/visible only on localhost/i).length).toBeGreaterThan(0)
  })

  it('hides the install-GitHub-App banner from non-localhost users', async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path === '/api/auth/me') {
        return { user: { id: 'u_real', firstName: 'Pat', role: 'user' } }
      }
      if (path === '/api/prompts') {
        return { prompts: [makePrompt()], last_scan_at: null }
      }
      if (path === '/api/prompts/drafts') {
        return { draftBranch: 'gravel/draft-2026-05-05-u1', drafts: [] }
      }
      if (path === '/api/github/status') {
        return { connected: false, repoOwner: null, repoName: null, connectedAt: null }
      }
      throw new Error(`unmocked GET ${path}`)
    })
    renderRoute(<PromptsPage />)
    // The prompt list still renders…
    await screen.findByText(/triage\.md/i)
    // …but no banner about installing the GH App.
    expect(screen.queryByText(/install the gravel github app/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /install github app/i })).not.toBeInTheDocument()
  })
})
