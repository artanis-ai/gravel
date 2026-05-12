/**
 * `gravel doctor` — print the running SDK version, what npm has at
 * @latest, the detected host stack, and the exact upgrade command for
 * that stack.
 *
 * The dashboard's UpdateBanner solves the same problem inside the
 * browser for developers actually using the dashboard, but only fires
 * when someone happens to be looking. The CLI form covers:
 *   - CI / automation that wants to fail loudly if the host's pinned
 *     SDK has fallen behind (use `--json` + jq, or rely on the exit
 *     code: doctor exits 1 when `hasUpdate: true`).
 *   - Developers who never open `/admin/ai` but ran `gravel init`
 *     once and want a quick "am I up to date?" check.
 *
 * Honors `GRAVEL_VERSION_CHECK_DISABLED=1` (same flag as the banner)
 * so privacy-conscious envs can keep the CLI offline.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md §6 (update journey).
 */
import { getVersionInfo, type VersionInfo } from '../handler/version.js'
import type { PackageManager } from '../handler/host-stack.js'

export interface DoctorOptions {
  /** Emit machine-readable JSON instead of human-readable text. */
  json?: boolean
}

export const PACKAGE_NAME = '@artanis-ai/gravel'

/**
 * The exact upgrade command for the detected host stack. Pure (no IO)
 * so tests can pin every variant. Falls back to pnpm if the manager
 * is unrecognised — same as the dashboard banner.
 */
export function updateCommand(
  manager: PackageManager,
  target: string,
  pkg: string = PACKAGE_NAME,
): string {
  switch (manager) {
    case 'npm':
      return `npm install ${pkg}@${target}`
    case 'yarn':
      return `yarn upgrade ${pkg}@${target}`
    case 'bun':
      return `bun update ${pkg}@${target}`
    case 'uv':
      return `uv pip install --upgrade ${pkg}==${target}`
    case 'poetry':
      return `poetry add ${pkg}@${target}`
    case 'pipenv':
      return `pipenv update ${pkg}`
    case 'pip':
      return `pip install --upgrade ${pkg}==${target}`
    case 'pnpm':
    default:
      return `pnpm update ${pkg}@${target}`
  }
}

/**
 * Build the human-readable doctor output. Split out from `runDoctor`
 * so tests can drive it with synthetic VersionInfo without mocking
 * the registry / lockfiles.
 */
export function renderDoctor(info: VersionInfo): string {
  const pkg = info.language === 'python' ? 'artanis-gravel' : PACKAGE_NAME
  const lines: string[] = []
  lines.push(`${pkg} ${info.current}`)
  lines.push(`  stack: ${info.language} (${info.packageManager})`)
  if (info.latest === null) {
    lines.push('  latest: (unknown — npm registry unreachable or version check disabled)')
  } else if (info.hasUpdate) {
    lines.push(`  latest: ${info.latest}`)
    lines.push('')
    lines.push('  Update available. Run:')
    lines.push(`    ${updateCommand(info.packageManager, info.latest, pkg)}`)
  } else {
    lines.push(`  latest: ${info.latest} (up to date)`)
  }
  return lines.join('\n')
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const info = await getVersionInfo()
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(info, null, 2))
  } else {
    // eslint-disable-next-line no-console
    console.log(renderDoctor(info))
  }
  process.exitCode = info.hasUpdate ? 1 : 0
}
