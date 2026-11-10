import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { PreferencesStore } from '../../src/main/preferences'
import { VaultRepository } from '../../src/main/vault/repository'
import { SyncService } from '../../src/main/sync/service'

const exec = promisify(execFile)
const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'

const fakeSecrets = {
  available: async () => true,
  get: async () => 'fake-token',
  set: async () => undefined,
  clear: async () => undefined
}

async function tempDir(prefix = 'minidiary-syncsvc-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

function draft(date: string, title: string, body: string) {
  return { date, title, body, tags: [], attachments: [] }
}

describe('SyncService', () => {
  const previous = process.env['MINIDIARY_ALLOW_LOCAL_REMOTE']
  afterEach(() => {
    if (previous === undefined) delete process.env['MINIDIARY_ALLOW_LOCAL_REMOTE']
    else process.env['MINIDIARY_ALLOW_LOCAL_REMOTE'] = previous
  })

  it('推送后另一设备拉取并合并本地条目', async () => {
    process.env['MINIDIARY_ALLOW_LOCAL_REMOTE'] = '1'
    const root = await tempDir()
    const remote = path.join(root, 'remote.git')
    const sourceDir = path.join(root, 'source')
    const targetDir = path.join(root, 'target')
    try {
      await exec('git', ['init', '--bare', remote])

      const sourcePrefs = new PreferencesStore({
        file: path.join(root, 'source-prefs.json'),
        defaultDiaryDir: sourceDir
      })
      const sourceRepo = new VaultRepository({ dir: sourceDir, scrypt: FAST })
      await sourceRepo.create(PASSWORD)
      await sourceRepo.saveEntry(draft('2026-11-08', '来源', '来源正文'))
      await sourceRepo.addAnnotation({ date: '2026-11-08', quote: '', tag: '', body: '批注' })
      const source = new SyncService({
        repository: sourceRepo,
        preferences: sourcePrefs,
        secrets: fakeSecrets as never
      })
      await source.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      const pushed = await source.push()
      expect(pushed.commits).toBe(1)

      await cp(path.join(sourceDir, 'diary.vault'), path.join(targetDir, 'diary.vault'))
      const targetPrefs = new PreferencesStore({
        file: path.join(root, 'target-prefs.json'),
        defaultDiaryDir: targetDir
      })
      const targetRepo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await targetRepo.unlock(PASSWORD)
      await targetRepo.saveEntry(draft('2026-11-09', '本地', '本地正文'))
      const target = new SyncService({
        repository: targetRepo,
        preferences: targetPrefs,
        secrets: fakeSecrets as never
      })
      await target.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      const pulled = await target.pull()
      expect(pulled.entries).toBe(0) // 目标库已有 11-08，无新增
      expect(targetRepo.getSnapshot().entries.map((entry) => entry.date).sort()).toEqual([
        '2026-11-08',
        '2026-11-09'
      ])

      // 目标设备把本地新增的 11-09 推回去，源设备拉取
      await target.push()
      const sourcePull = await source.pull()
      expect(sourcePull.entries).toBe(1)
      expect(sourceRepo.getSnapshot().entries.map((entry) => entry.date).sort()).toEqual([
        '2026-11-08',
        '2026-11-09'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
