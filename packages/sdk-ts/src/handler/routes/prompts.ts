/**
 * Prompts routes: list + detail + submit.
 *
 * The manifest is the source of truth for both list and detail; the
 * dashboard's PromptDetail page calls the detail endpoint to get the
 * authoritative file content + char-range slice (for embedded
 * prompts). Submit takes inline `drafts` from dashboard localStorage,
 * mints a GitHub App installation token via the control plane, and
 * opens a single PR with the manifest rewritten to preserve
 * downstream offsets.
 */
import { json } from '../index.js'
import { repoRoot } from '../repo-root.js'
import type { RouteTable } from '../route-ctx.js'

export const promptsRoutes: RouteTable = {
  'GET /api/prompts': async ({ authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    const { readManifest } = await import('../../manifest/io.js')
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const manifest = await readManifest(repoRoot())
    // Inline a short preview per prompt so the dashboard's grid can
    // render content without an N+1 fetch. Read failures degrade to
    // an empty preview rather than failing the whole list.
    const prompts = await Promise.all(
      manifest.prompts.map(async (p) => {
        let preview = ''
        try {
          const text = await fs.readFile(join(repoRoot(), p.path), 'utf8')
          const slice = p.type === 'embedded' ? text.slice(p.charStart, p.charEnd) : text
          preview = slice.trim().slice(0, 280)
        } catch {
          /* file gone since manifest scan; return blank preview */
        }
        return { ...p, preview }
      }),
    )
    return json({ prompts, last_scan_at: manifest.lastFullScanAt })
  },
  'GET /api/prompts/:id': async ({ path, authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    const id = path.split('/').pop()
    if (!id) return json({ error: 'missing id' }, 400)
    const { readManifest } = await import('../../manifest/io.js')
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const manifest = await readManifest(repoRoot())
    const entry = manifest.prompts.find((p) => p.id === id)
    if (!entry) return json({ error: 'not found' }, 404)

    const fullText = await fs.readFile(join(repoRoot(), entry.path), 'utf8')
    if (entry.type === 'file') {
      return json({ id: entry.id, type: entry.type, path: entry.path, content: fullText })
    }
    // Embedded: slice by char range.
    const content = fullText.slice(entry.charStart, entry.charEnd)
    return json({
      id: entry.id,
      type: entry.type,
      path: entry.path,
      varName: entry.varName,
      content,
    })
  },
  // Drafts live in the dashboard's localStorage (no server persistence).
  // The submit endpoint receives them inline.
  'POST /api/prompts/submit': async ({ request, authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    let body: {
      title?: unknown
      description?: unknown
      submitterName?: unknown
      drafts?: unknown
    }
    try {
      body = (await request.json().catch(() => ({}))) as typeof body
    } catch {
      body = {}
    }
    if (!Array.isArray(body.drafts) || body.drafts.length === 0) {
      return json(
        { error: 'no_drafts', message: 'drafts (non-empty array) required in request body' },
        400,
      )
    }
    const drafts: { promptId: string; newText: string }[] = []
    for (const raw of body.drafts) {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof (raw as { promptId?: unknown }).promptId !== 'string' ||
        typeof (raw as { newText?: unknown }).newText !== 'string'
      ) {
        return json(
          { error: 'invalid_draft', message: 'each draft needs string promptId + newText' },
          400,
        )
      }
      drafts.push({
        promptId: (raw as { promptId: string }).promptId,
        newText: (raw as { newText: string }).newText,
      })
    }
    const { getGhInstallState } = await import('../../github/project-state.js')
    const ghState = await getGhInstallState()
    if (!ghState) {
      return json(
        {
          error: 'github_not_installed',
          message:
            'Gravel GitHub App is not installed on this project. Ask your developer to install it from the dashboard.',
        },
        409,
      )
    }
    // Mint a fresh installation token for this submit. CP HMAC-verifies
    // the install_secret in our env (set by the install callback) and
    // forwards a 1-hour repo-scoped token from GitHub.
    const { mintInstallationTokenViaCp } = await import('../../github/project-state.js')
    let token: Awaited<ReturnType<typeof mintInstallationTokenViaCp>>
    try {
      token = await mintInstallationTokenViaCp(ghState)
    } catch (err) {
      return json(
        { error: 'github_token_mint_failed', message: (err as Error).message },
        502,
      )
    }
    const { submitDrafts, SubmitError, draftBranchFor } = await import('../../prompts/submit.js')
    try {
      // submitterName comes from the dashboard form. Falls back to the
      // host's getUser() firstName when the field is left blank, which
      // mostly only happens for non-interactive callers.
      const submitterName =
        typeof body.submitterName === 'string' && body.submitterName.trim()
          ? body.submitterName.trim()
          : authed.firstName
      const result = await submitDrafts({
        repoRoot: repoRoot(),
        drafts,
        draftBranch: draftBranchFor(authed.id),
        accessToken: token.token,
        repoOwner: ghState.repoOwner,
        repoName: ghState.repoName,
        title: typeof body.title === 'string' ? body.title : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        deFirstName: submitterName,
      })
      return json({ ok: true, pr: result })
    } catch (err) {
      if (err instanceof SubmitError) {
        return json({ error: err.code, message: err.message, details: err.details }, 400)
      }
      throw err
    }
  },
}
