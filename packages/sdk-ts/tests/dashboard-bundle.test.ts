import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_INDEX_HTML,
  DASHBOARD_LOGIN_HTML,
  DASHBOARD_ASSETS,
} from '../src/handler/dashboard-bundle.js'

/**
 * Smoke test for the generated bundle module. Asserts the build script
 * (or its stub) emits the contract the route handlers depend on:
 *  - index HTML contains the React mount point
 *  - at least one .js asset is present in the asset map
 *  - login HTML reuses the index shell (single-SPA model)
 */
describe('dashboard-bundle', () => {
  it('exposes index HTML containing the React mount point', () => {
    expect(typeof DASHBOARD_INDEX_HTML).toBe('string')
    expect(DASHBOARD_INDEX_HTML).toContain('<div id="root"></div>')
  })

  it('reuses the index shell for the login route', () => {
    expect(DASHBOARD_LOGIN_HTML).toBe(DASHBOARD_INDEX_HTML)
  })

  it('exposes at least one .js asset', () => {
    const assetNames = Object.keys(DASHBOARD_ASSETS)
    expect(assetNames.length).toBeGreaterThan(0)
    const jsAssets = assetNames.filter((name) => name.endsWith('.js'))
    expect(jsAssets.length).toBeGreaterThan(0)
    for (const name of jsAssets) {
      const asset = DASHBOARD_ASSETS[name]!
      expect(asset.contentType).toMatch(/javascript/)
      expect(typeof asset.content).toBe('string')
    }
  })
})
