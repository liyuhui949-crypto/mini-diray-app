import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { VaultRepository } from '../../src/main/vault/repository'
import { buildMirror, readMirror, syncRoot } from '../../src/main/sync/mirror'
import {
  checkoutRemoteBranch,
  classifyGitFailure,
  commitAll,
  fetchOrigin,
  initRepo,
  push,
  runGit
} from '../../src/main/sync/git'

const exec = promisify(execFile)
const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'
const TODAY = '2026-11-10'

async function tempDir(prefix = 'minidiary-git-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

function draft(date: string, title: string, body: string) {
  return { date, title, body, tags: [], attachments: [] }
}

describe('git error classification', () => {
  it('403 / 无写权限归为认证权限错误，不再伪装成代理错误', () => {
    const error = classifyGitFailure(
      new Error('git failed'),
      'remote: Write access to repository not granted.\nfatal: unable to access https://github.com/x/y.git/: The requested URL returned error: 403',
      true
    )
    expect(error.code).toBe('GIT_AUTH_FAILED')
  })

  it('代理连接超时仍归为代理错误', () => {
    const error = classifyGitFailure(
      new Error('git failed'),
      'fatal: unable to access https://github.com/x/y.git/: Failed to connect to 127.0.0.1 port 7897 after 0 ms: Couldn\'t connect to server',
      true
    )
    expect(error.code).toBe('GIT_PROXY')
  })
})

describe('sync git runner', () => {
  it('把镜像提交/推送，另一个设备拉取后合并', async () => {
    const root = await tempDir()
    const remote = path.join(root, 'remote.git')
    const sourceDir = path.join(root, 'source')
    const targetDir = path.join(root, 'target')
    try {
      await exec('git', ['init', '--bare', remote])

      const source = new VaultRepository({ dir: sourceDir, scrypt: FAST })
      await source.create(PASSWORD)
      await source.saveEntry(draft('2026-11-08', '来源', '来源正文'))
      await source.addAnnotation({ date: '2026-11-08', quote: '', tag: '', body: '批注' })
      await source.flush()
      await buildMirror(source, TODAY)

      const sourceOptions = { cwd: syncRoot(sourceDir) }
      await initRepo(sourceOptions.cwd, remote)
      await commitAll(sourceOptions, 'test sync')
      await push(sourceOptions, 'main')

      // 目标设备先有同一把 vault（模拟迁移包/一键迁移），再拉取
      await cp(path.join(sourceDir, 'diary.vault'), path.join(targetDir, 'diary.vault'))
      const target = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await target.unlock(PASSWORD)
      await target.saveEntry(draft('2026-11-09', '本地', '本地正文'))

      const targetOptions = { cwd: syncRoot(targetDir) }
      await initRepo(targetOptions.cwd, remote)
      await fetchOrigin(targetOptions)
      await checkoutRemoteBranch(targetOptions, 'main')
      const mirror = await readMirror(target, TODAY)
      expect(mirror.entries.map((entry) => entry.date)).toEqual(['2026-11-08'])
      const applied = await target.applySync(mirror, TODAY)
      expect(applied.entries).toBe(0)
      expect(applied.annotations).toBe(1)
      expect(target.getSnapshot().entries.map((entry) => entry.date).sort()).toEqual([
        '2026-11-08',
        '2026-11-09'
      ])
      expect(target.getSnapshot().annotations['2026-11-08']?.[0]?.body).toBe('批注')
      const head = await runGit(['rev-parse', 'HEAD'], targetOptions)
      expect(head.stdout.trim()).toHaveLength(40)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
