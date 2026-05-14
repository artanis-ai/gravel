/**
 * LangchainRetriever — renderer for `langchain.retriever` (Python)
 * and `langchain.retriever.<runnable-id>` (TS).
 *
 * Captured by the SDK's LC callback handler when a retriever
 * (vector store, BM25, hybrid, etc.) fires. Persisted standalone
 * so reviewers can audit which queries returned which documents
 * without re-running the chain.
 *
 * Input shape:
 *   - `query: string` — the retrieval query
 *   - `serialized` — LC's dump of the retriever
 *   - `parent_run_id?`
 *
 * Output shape:
 *   - `documents: Array<{page_content, metadata}>`
 *   - `count: number`
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import type { Renderer } from '../types'

export const LangchainRetrieverRenderer: Renderer = ({ input, output }) => {
  const query = extractQuery(input)
  const serialized = extractSerialized(input)
  const parentRunId = isPlainObject(input) && typeof input.parent_run_id === 'string'
    ? input.parent_run_id
    : null
  const documents = extractDocuments(output)
  const count = isPlainObject(output) && typeof output.count === 'number'
    ? output.count
    : documents.length

  const inputPane = (
    <div className="space-y-2">
      <div className="rounded border border-forest/30 bg-forest/5 p-3 text-xs">
        <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
          <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
            Retrieval
          </span>
          {parentRunId && (
            <span className="font-mono text-[10px] text-text-muted">parent: {parentRunId}</span>
          )}
        </div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Query</div>
        {query !== null ? (
          <p className="whitespace-pre-wrap break-words text-sm">{query}</p>
        ) : (
          <HumanValue value={input} />
        )}
      </div>
      {serialized !== null ? (
        <div className="rounded border border-warm bg-warm/10 p-3 text-xs">
          <h5 className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
            Retriever
          </h5>
          <HumanValue value={serialized} />
        </div>
      ) : null}
    </div>
  )

  const outputPane =
    documents.length === 0 && (output === null || output === undefined) ? null : (
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-text-muted">
          {count} document{count === 1 ? '' : 's'}
        </div>
        {documents.length === 0 ? (
          <HumanValue value={output} />
        ) : (
          <div className="space-y-1.5">
            {documents.map((doc, i) => (
              <DocumentCard key={i} index={i} doc={doc} />
            ))}
          </div>
        )}
      </div>
    )

  return { input: inputPane, output: outputPane }
}

interface RetrievedDoc {
  page_content: string | null
  metadata: Record<string, unknown> | null
  raw: unknown
}

function extractQuery(input: unknown): string | null {
  if (!isPlainObject(input)) return null
  if (typeof input.query === 'string') return input.query
  if (typeof input.input === 'string') return input.input
  return null
}

function extractSerialized(input: unknown): unknown | null {
  if (!isPlainObject(input)) return null
  if ('serialized' in input && input.serialized !== null && input.serialized !== undefined) {
    return input.serialized
  }
  return null
}

function extractDocuments(output: unknown): RetrievedDoc[] {
  if (!isPlainObject(output)) return []
  const docs = output.documents
  if (!Array.isArray(docs)) return []
  return docs.map((d) => {
    if (!isPlainObject(d)) return { page_content: null, metadata: null, raw: d }
    return {
      page_content: typeof d.page_content === 'string' ? d.page_content : null,
      metadata: isPlainObject(d.metadata) ? d.metadata : null,
      raw: d,
    }
  })
}

function DocumentCard({ index, doc }: { index: number; doc: RetrievedDoc }): ReactNode {
  const source = doc.metadata && typeof doc.metadata.source === 'string' ? doc.metadata.source : null
  const score = doc.metadata && typeof doc.metadata.score === 'number' ? doc.metadata.score : null
  return (
    <div className="rounded border border-warm bg-white p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[10px] uppercase tracking-wide text-text-muted">
        <span>doc #{index}</span>
        {source && <span className="font-mono normal-case">{source}</span>}
        {score !== null && <span>score: {score.toFixed(2)}</span>}
      </div>
      {doc.page_content !== null ? (
        <p className="whitespace-pre-wrap break-words text-sm">{doc.page_content}</p>
      ) : (
        <HumanValue value={doc.raw} />
      )}
      {doc.metadata && Object.keys(doc.metadata).length > 0 && (
        <div className="mt-1.5 border-t border-warm pt-1.5">
          <HumanValue value={filterMetadata(doc.metadata)} />
        </div>
      )}
    </div>
  )
}

function filterMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  // Source + score are already shown in the header — drop them from
  // the metadata grid so we don't repeat.
  const { source: _s, score: _sc, ...rest } = meta
  return rest
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
