/**
 * CopyableCode coverage — clipboard write + transient "copied" state
 * + clipboard-unsupported graceful fallback.
 *
 * jsdom doesn't ship a navigator.clipboard; we install one via
 * Object.defineProperty before each test and use fireEvent.click
 * (raw event) rather than userEvent so the click handler runs
 * directly against our injected stub without userEvent's own
 * clipboard shim getting in the way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CopyableCode } from './CopyableCode'

function installClipboard(writeText: (s: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
}

describe('CopyableCode', () => {
  beforeEach(() => {
    installClipboard(async () => {})
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the supplied text inside a <code> element', () => {
    render(<CopyableCode>npm install foo</CopyableCode>)
    expect(screen.getByText('npm install foo')).toBeInTheDocument()
  })

  it('writes the exact text to the clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    render(<CopyableCode>uvx artanis-gravel init</CopyableCode>)
    fireEvent.click(screen.getByLabelText('Copy to clipboard'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('uvx artanis-gravel init'))
  })

  it('flips the aria-label to "Copied" after a successful copy', async () => {
    installClipboard(async () => {})
    render(<CopyableCode>x</CopyableCode>)
    fireEvent.click(screen.getByLabelText('Copy to clipboard'))
    await waitFor(() => expect(screen.getByLabelText('Copied')).toBeInTheDocument())
  })

  it('resets to "Copy to clipboard" after the 1.5s timeout', async () => {
    installClipboard(async () => {})
    render(<CopyableCode>x</CopyableCode>)
    fireEvent.click(screen.getByLabelText('Copy to clipboard'))
    await waitFor(() => expect(screen.getByLabelText('Copied')).toBeInTheDocument())
    // Real timers — useFakeTimers + awaited clipboard promise leads
    // to a deadlock (the timeout never fires because we never
    // advance through the microtask queue). 1700 ms keeps it honest
    // without burning much wall time.
    await new Promise((r) => setTimeout(r, 1700))
    expect(screen.getByLabelText('Copy to clipboard')).toBeInTheDocument()
  }, 5_000)

  it('does not crash when clipboard.writeText rejects (e.g. unsupported)', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    render(<CopyableCode>x</CopyableCode>)
    fireEvent.click(screen.getByLabelText('Copy to clipboard'))
    // Tick the event loop so the rejected promise settles.
    await new Promise((r) => setTimeout(r, 0))
    // Button should NOT have flipped to "Copied" — write failed.
    expect(screen.getByLabelText('Copy to clipboard')).toBeInTheDocument()
  })

  it('exposes the copied confirmation via aria-live for screen readers', () => {
    render(<CopyableCode>x</CopyableCode>)
    const live = document.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live?.textContent).toBe('')
  })
})
