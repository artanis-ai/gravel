/**
 * Patch-only tests for the FastAPI + Django mount step. The patcher
 * functions are pure string-in-string-out so we can hammer them with
 * common project shapes without touching the filesystem.
 */
import { describe, it, expect } from 'vitest'
import { patchFastApiMain, patchDjangoUrls } from '../src/wizard/mount.js'

describe('patchFastApiMain', () => {
  it('inserts import + include_router after the FastAPI() call', () => {
    const before = `from fastapi import FastAPI

app = FastAPI(title="acme-api")
`
    const after = patchFastApiMain(before, '/admin/ai')
    expect(after).toContain(`from gravel_route import router as gravel_router`)
    expect(after).toContain(`app.include_router(gravel_router, prefix='/admin/ai')`)
    // Order: import-block first, then app construction, then include.
    const lines = after.split('\n')
    const importLine = lines.findIndex((l) => l.includes('from gravel_route'))
    const ctorLine = lines.findIndex((l) => l.includes('= FastAPI('))
    const includeLine = lines.findIndex((l) => l.includes('include_router(gravel_router'))
    expect(importLine).toBeGreaterThanOrEqual(0)
    expect(ctorLine).toBeGreaterThan(importLine)
    expect(includeLine).toBeGreaterThan(ctorLine)
  })

  it('handles a non-default app variable name', () => {
    const before = `from fastapi import FastAPI

api = FastAPI()
`
    const after = patchFastApiMain(before, '/admin/ai')
    expect(after).toContain(`api.include_router(gravel_router, prefix='/admin/ai')`)
    expect(after).not.toContain('app.include_router')
  })

  it('is idempotent — running it twice is a no-op', () => {
    const before = `from fastapi import FastAPI

app = FastAPI()
`
    const once = patchFastApiMain(before, '/admin/ai')
    const twice = patchFastApiMain(once, '/admin/ai')
    expect(twice).toEqual(once)
  })

  it('returns the input unchanged when FastAPI() spans multiple lines (caller falls back to copy-paste)', () => {
    const before = `from fastapi import FastAPI

app = FastAPI(
    title="acme-api",
    version="1",
)
`
    const after = patchFastApiMain(before, '/admin/ai')
    expect(after).toEqual(before)
  })

  it('returns input unchanged for the lazy-import pattern (caller falls back to copy-paste)', () => {
    // `import fastapi` + `fastapi.FastAPI()` is unusual; the patcher
    // bails so the wizard prints copy-paste rather than inserting an
    // import without a matching include.
    const before = `import fastapi
app = fastapi.FastAPI()
`
    const after = patchFastApiMain(before, '/admin/ai')
    expect(after).toEqual(before)
  })
})

describe('patchDjangoUrls', () => {
  it('adds include to existing django.urls import + new gravel import + path entry', () => {
    const before = `from django.urls import path

urlpatterns = [
    path('admin/', admin.site.urls),
]
`
    const after = patchDjangoUrls(before, '/admin/ai')
    expect(after).toContain(`from django.urls import path, include`)
    expect(after).toContain(`from artanis_gravel.django import gravel_urls`)
    expect(after).toContain(`path('admin/ai/', include(gravel_urls))`)
    // gravel path goes FIRST, before any catch-all.
    const gravelIdx = after.indexOf(`path('admin/ai/'`)
    const adminIdx = after.indexOf(`path('admin/',`)
    expect(gravelIdx).toBeLessThan(adminIdx)
  })

  it('preserves existing include import when already present', () => {
    const before = `from django.urls import path, include

urlpatterns = [
    path('admin/', admin.site.urls),
]
`
    const after = patchDjangoUrls(before, '/admin/ai')
    // No duplicated `include` import.
    expect(after.match(/from django\.urls import path, include/g)?.length).toBe(1)
  })

  it('is idempotent', () => {
    const before = `from django.urls import path

urlpatterns = [
    path('admin/', admin.site.urls),
]
`
    const once = patchDjangoUrls(before, '/admin/ai')
    const twice = patchDjangoUrls(once, '/admin/ai')
    expect(twice).toEqual(once)
  })

  it('returns input unchanged when there is no urlpatterns assignment', () => {
    const before = `# stub urls module — nothing to patch
`
    const after = patchDjangoUrls(before, '/admin/ai')
    expect(after).toEqual(before)
  })

  it('strips leading/trailing slashes from mount path before inserting', () => {
    const before = `from django.urls import path

urlpatterns = [
]
`
    const after = patchDjangoUrls(before, '///admin/ai///')
    expect(after).toContain(`path('admin/ai/', include(gravel_urls))`)
  })
})
