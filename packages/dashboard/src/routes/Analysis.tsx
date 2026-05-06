/**
 * Analysis — paste-a-prompt + Mallet issues panel.
 *
 * Spec: gravel-cloud/docs/spec/analysis.md §4. Calls the embedding app's
 * `POST /api/analysis` (which proxies to Mallet via the control plane).
 */
import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { type AnalysisResponse, type MalletIssue } from '../lib/types'
import { Badge } from '../components/Badge'
import { cx } from '../lib/format'

export function AnalysisPage() {
  const [prompt, setPrompt] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)

  const analyze = useMutation<AnalysisResponse, Error, string>({
    mutationFn: (text) => api.post<AnalysisResponse>('/api/analysis', { prompt: text }),
    onSuccess: (_d, text) => setSubmitted(text),
  })

  const issues = analyze.data?.issues ?? []

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-text-dark">
          Mallet analysis
          <span className="ml-2 align-middle text-xs font-normal text-text-muted">
            powered by Artanis
          </span>
        </h1>
        <p className="mt-1 text-sm text-text-mid">
          Paste a prompt to surface contradictions, ambiguities, and best-practice gaps.
        </p>
      </header>

      <section className="rounded-2xl border border-warm bg-cream p-4">
        <label className="block text-xs font-medium text-text-mid" htmlFor="analysis-input">
          Prompt
        </label>
        <textarea
          id="analysis-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="You are a helpful assistant. Be brief but give detailed answers…"
          rows={10}
          className="mt-1 w-full rounded-md border border-warm bg-white px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-text-muted">
            {prompt.length.toLocaleString()} chars
            {analyze.data?.rate_limit && (
              <>
                {' '}· {analyze.data.rate_limit.remaining}/{analyze.data.rate_limit.limit} analyses left today
              </>
            )}
          </p>
          <button
            type="button"
            disabled={!prompt.trim() || analyze.isPending}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
              !prompt.trim() || analyze.isPending
                ? 'cursor-not-allowed bg-primary/60'
                : 'cursor-pointer bg-primary hover:bg-primary-dark',
            )}
            onClick={() => analyze.mutate(prompt)}
          >
            {analyze.isPending ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
        {analyze.isError && (
          <p className="mt-2 font-mono text-xs text-primary-dark">{analyze.error.message}</p>
        )}
      </section>

      {analyze.data && (
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-text-dark">
            {issues.length === 0 ? 'No issues found' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
          </h2>
          {issues.length === 0 ? (
            <p className="text-sm text-text-mid">Mallet didn't flag anything in this prompt.</p>
          ) : (
            <>
              {submitted && <PromptWithMarkers text={submitted} issues={issues} />}
              <ul className="space-y-2">
                {issues.map((issue, i) => (
                  <IssueCard key={`${issue.type}-${issue.range[0]}-${i}`} issue={issue} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function severityTone(severity: string): 'bad' | 'warn' | 'info' | 'neutral' {
  if (severity === 'error') return 'bad'
  if (severity === 'warning') return 'warn'
  if (severity === 'info') return 'info'
  return 'neutral'
}

function IssueCard({ issue }: { issue: MalletIssue }) {
  return (
    <li className="rounded-xl border border-warm bg-cream p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-text-mid">
        <Badge tone={severityTone(issue.severity)}>{issue.severity}</Badge>
        <span className="font-mono">{issue.type}</span>
        <span className="text-text-muted">
          chars {issue.range[0]}–{issue.range[1]}
        </span>
      </div>
      <p className="mt-2 text-text-dark">{issue.message}</p>
    </li>
  )
}

/**
 * Render the analysed prompt with inline highlights at each issue's char
 * range, so the DE can see *where* in the prompt the issue is.
 */
function PromptWithMarkers({ text, issues }: { text: string; issues: MalletIssue[] }) {
  const segments = useMemo(() => sliceIntoSegments(text, issues), [text, issues])
  return (
    <pre className="overflow-auto rounded-xl border border-warm bg-cream p-3 font-mono text-xs leading-relaxed">
      {segments.map((seg, i) =>
        seg.issue ? (
          <mark
            key={i}
            className={cx(
              'rounded px-0.5',
              seg.issue.severity === 'error'
                ? 'bg-primary/20 text-primary-dark'
                : seg.issue.severity === 'warning'
                  ? 'bg-accent/40 text-earth-dark'
                  : 'bg-earth-light/20 text-earth-dark',
            )}
            title={seg.issue.message}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </pre>
  )
}

interface Segment {
  text: string
  issue: MalletIssue | null
}

/**
 * Split `text` into segments aligned to non-overlapping issue ranges.
 * Overlaps: the first issue wins; later ones are dropped from the highlight
 * pass (still rendered in the issue list below).
 */
function sliceIntoSegments(text: string, issues: MalletIssue[]): Segment[] {
  const sorted = [...issues]
    .filter((i) => i.range[0] >= 0 && i.range[1] <= text.length && i.range[0] < i.range[1])
    .sort((a, b) => a.range[0] - b.range[0])

  const segments: Segment[] = []
  let cursor = 0
  for (const issue of sorted) {
    const [start, end] = issue.range
    if (start < cursor) continue // overlap — skip
    if (start > cursor) segments.push({ text: text.slice(cursor, start), issue: null })
    segments.push({ text: text.slice(start, end), issue })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), issue: null })
  return segments
}
