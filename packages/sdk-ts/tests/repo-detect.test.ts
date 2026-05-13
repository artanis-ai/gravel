import { describe, it, expect } from 'vitest'
import { parseGithubRemoteUrl } from '../src/github/repo-detect'

describe('parseGithubRemoteUrl', () => {
  const cases: Array<[string, { owner: string; name: string } | null]> = [
    // SSH
    ['git@github.com:artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    ['git@github.com:artanis-ai/gravel', { owner: 'artanis-ai', name: 'gravel' }],
    // HTTPS, with + without .git, with + without trailing /, with + without auth
    ['https://github.com/artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    ['https://github.com/artanis-ai/gravel', { owner: 'artanis-ai', name: 'gravel' }],
    ['https://github.com/artanis-ai/gravel/', { owner: 'artanis-ai', name: 'gravel' }],
    ['https://oauth2:token@github.com/artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    ['http://github.com/artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    // ssh:// and git://
    ['ssh://git@github.com/artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    ['git://github.com/artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    // Case-insensitive host
    ['HTTPS://GITHUB.COM/artanis-ai/gravel.git', { owner: 'artanis-ai', name: 'gravel' }],
    // Dots, dashes, underscores in repo names
    ['git@github.com:my-org/my.weird_repo-name.git', { owner: 'my-org', name: 'my.weird_repo-name' }],
    // Reject non-github
    ['git@gitlab.com:foo/bar.git', null],
    ['https://bitbucket.org/foo/bar.git', null],
    // Reject malformed
    ['', null],
    ['not a url', null],
    ['https://github.com/onlyone', null],
    ['https://github.com//bar.git', null],
  ]

  for (const [url, want] of cases) {
    it(`parses ${JSON.stringify(url)} → ${want ? `${want.owner}/${want.name}` : 'null'}`, () => {
      expect(parseGithubRemoteUrl(url)).toEqual(want)
    })
  }
})
