import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { PreferencesStore } from '../../src/main/preferences'
import { VaultRepository } from '../../src/main/vault/repository'
import { SyncService } from '../../src/main/sync/service'
import { pathExists } from '../../src/main/vault/paths'
import { openKeyBackup } from '../../src/main/vault/keyBackup'

const exec = promisify(execFile)
const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'

const fakeSecrets = {
  has: async () => true,
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
      await expect(source.push()).rejects.toMatchObject({ code: 'SYNC_DISABLED' })
      await source.setEnabled(true)
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
      await target.setEnabled(true)
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

  it('远端分叉时先拉取可恢复，本地未推送条目仍保留', async () => {
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
      await sourceRepo.saveEntry(draft('2026-11-08', '原始', '原始正文'))
      const source = new SyncService({
        repository: sourceRepo,
        preferences: sourcePrefs,
        secrets: fakeSecrets as never
      })
      await source.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      await source.setEnabled(true)
      await source.push()

      // 两台设备从同一个提交出发，各自再提交一次
      await cp(sourceDir, targetDir, { recursive: true })
      const targetPrefs = new PreferencesStore({
        file: path.join(root, 'target-prefs.json'),
        defaultDiaryDir: targetDir
      })
      const targetRepo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await targetRepo.unlock(PASSWORD)
      await targetRepo.saveEntry(draft('2026-11-08', '目标改过', '目标改过的正文'))
      const target = new SyncService({
        repository: targetRepo,
        preferences: targetPrefs,
        secrets: fakeSecrets as never
      })
      await target.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      await target.setEnabled(true)
      await target.push()

      await sourceRepo.saveEntry(draft('2026-11-09', '来源新增', '来源新增正文'))
      await expect(source.push()).rejects.toMatchObject({ code: 'SYNC_CONFLICT' })
      expect(sourceRepo.getSnapshot().entries.map((entry) => entry.date)).toContain('2026-11-09')

      // 拉取丢弃镜像里的本地分叉，但 vault 里的 11-09 还在；再推送会合并两边
      await source.pull()
      expect(sourceRepo.getSnapshot().entries.map((entry) => entry.date).sort()).toEqual([
        '2026-11-08',
        '2026-11-09'
      ])
      await source.push()
      await target.pull()
      expect(targetRepo.getSnapshot().entries.map((entry) => entry.date).sort()).toEqual([
        '2026-11-08',
        '2026-11-09'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('旧 vault 的同步镜像会被丢弃，新空仓库拉取不报另一个库', async () => {
    process.env['MINIDIARY_ALLOW_LOCAL_REMOTE'] = '1'
    const root = await tempDir()
    const remote = path.join(root, 'remote.git')
    const dir = path.join(root, 'diary')
    try {
      await exec('git', ['init', '--bare', remote])
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      const syncDir = path.join(dir, '.sync')
      await mkdir(syncDir, { recursive: true })
      await writeFile(
        path.join(syncDir, 'sync.json'),
        JSON.stringify({ format: 1, vaultId: 'old-vault-id' })
      )
      const prefs = new PreferencesStore({
        file: path.join(root, 'prefs.json'),
        defaultDiaryDir: dir
      })
      const service = new SyncService({
        repository: repo,
        preferences: prefs,
        secrets: fakeSecrets as never
      })
      await service.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      await service.setEnabled(true)

      await expect(service.pull()).resolves.toEqual({ entries: 0, annotations: 0 })
      expect(await pathExists(path.join(syncDir, 'sync.json'))).toBe(false)

      await repo.saveEntry(draft('2026-11-08', '新库', '新库正文'))
      await service.push()
      const meta = JSON.parse(await readFile(path.join(syncDir, 'sync.json'), 'utf8')) as {
        vaultId: string
      }
      expect(meta.vaultId).toBe(repo.getVaultId())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('用 .inkkey 恢复空库后可以拉取同一 Git 仓库', async () => {
    process.env['MINIDIARY_ALLOW_LOCAL_REMOTE'] = '1'
    const root = await tempDir()
    const remote = path.join(root, 'remote.git')
    const sourceDir = path.join(root, 'source')
    const targetDir = path.join(root, 'target')
    try {
      await exec('git', ['init', '--bare', remote])
      const sourceRepo = new VaultRepository({ dir: sourceDir })
      await sourceRepo.create(PASSWORD)
      await sourceRepo.saveEntry(draft('2026-11-08', '密钥恢复', '从 Git 拉回来'))
      const source = new SyncService({
        repository: sourceRepo,
        preferences: new PreferencesStore({
          file: path.join(root, 'source-prefs.json'),
          defaultDiaryDir: sourceDir
        }),
        secrets: fakeSecrets as never
      })
      await source.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      await source.setEnabled(true)
      await source.push()

      const backup = await sourceRepo.createKeyBackup('backup-password')
      const { dek } = await openKeyBackup(backup, 'backup-password')
      const targetRepo = new VaultRepository({ dir: targetDir, scrypt: FAST })
      await targetRepo.createFromKey(backup.vaultId, dek, 'new-diary-password')
      expect(targetRepo.getSnapshot().vaultId).toBe(backup.vaultId)

      const target = new SyncService({
        repository: targetRepo,
        preferences: new PreferencesStore({
          file: path.join(root, 'target-prefs.json'),
          defaultDiaryDir: targetDir
        }),
        secrets: fakeSecrets as never
      })
      await target.configure({ repo: `file://${remote}`, branch: 'main', token: 'fake-token' })
      await target.setEnabled(true)
      await target.pull()
      expect(targetRepo.getSnapshot().entries.map((entry) => entry.title)).toContain('密钥恢复')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
