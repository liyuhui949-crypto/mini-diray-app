import { mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

let target = ''

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: target }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [target] })
  }
}))

import { AttachmentStore } from '../../src/main/attachments/store'
import { exportAttachmentPackage, importAttachmentPackage } from '../../src/main/sync/attachmentPackage'
import { VaultRepository } from '../../src/main/vault/repository'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'diary-password-1234'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function tempDir(prefix = 'minidiary-inkatt-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

describe('.inkatt attachment package', () => {
  afterEach(() => {
    target = ''
  })

  it('导出后删除本地文件，再导入能补齐且校验通过', async () => {
    const dir = await tempDir()
    const pkg = path.join(dir, 'test.inkatt')
    try {
      const repo = new VaultRepository({ dir, scrypt: FAST })
      await repo.create(PASSWORD)
      const store = new AttachmentStore(dir, () => repo.getAttachmentKey())
      const attachment = await store.addFromBytes({
        name: 'pixel.png',
        mime: 'image/png',
        bytes: new Uint8Array(PNG)
      })
      await repo.saveEntry({
        date: '2026-11-09',
        title: '附件',
        body: `![pixel](attachment://${attachment.id})`,
        tags: [],
        attachments: [attachment]
      })

      target = pkg
      const exported = await exportAttachmentPackage(repo, path.join(dir, 'attachments'), null)
      expect(exported.count).toBe(1)
      expect((await stat(pkg)).size).toBeGreaterThan(0)

      const local = path.join(dir, 'attachments', `${attachment.id}.mdat`)
      await unlink(local)
      target = pkg
      const imported = await importAttachmentPackage(repo, path.join(dir, 'attachments'), null)
      expect(imported.imported).toBe(1)
      expect((await stat(local)).size).toBeGreaterThan(64)

      // 再导入一次：已存在且哈希一致，跳过
      target = pkg
      const again = await importAttachmentPackage(repo, path.join(dir, 'attachments'), null)
      expect(again.imported).toBe(0)
      expect(again.skipped).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
