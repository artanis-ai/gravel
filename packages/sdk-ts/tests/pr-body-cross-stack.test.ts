/**
 * Cross-stack PR-body equivalence test (TS side).
 *
 * Loads `tests/fixtures/pr-body/cases.json` (shared with the Python
 * test at `python/gravel/tests/test_pr_body_cross_stack.py`) and
 * asserts each `expectedBody` matches the output of `composeBody`.
 *
 * Drift between TS and Python composers shows up here as a fixture
 * delta — exactly the regression class Olly's de_platform PR #249
 * (2026-05-20) was. Audit-seams-not-parts memory predicted it; this
 * fixture is the cross-stack canary.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { composeBody, type ManifestDiffEntry } from '../src/github/create-pr.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../tests/fixtures/pr-body/cases.json')

interface FixtureCase {
  name: string
  input: {
    description: string | null
    deFirstName: string | null
    changes: { path: string; content: string }[]
    manifestDiff: ManifestDiffEntry[] | null
    repoOwner: string
    repoName: string
    branchName: string
  }
  expectedBody: string
}

const doc = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
  cases: FixtureCase[]
}

describe('composeBody — cross-stack equivalence (TS side)', () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const body = composeBody({
        description: c.input.description ?? undefined,
        deFirstName: c.input.deFirstName ?? undefined,
        changes: c.input.changes,
        manifestDiff: c.input.manifestDiff ?? undefined,
        repoOwner: c.input.repoOwner,
        repoName: c.input.repoName,
        branchName: c.input.branchName,
      })
      expect(body).toBe(c.expectedBody)
    })
  }
})
