/**
 * Draft prompt edits — read/write to the browser's localStorage.
 *
 * Drafts moved out of the customer's database 2026-05-08 (D-Q53). Storing
 * them here keeps the data plane to two tables and avoids the awkward
 * "what if multiple browsers stage drafts for the same DE" question — each
 * browser is its own queue. The submit endpoint accepts the drafts array
 * inline in the request body.
 *
 * Storage key: `gravel:drafts:<userId>`. Value: `{ [promptId]: LocalDraft }`.
 */
export interface LocalDraft {
  promptId: string
  newText: string
  /** ms since epoch; for "draft saved" toast + ordering. */
  updatedAt: number
}

const KEY_PREFIX = 'gravel:drafts'

function key(userId: string): string {
  return `${KEY_PREFIX}:${userId}`
}

type Stored = Record<string, LocalDraft>

function read(userId: string): Stored {
  try {
    const raw = localStorage.getItem(key(userId))
    return raw ? (JSON.parse(raw) as Stored) : {}
  } catch {
    return {}
  }
}

function write(userId: string, value: Stored): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify(value))
  } catch {
    // quota exceeded, Safari private mode, etc. — silent fail; the
    // dashboard will just show no draft on next read.
  }
}

export function listDrafts(userId: string): LocalDraft[] {
  return Object.values(read(userId)).sort((a, b) => a.promptId.localeCompare(b.promptId))
}

export function getDraft(userId: string, promptId: string): LocalDraft | null {
  return read(userId)[promptId] ?? null
}

export function upsertDraft(
  userId: string,
  input: { promptId: string; newText: string },
): LocalDraft {
  const stored = read(userId)
  const next: LocalDraft = {
    promptId: input.promptId,
    newText: input.newText,
    updatedAt: Date.now(),
  }
  stored[input.promptId] = next
  write(userId, stored)
  return next
}

export function removeDraft(userId: string, promptId: string): void {
  const stored = read(userId)
  delete stored[promptId]
  write(userId, stored)
}

export function clearDrafts(userId: string): void {
  try {
    localStorage.removeItem(key(userId))
  } catch {
    /* ignore */
  }
}

/** Mirror of the SDK's draftBranchFor; used to render the branch name in the UI. */
export function draftBranchFor(userId: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  const sanitized = userId.replace(/[^A-Za-z0-9._-]/g, '-')
  return `gravel/draft-${date}-${sanitized}`
}
