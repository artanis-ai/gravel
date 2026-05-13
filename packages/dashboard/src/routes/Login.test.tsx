/**
 * LoginPage coverage.
 *
 * The form posts as application/x-www-form-urlencoded to
 * `<mountPath>/api/auth/login`. The handler's form branch 303s on
 * success or 303s to /login?error=1 on failure. UI under test must
 * therefore: (a) submit as form (not JSON), (b) target the right
 * URL, (c) honor productName branding, (d) keep the password input
 * required + autoFocused, (e) be unbranded by default.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoginPage } from './Login'

describe('LoginPage', () => {
  beforeEach(() => {
    // Reset the per-test globals the SPA shell would inject.
    delete window.__GRAVEL_MOUNT_PATH__
    delete window.__GRAVEL_PRODUCT_NAME__
  })

  it('renders a password input that is required and autoFocused', () => {
    render(<LoginPage />)
    const pw = screen.getByLabelText('Password') as HTMLInputElement
    expect(pw.type).toBe('password')
    expect(pw.required).toBe(true)
    // jsdom doesn't actually focus elements on `autoFocus` like a
    // real browser does, but it does set the `autofocus` HTML
    // attribute. Either signal is acceptable evidence that React
    // applied the prop.
    expect(pw.hasAttribute('autofocus') || document.activeElement === pw).toBe(true)
  })

  it('renders a submit button labelled "Sign in"', () => {
    render(<LoginPage />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('posts as form (not JSON) to /api/auth/login', () => {
    window.__GRAVEL_MOUNT_PATH__ = '/admin/ai'
    render(<LoginPage />)
    const form = document.querySelector('form')!
    expect(form.method.toLowerCase()).toBe('post')
    expect(form.action).toContain('/admin/ai/api/auth/login')
    // No explicit enctype on the form → browser default is
    // application/x-www-form-urlencoded, which is what the handler's
    // form branch expects. Pinning here so a refactor that switches
    // to multipart/form-data fails the test loudly.
    expect(['', 'application/x-www-form-urlencoded']).toContain(form.enctype.toLowerCase())
  })

  it('respects window.__GRAVEL_MOUNT_PATH__ for the form action', () => {
    window.__GRAVEL_MOUNT_PATH__ = '/some/other/mount'
    render(<LoginPage />)
    const form = document.querySelector('form')!
    expect(form.action).toContain('/some/other/mount/api/auth/login')
  })

  it('renders no product heading when productName is unset', () => {
    render(<LoginPage />)
    // Only the input label + the visual icon + the button text.
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('renders productName as the heading when set', () => {
    window.__GRAVEL_PRODUCT_NAME__ = 'Maple Ridge'
    render(<LoginPage />)
    expect(screen.getByRole('heading', { name: 'Maple Ridge' })).toBeInTheDocument()
  })

  it('does not render a heading for a productName that is only whitespace', () => {
    window.__GRAVEL_PRODUCT_NAME__ = '   '
    render(<LoginPage />)
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('keeps the form unbranded — no "Gravel" copy on the page', () => {
    // Verified at v0.5.8 when the dashboard's productName fallback
    // was changed from "Gravel" to "" in the Python SDK; pin so a
    // future refactor doesn't reintroduce a Gravel-branded heading.
    render(<LoginPage />)
    expect(screen.queryByText(/gravel/i)).toBeNull()
  })
})
