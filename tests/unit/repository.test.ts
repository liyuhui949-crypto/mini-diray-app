import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { VaultRepository } from '../../src/main/vault/repository'
import { vaultPaths } from '../../src/main/vault/paths'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'

async function tempDir(prefix = 'minidiary-repo-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

function draft(date: string, overrides: Partial<Parameters<VaultRepository['saveEntry']>[0]> = {}) {
  return {
    date,
    title: '',
    body: '',
    tags: [],
    attachments: [],
    ...overrides
  }
}

describe('VaultRepository', () => {
  it('创建后立即解锁，磁盘上没有明文', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      expect(await repo.statusOnDisk()).toBe('missing')
      const snapshot = await repo.create(PASSWORD)
      expect(snapshot.entries).toHaveLength(0)
      expect(repo.isUnlocked).toBe(true)

      await repo.saveEntry(
        draft('2026-11-06', { title: '雨停之后', body: '下午四点雨停了。', tags: [' #日常 ', '日常'] })
      )
      await repo.flush()

      const raw = await readFile(path.join(dir, 'diary.vault'), 'utf8')
      expect(raw.includes('雨停之后')).toBe(false)
      expect(raw.includes('下午四点雨停了')).toBe(false)
      expect(JSON.parse(raw).magic).toBe('MINIDIARY')

      const snapshot2 = repo.getSnapshot()
      expect(snapshot2.entries[0]?.tags).toEqual(['日常'])
      expect(snapshot2.entries[0]?.wordCount).toBeGreaterThan(0)
      expect(snapshot2.entries[0]?.createdAt).toBe(snapshot2.entries[0]?.updatedAt)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('重新打开需要正确密码，条目与时间戳保持', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-06', { title: '标题', body: '正文' }))
      await repo.flush()
      const before = repo.getSnapshot().entries[0]

      const reopened = new VaultRepository({ dir, scrypt: FAST })
      await expect(reopened.unlock('wrong-password')).rejects.toMatchObject({
        code: 'WRONG_PASSWORD'
      })
      const snapshot = await reopened.unlock(PASSWORD)
      expect(snapshot.entries).toHaveLength(1)
      expect(snapshot.entries[0]?.title).toBe('标题')
      expect(snapshot.entries[0]?.createdAt).toBe(before?.createdAt)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('把内容清空会删除条目，而不是留下空条目', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-06', { title: '标题', body: '正文' }))
      const empty = await repo.saveEntry(draft('2026-11-06'))
      expect(empty.entry).toBeNull()
      expect(repo.getSnapshot().entries).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('未解锁时拒绝读写，也不暴露附件密钥', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      repo.lock()
      await expect(repo.saveEntry(draft('2026-11-06', { title: 'x' }))).rejects.toMatchObject({
        code: 'VAULT_LOCKED'
      })
      expect(() => repo.getAttachmentKey()).toThrowError(/解锁|锁定/)
      expect(() => repo.getSnapshot()).toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('upsertEntries 按固定规则合并同一天内容', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(
        draft('2026-11-06', { title: '旧标题', body: '旧正文', tags: ['旧'] })
      )
      const result = await repo.upsertEntries([
        { date: '2026-11-06', title: '新标题', body: '新正文', tags: ['新'], attachments: [] },
        { date: '2026-11-07', title: '另一天', body: '正文', tags: [], attachments: [] }
      ])
      expect(result).toMatchObject({ added: 1, merged: 1 })
      const merged = repo.getSnapshot().entries.find((entry) => entry.date === '2026-11-06')
      expect(merged?.title).toBe('旧标题 | 新标题')
      expect(merged?.body).toBe('旧正文\n\n---\n\n新正文')
      expect(merged?.tags.sort()).toEqual(['新', '旧'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('改密码后旧密码失效、新密码可用，条目不变', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-06', { title: '保留', body: '内容' }))
      await repo.changePassword(PASSWORD, 'brand-new-password')
      await expect(repo.changePassword('wrong', 'another-password')).rejects.toMatchObject({
        code: 'WRONG_PASSWORD'
      })

      repo.lock()
      await expect(repo.unlock(PASSWORD)).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
      const snapshot = await repo.unlock('brand-new-password')
      expect(snapshot.entries[0]?.title).toBe('保留')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('重置清空条目与附件，但保留密码', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-06', { title: '标题', body: '正文' }))
      const attachmentDir = vaultPaths(dir).attachmentsDir
      await mkdir(attachmentDir, { recursive: true })
      await writeFile(path.join(attachmentDir, 'orphan.mdat'), 'x')

      const snapshot = await repo.reset(PASSWORD)
      expect(snapshot.entries).toHaveLength(0)
      expect(await stat(path.join(dir, 'attachments'))).toBeTruthy()
      expect(await readFile(path.join(dir, 'diary.vault'), 'utf8')).not.toContain('标题')

      repo.lock()
      await repo.unlock(PASSWORD)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('整目录迁移后旧目录清空、新目录可解锁', async () => {
    const dir = await tempDir()
    const target = await tempDir('minidiary-moved-')
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-06', { title: '搬走', body: '内容' }))
      await repo.flush()

      const result = await repo.moveDirectory(target)
      expect(result.diaryDir).toBe(target)
      expect(repo.vaultDir).toBe(target)
      expect(await stat(path.join(target, 'diary.vault'))).toBeTruthy()
      expect(await stat(path.join(dir, 'diary.vault')).catch(() => null)).toBeNull()

      const moved = new VaultRepository({ dir: target, scrypt: FAST })
      const snapshot = await moved.unlock(PASSWORD)
      expect(snapshot.entries[0]?.title).toBe('搬走')
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('删除日记库会移除整个目录', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.deleteVault(PASSWORD)
      expect(await repo.statusOnDisk()).toBe('missing')
      expect(await stat(dir).catch(() => null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('拒绝用错误密码删除', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      await expect(repo.deleteVault('nope')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
      expect(await repo.statusOnDisk()).toBe('unlocked')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('findAttachment 只在当前库内查找', async () => {
    const dir = await tempDir()
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      const id = '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e'
      await repo.saveEntry(
        draft('2026-11-06', {
          title: '带附件',
          body: `![图](attachment://${id})`,
          attachments: [
            {
              id,
              name: '图.png',
              mime: 'image/png',
              kind: 'image',
              size: 10,
              sha256: 'a'.repeat(64),
              chunkSize: 1024,
              totalChunks: 1,
              createdAt: '2026-11-06T00:00:00.000Z'
            }
          ]
        })
      )
      expect(repo.findAttachment(id)?.attachment.name).toBe('图.png')
      expect(repo.findAttachment('00000000-0000-4000-8000-000000000000')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('setDir 会把仓库指向另一个目录', async () => {
    const dirA = await tempDir('minidiary-a-')
    const dirB = await tempDir('minidiary-b-')
    try {
      const repo = new VaultRepository({ dir: dirA, scrypt: FAST })
      await repo.create(PASSWORD)
      await repo.saveEntry(draft('2026-11-06', { title: 'A', body: 'x' }))
      await repo.flush()

      repo.setDir(dirB)
      expect(repo.isUnlocked).toBe(false)
      expect(await repo.statusOnDisk()).toBe('missing')
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
    }
  })
})
