/**
 * Pre-commit hook installer. Polite-blocking: blocks `git commit` when the
 * manifest is stale, with a clear "run X to fix" message and `--no-verify`
 * bypass. Spec: gravel-cloud/docs/spec/manifest.md §5.
 *
 * Detects:
 *   - Husky (.husky/pre-commit) — append our line.
 *   - pre-commit framework (.pre-commit-config.yaml) — append a local hook.
 *   - Otherwise — write/append .git/hooks/pre-commit (mode 0755).
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { constants as fsConstants } from 'node:fs'

const NATIVE_HOOK_BODY = `#!/usr/bin/env sh
# Added by Gravel — keep .gravel/manifest.json in sync with prompts in your code.
# Polite-blocking: bypass with \`git commit --no-verify\`.
gravel manifest --check || {
  echo ""
  echo "Gravel: Your prompt manifest is out of date."
  echo "Run:    gravel manifest --update"
  echo "Then:   git add .gravel/manifest.json && git commit"
  echo ""
  echo "(To bypass: git commit --no-verify)"
  exit 1
}
`

const HUSKY_LINE = `gravel manifest --check\n`

const PRECOMMIT_YAML_LOCAL = `  - repo: local
    hooks:
      - id: gravel-manifest
        name: Gravel manifest check
        entry: gravel manifest --check
        language: system
        pass_filenames: false
`

export type HookInstallMode = 'husky' | 'pre-commit-framework' | 'native' | 'skipped'

export interface HookInstallResult {
  mode: HookInstallMode
  path?: string
  alreadyInstalled?: boolean
}

export async function installHook(repoRoot: string): Promise<HookInstallResult> {
  // 1. Husky
  const huskyPath = join(repoRoot, '.husky', 'pre-commit')
  if (await exists(huskyPath)) {
    const content = await fs.readFile(huskyPath, 'utf8')
    if (content.includes('gravel manifest')) {
      return { mode: 'husky', path: huskyPath, alreadyInstalled: true }
    }
    await fs.writeFile(huskyPath, content + (content.endsWith('\n') ? '' : '\n') + HUSKY_LINE)
    return { mode: 'husky', path: huskyPath }
  }

  // 2. pre-commit framework
  const preCommitYaml = join(repoRoot, '.pre-commit-config.yaml')
  if (await exists(preCommitYaml)) {
    const content = await fs.readFile(preCommitYaml, 'utf8')
    if (content.includes('gravel-manifest')) {
      return { mode: 'pre-commit-framework', path: preCommitYaml, alreadyInstalled: true }
    }
    // Append a `local` hook block. If `repos:` already exists, indent under it.
    const updated = content.includes('repos:')
      ? content + (content.endsWith('\n') ? '' : '\n') + PRECOMMIT_YAML_LOCAL
      : `repos:\n${PRECOMMIT_YAML_LOCAL}`
    await fs.writeFile(preCommitYaml, updated)
    return { mode: 'pre-commit-framework', path: preCommitYaml }
  }

  // 3. Native git hook
  const gitHookDir = join(repoRoot, '.git', 'hooks')
  if (!(await exists(gitHookDir))) {
    return { mode: 'skipped' }
  }
  const hookPath = join(gitHookDir, 'pre-commit')
  if (await exists(hookPath)) {
    const content = await fs.readFile(hookPath, 'utf8')
    if (content.includes('gravel manifest')) {
      return { mode: 'native', path: hookPath, alreadyInstalled: true }
    }
    await fs.writeFile(hookPath, content + (content.endsWith('\n') ? '' : '\n') + HUSKY_LINE)
  } else {
    await fs.writeFile(hookPath, NATIVE_HOOK_BODY)
  }
  await fs.chmod(hookPath, 0o755)
  return { mode: 'native', path: hookPath }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}
