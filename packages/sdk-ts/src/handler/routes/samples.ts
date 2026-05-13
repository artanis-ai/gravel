/**
 * Samples routes — one row per LLM call. Reads gravel_samples +
 * gravel_feedback.
 *
 * All three routes degrade when the DB isn't configured (prompts-only
 * install, no DATABASE_URL): list returns an empty page; detail
 * returns 404 with `tables-missing`; feedback returns 503.
 */
import { json } from '../index.js'
import type { RouteTable } from '../route-ctx.js'

export const samplesRoutes: RouteTable = {
  'GET /api/samples': async ({ request, db, authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    const url = new URL(request.url)
    if (!db) {
      return json({ samples: [], total: 0, page: 1, page_size: 20 })
    }
    const { gravelTablesExist } = await import('../../db/index.js')
    if (!(await gravelTablesExist(db))) {
      return json({ samples: [], total: 0, page: 1, page_size: 20 })
    }
    const { listSamples } = await import('../../samples/query.js')
    const result = await listSamples(db, {
      env: url.searchParams.get('env') ?? undefined,
      model: url.searchParams.get('model') ?? undefined,
      status: (url.searchParams.get('status') ?? undefined) as
        | 'running'
        | 'completed'
        | 'errored'
        | undefined,
      q: url.searchParams.get('q') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      page: url.searchParams.get('page') ? Number(url.searchParams.get('page')) : 1,
      pageSize: url.searchParams.get('page_size')
        ? Number(url.searchParams.get('page_size'))
        : undefined,
    })
    return json(result)
  },
  'GET /api/samples/:id': async ({ request, db, authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    const sampleId = new URL(request.url).pathname.split('/').pop()!
    if (!db) return json({ error: 'tables-missing' }, 404)
    const { gravelTablesExist } = await import('../../db/index.js')
    if (!(await gravelTablesExist(db))) return json({ error: 'tables-missing' }, 404)
    const { getSampleDetail } = await import('../../samples/query.js')
    const detail = await getSampleDetail(db, sampleId)
    if (!detail) return json({ error: 'not-found' }, 404)
    return json(detail)
  },
  'POST /api/samples/:id/feedback': async ({ request, db, authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    if (!db) return json({ error: 'tables-missing' }, 503)
    const sampleId = new URL(request.url).pathname.split('/').slice(-2, -1)[0]!
    let body: { score?: unknown; comment?: unknown; correction?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }
    const score =
      body.score === 'positive' || body.score === 'negative' || body.score === 'neutral'
        ? body.score
        : null
    const { recordSampleFeedback } = await import('../../samples/query.js')
    const result = await recordSampleFeedback(db, {
      sampleId,
      score,
      comment: typeof body.comment === 'string' ? body.comment : null,
      correction: typeof body.correction === 'string' ? body.correction : null,
      reporterUserId: authed.id,
    })
    return json({ ok: true, id: result.id })
  },
}
