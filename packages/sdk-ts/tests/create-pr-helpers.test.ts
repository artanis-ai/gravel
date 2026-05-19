/**
 * Unit tests for the PR title + manifest-diff explainer helpers in
 * github/create-pr.ts. These ship as part of v0.8.0 alongside the
 * /feedback page that consumes the footer link.
 */
import { describe, it, expect } from 'vitest'
import { defaultPRTitle, describeManifestDiff, type ManifestDiffEntry } from '../src/github/create-pr.js'

describe('defaultPRTitle (software default — no LLM)', () => {
  it('zero files → fallback', () => {
    expect(defaultPRTitle([])).toBe('Update prompts')
  })
  it('one file → basename only', () => {
    expect(defaultPRTitle(['api/py/prompts/judge.txt'])).toBe('Update judge.txt')
  })
  it('two files → "A and B"', () => {
    expect(defaultPRTitle(['a/judge.txt', 'b/rewrite.txt'])).toBe('Update judge.txt and rewrite.txt')
  })
  it('three files → "A, B and C"', () => {
    expect(defaultPRTitle(['judge.txt', 'rewrite.txt', 'triage.md'])).toBe(
      'Update judge.txt, rewrite.txt and triage.md',
    )
  })
  it('four files → "A, B and 2 others"', () => {
    expect(
      defaultPRTitle(['judge.txt', 'rewrite.txt', 'triage.md', 'discharge.md']),
    ).toBe('Update judge.txt, rewrite.txt and 2 others')
  })
  it('uses basename (strips dirs)', () => {
    expect(defaultPRTitle(['deep/nested/path/onboarding.md'])).toBe('Update onboarding.md')
  })
})

describe('describeManifestDiff (all six cases)', () => {
  it('empty diff → empty array', () => {
    expect(describeManifestDiff([])).toEqual([])
  })

  it('first_add collapses to a single explainer paragraph', () => {
    const out = describeManifestDiff([{ kind: 'first_add' }])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/About `\.gravel\/manifest\.json`/)
    expect(out[0]).toMatch(/tracks which prompts/)
  })

  it('added → bullet with id + path', () => {
    const out = describeManifestDiff([
      { kind: 'added', promptId: 'p_new1', path: 'prompts/new.md' },
    ])
    expect(out[0]).toBe('**Manifest changes** (`.gravel/manifest.json`):')
    expect(out[1]).toBe(
      '- Added prompt `prompts/new.md` (id `p_new1`). New entry tracked by the manifest.',
    )
  })

  it('edited → "hash changed because the content was edited"', () => {
    const out = describeManifestDiff([
      { kind: 'edited', promptId: 'p_edit1', path: 'prompts/judge.txt' },
    ])
    expect(out[1]).toMatch(/Updated prompt at `prompts\/judge\.txt`/)
    expect(out[1]).toMatch(/hash changed/)
  })

  it('removed → bullet says it is no longer tracked', () => {
    const out = describeManifestDiff([
      { kind: 'removed', promptId: 'p_old', path: 'prompts/dead.md' },
    ])
    expect(out[1]).toMatch(/Removed prompt `prompts\/dead\.md`/)
    expect(out[1]).toMatch(/no longer tracks/)
  })

  it('renamed → shows old → new with same-hash note', () => {
    const out = describeManifestDiff([
      {
        kind: 'renamed',
        promptId: 'p_moved',
        oldPath: 'old/path.md',
        path: 'new/path.md',
      },
    ])
    expect(out[1]).toMatch(/Renamed:.*`old\/path\.md`.*`new\/path\.md`/)
    expect(out[1]).toMatch(/Same content/)
  })

  it('anchors_changed → mentions surrounding code shifted', () => {
    const out = describeManifestDiff([
      { kind: 'anchors_changed', promptId: 'p_inl', path: 'src/agent.py' },
    ])
    expect(out[1]).toMatch(/inline-prompt anchors/)
    expect(out[1]).toMatch(/start\/end markers moved/)
  })

  it('mixed diff lists every entry under one header', () => {
    const diff: ManifestDiffEntry[] = [
      { kind: 'added', promptId: 'p1', path: 'a.md' },
      { kind: 'edited', promptId: 'p2', path: 'b.md' },
      { kind: 'removed', promptId: 'p3', path: 'c.md' },
    ]
    const out = describeManifestDiff(diff)
    expect(out).toHaveLength(4) // header + 3 bullets
    expect(out[0]).toBe('**Manifest changes** (`.gravel/manifest.json`):')
  })
})
